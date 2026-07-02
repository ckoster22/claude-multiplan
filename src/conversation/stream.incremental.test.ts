// Conversation domain — INCREMENTAL-equals-fresh equivalence battery.
//
// The pure model (stream.ts) is being made incremental: derive() must amortize to O(new events)
// per call WITHOUT changing observable behavior. This file is the falsifiable safety net that pins
// that "no observable change" claim: for each adversarial event sequence, a model fed the events
// ONE AT A TIME with a derive() between every append MUST produce output byte-identical to a fresh
// model fed all events at once and derived a single time.
//
// FALSIFIABILITY: against the current full-replay derive() every case passes trivially (a full
// replay is order-insensitive). The battery's teeth show once derive() retains state across calls —
// any fast-path/copy-on-write step that diverges from a from-scratch rebuild turns one of these RED.
// The identity-stability half of the contract (object `===` reuse) lives in the second describe
// block, added alongside the copy-on-write work.

import { describe, it, expect } from "vitest";
import { ConversationModel, WAITING_INPUT_LABEL, nodeKey } from "./stream";
import type {
  SystemInit,
  AssistantText,
  ToolUse,
  ToolResult,
  ModeChange,
  ResultMsg,
  PermissionDenied,
  ToolPermissionRequested,
  SubagentStarted,
  StatusMsg,
} from "./types";

function sysInit(over: Partial<SystemInit> = {}): SystemInit {
  return {
    seq: 0,
    kind: "system_init",
    model: "claude",
    cwd: "/tmp",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: "s1",
    ...over,
  };
}

function text(seq: number, t: string, parent: string | null = null): AssistantText {
  return { seq, kind: "assistant_text", text: t, parent_tool_use_id: parent };
}

function toolUse(seq: number, id: string, tool: string, parent: string | null = null): ToolUse {
  return { seq, kind: "tool_use", id, tool, input: { path: "x" }, parent_tool_use_id: parent };
}

function toolResult(
  seq: number,
  toolUseId: string,
  content: unknown,
  isError = false,
  parent: string | null = null,
): ToolResult {
  return {
    seq,
    kind: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    parent_tool_use_id: parent,
  };
}

function modeChange(seq: number, mode: string): ModeChange {
  return { seq, kind: "mode_change", mode };
}

function result(seq: number, isError = false): ResultMsg {
  return {
    seq,
    kind: "result",
    subtype: "success",
    is_error: isError,
    result: "ok",
    num_turns: 1,
    duration_ms: 10,
    total_cost_usd: 0.01,
    session_id: "s1",
  };
}

function denied(seq: number, tool: string, toolUseId: string): PermissionDenied {
  return {
    seq,
    kind: "permission_denied",
    tool,
    tool_use_id: toolUseId,
    agent_id: null,
    decision_reason_type: "deny_rule",
    message: "denied by rule",
  };
}

function permReq(
  seq: number,
  id: string,
  tool: string,
  input: unknown = {},
  agentId: string | null = null,
): ToolPermissionRequested {
  return { seq, kind: "tool_permission_requested", id, tool, input, agent_id: agentId };
}

function statusMsg(seq: number, label: string): StatusMsg {
  return { seq, kind: "status", label };
}

function subagentStarted(
  seq: number,
  toolUseId: string,
  subagentType: string | null = "Explore",
  description: string | null = "Explore the tree",
  prompt: string | null = "list files",
): SubagentStarted {
  return {
    seq,
    kind: "subagent_started",
    tool_use_id: toolUseId,
    subagent_type: subagentType,
    description,
    prompt,
  };
}

// The controller's synthetic-seq base (index.ts `synthSeq = 1_000_000_000`) for exit/error/notice/
// question_answered/permission_resolved. Kept in sync with that source so cross-segment ordering in
// these cases matches production exactly.
const SYNTH = 1_000_000_000;

// One operation on a model — an append (or an append bundled with the in-place frame mutation the
// controller performs before the first derive, e.g. deliberateInterrupt tagging).
type Op = (m: ConversationModel) => void;

// The CORE equivalence assertion. `incremental` derives between EVERY append (the live path — the
// controller re-renders per frame); `fresh` applies all ops then derives once (the reference). Their
// FINAL derived output must be byte-identical across nodes + every scalar field.
function assertIncrementalEqualsFresh(ops: Op[]): void {
  const fresh = new ConversationModel();
  for (const op of ops) op(fresh);
  const freshTree = fresh.derive();

  const incr = new ConversationModel();
  for (const op of ops) {
    op(incr);
    incr.derive(); // force a derive between every append — the crux of the equivalence claim
  }
  const incrTree = incr.derive();

  expect(JSON.stringify(incrTree.nodes)).toBe(JSON.stringify(freshTree.nodes));
  expect(incrTree.permissionMode).toBe(freshTree.permissionMode);
  expect(incrTree.complete).toBe(freshTree.complete);
  expect(JSON.stringify(incrTree.working)).toBe(JSON.stringify(freshTree.working));
}

describe("ConversationModel — incremental derive equals a from-scratch replay (adversarial sequences)", () => {
  it("out-of-order: tool_result arrives BEFORE its tool_use, then a normal in-order pair", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(toolResult(2, "t1", "early result")),
      (m) => m.appendStream(toolUse(1, "t1", "Read")),
      (m) => m.appendStream(toolUse(3, "t2", "Bash")),
      (m) => m.appendStream(toolResult(4, "t2", "later result", true)),
    ]);
  });

  it("mismatched ids: an orphan tool_result (no matching tool_use) is dropped, tool stays running", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(toolUse(1, "t1", "Read")),
      (m) => m.appendStream(toolResult(2, "DIFFERENT", "orphan")),
      (m) => m.appendStream(text(3, "more")),
    ]);
  });

  it("resume with wire-seq reset (two system_inits) + cross-segment demotion scoping", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(toolUse(1, "t1", "Read")), // segment 0 tool, abandoned
      (m) => m.appendExit({ code: 0 }, SYNTH),
      (m) => m.appendStream(sysInit({ seq: 0 })), // RESUME — fresh sidecar, wire seq reset → segment 1
      (m) => m.appendStream(toolUse(1, "t2", "Bash")), // segment-1 tool, genuinely running
      (m) => m.appendStream(toolResult(2, "t2", "done seg1")),
    ]);
  });

  it("late subagent_started: children arrive first, the labeling frame lands AFTER them", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(toolUse(1, "child-a", "Grep", "agent-X")),
      (m) => m.appendStream(text(2, "sub thinking", "agent-X")),
      (m) => m.appendStream(toolUse(3, "child-b", "Glob", "agent-X")),
      (m) => m.appendStream(subagentStarted(4, "agent-X", "general-purpose", "Do the thing", null)),
    ]);
  });

  it("user echo + quota banner at COLLIDING fractional seqs (both lastWireSeq + 0.5)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(text(5, "assistant")),
      (m) => m.appendUserMessage("please continue"), // seq 5.5
      (m) => m.appendQuotaBanner({ state: "waiting", resetAt: 1_800_000_000_000, remaining: 1, source: "rate_limit_event" }), // also 5.5
    ]);
  });

  it("quota banner lifecycle: waiting → exhausted (in-place update) → cleared (tombstone, no node)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(text(1, "before pause")),
      (m) => m.appendQuotaBanner({ state: "waiting", resetAt: 1_700_000_000_000, remaining: 1, source: "rate_limit_event" }),
      (m) => m.updateQuotaBanner({ state: "exhausted", resetAt: 1_700_000_100_000, remaining: 0, source: "thrown_error" }),
      (m) => m.clearQuotaBanner(),
    ]);
  });

  it("quota banner ends WAITING (a node survives, not cleared)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(text(1, "before pause")),
      (m) => m.appendQuotaBanner({ state: "waiting", resetAt: 1_700_000_000_000, remaining: 2, source: "rate_limit_event" }),
    ]);
  });

  it("frames AFTER a terminal result: more tool_use/text land past the result (multi-turn session)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(toolUse(1, "t1", "Read")),
      (m) => m.appendStream(toolResult(2, "t1", "ok")),
      (m) => m.appendStream(result(3)),
      (m) => m.appendStream(text(4, "next turn begins")),
      (m) => m.appendStream(toolUse(5, "t2", "Bash")), // legitimately running — NOT demoted
    ]);
  });

  it("question_answered arrives AFTER its question_request (normal fold)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 1 })),
      (m) => m.appendPermissionRequest(permReq(2, "q1", "AskUserQuestion", {
        questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
      })),
      (m) => m.appendQuestionAnswered("q1", { "Which?": "A" }, SYNTH),
    ]);
  });

  it("question_answered arrives BEFORE its question_request (out-of-order fold onto a later node)", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 1 })),
      (m) => m.appendQuestionAnswered("q1", { "Which?": "B" }, SYNTH), // answer first — inert until the request lands
      (m) => m.appendPermissionRequest(permReq(2, "q1", "AskUserQuestion", {
        questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
      })),
    ]);
  });

  it("non-terminal synthetics (permission_resolved, question_answered, notice) followed by MORE wire frames", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 1 })),
      (m) => m.appendPermissionRequest(permReq(2, "p1", "ExitPlanMode")),
      (m) => m.appendPermissionResolved("p1", SYNTH),
      (m) => m.appendNotice("a note", SYNTH + 1),
      (m) => m.appendStream(text(3, "turn resumes")), // WIRE frame after the synthetics — fast path must re-engage
      (m) => m.appendStream(toolUse(4, "t9", "Read")),
      (m) => m.appendStream(toolResult(5, "t9", "ok")),
    ]);
  });

  it("deliberateInterrupt tagging: the controller mutates the stored result frame BEFORE the first derive", () => {
    // Mirrors index.ts: appendStream(result) then mutate e.payload.deliberateInterrupt on the SAME
    // reference, BEFORE rerender()→derive(). Both fresh and incremental see the mutation bundled with
    // the append, so the terminal replay re-reads the tagged verdict.
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(toolUse(1, "t1", "Bash")),
      (m) => {
        const r = result(2, true);
        m.appendStream(r);
        r.deliberateInterrupt = true;
      },
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(text(1, "resumed work")),
    ]);
  });

  it("dense mixed stream: modes, denials, subagents, user echoes, errors interleaved", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(statusMsg(1, "thinking…")),
      (m) => m.appendStream(modeChange(2, "acceptEdits")),
      (m) => m.appendStream(toolUse(3, "t1", "Read")),
      (m) => m.appendStream(denied(4, "Bash", "t9")),
      (m) => m.appendStream(toolUse(5, "sub-1", "Grep", "agent-Y")),
      (m) => m.appendStream(toolResult(6, "t1", "contents")),
      (m) => m.appendUserMessage("a mid-stream message"),
      (m) => m.appendStream(subagentStarted(7, "agent-Y")),
      (m) => m.appendError({ kind: "io", message: "blip", fatal: false }, SYNTH),
      (m) => m.appendStream(text(8, "wrapping up")),
      (m) => m.appendStream(result(9)),
    ]);
  });

  it("whitespace-only assistant_text (dropped) interleaved with real text + a blank subagent child", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(text(1, "   \n  ")),
      (m) => m.appendStream(text(2, "real")),
      (m) => m.appendStream(text(3, "  ", "agent-Z")), // blank child — must NOT seed a group
      (m) => m.appendStream(toolUse(4, "c1", "Read", "agent-Z")),
    ]);
  });

  it("system_message + user_message replay echoes ordered by explicit file-position seqs", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendUserMessageAt("user turn 1", 0),
      (m) => m.appendSystemMessageAt("<system-reminder>plumbing</system-reminder>", 1),
      (m) => m.appendStream(text(2, "assistant reply")),
      (m) => m.appendUserMessageAt("user turn 2", 3),
    ]);
  });

  it("reset() mid-stream clears everything; a fresh stream after reset derives clean", () => {
    assertIncrementalEqualsFresh([
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(toolUse(1, "t1", "Read")),
      (m) => m.reset(),
      (m) => m.appendStream(sysInit({ seq: 0 })),
      (m) => m.appendStream(text(1, "post-reset")),
    ]);
  });
});

// The identity contract the renderer relies on: a node object is `===`-stable across derives IFF its
// content is unchanged. These pin snapshot isolation (a held tree never mutates under the caller) and
// that the fast path stays engaged for synthetics and reuses objects across a fallback replay.
describe("ConversationModel — node object identity is stable iff content is unchanged", () => {
  it("(a) a correlating tool_result yields a NEW node; a tree held from before still shows 'running'", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 0 }));
    m.appendStream(toolUse(1, "t1", "Read"));
    const before = m.derive();
    const toolBefore = before.nodes.find((n) => n.type === "tool")!;
    expect(toolBefore.type === "tool" && toolBefore.status).toBe("running");

    m.appendStream(toolResult(2, "t1", "contents"));
    const after = m.derive();
    const toolAfter = after.nodes.find((n) => n.type === "tool")!;

    // The post-correlation node is a fresh object in the "done" state...
    expect(toolAfter.type === "tool" && toolAfter.status).toBe("done");
    expect(toolAfter).not.toBe(toolBefore);
    // ...and the tree held from BEFORE is untouched. FALSIFY: revert correlation to in-place mutation
    // (Task 3 style) → toolBefore.status flips to "done" → RED.
    expect(toolBefore.type === "tool" && toolBefore.status).toBe("running");
    expect(before.nodes.find((n) => n.type === "tool")).toBe(toolBefore);
  });

  it("(b) appending one unrelated top-level event leaves every PRIOR TopNode ===-stable", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 0 }));
    m.appendStream(text(1, "a"));
    m.appendStream(toolUse(2, "t1", "Read"));
    const first = m.derive();
    const priorText = first.nodes.find((n) => n.type === "text")!;
    const priorTool = first.nodes.find((n) => n.type === "tool")!;

    m.appendStream(text(3, "b"));
    const second = m.derive();

    // Every prior node keeps its exact object identity across the derive. FALSIFY: rebuild fresh
    // objects every derive (no retained accumulator) → these `toBe`s go RED.
    expect(second.nodes.find((n) => n.type === "text" && n.text === "a")).toBe(priorText);
    expect(second.nodes.find((n) => n.type === "tool")).toBe(priorTool);
    expect(second.nodes.find((n) => n.type === "text" && n.text === "b")).not.toBe(priorText);
  });

  it("(c) a synthetic permission_resolved applies on the fast path — clears the hold, no node churn", () => {
    // NOTE on the maxProcessedSeq gate: whether a synthetic RAISES the wire-seq gate (a latent perf
    // regression — later wire frames would needlessly fall back) is NOT observable via node identity,
    // because a fallback reconciles identity too. So this test pins the two identity-observable
    // properties instead: the synthetic's EFFECT is applied incrementally, and it churns no prior node.
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(text(2, "a"));
    m.appendPermissionRequest(permReq(3, "p1", "ExitPlanMode"));
    const first = m.derive();
    expect(first.working).toEqual({ label: WAITING_INPUT_LABEL });
    const priorText = first.nodes.find((n) => n.type === "text")!;

    m.appendPermissionResolved("p1", SYNTH);
    const second = m.derive();

    // The synthetic took effect on the fast path (the hold cleared). FALSIFY: drop the
    // permission_resolved handling → the waiting label sticks → RED.
    expect(second.working).not.toEqual({ label: WAITING_INPUT_LABEL });
    // ...and it did not churn the prior node's identity. FALSIFY: fresh-objects-per-derive → RED.
    expect(second.nodes.find((n) => n.type === "text" && n.text === "a")).toBe(priorText);
  });

  it("(d) after a terminal-triggered fallback replay, content-unchanged nodes keep their identity", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 0 }));
    m.appendStream(text(1, "a"));
    m.appendStream(toolUse(2, "t1", "Read"));
    m.appendStream(toolResult(3, "t1", "ok"));
    const first = m.derive();
    const priorText = first.nodes.find((n) => n.type === "text")!;
    const priorTool = first.nodes.find((n) => n.type === "tool")!; // already "done" — result won't change it

    m.appendStream(result(4)); // terminal → forces a full replayAll
    const second = m.derive();

    // The unchanged nodes are reused by object identity across the replay; only the new result node is
    // fresh. FALSIFY: make replayAll return all-fresh objects (drop reconcileIdentity) → RED.
    expect(second.nodes.find((n) => n.type === "text" && n.text === "a")).toBe(priorText);
    expect(second.nodes.find((n) => n.type === "tool")).toBe(priorTool);
    expect(second.nodes.some((n) => n.type === "result")).toBe(true);
  });

  it("(e) two no-append derives return identity-equal nodes in a FRESH array", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 1 }));
    m.appendStream(text(2, "a"));
    m.appendStream(toolUse(3, "t1", "Read"));
    const a = m.derive();
    const b = m.derive();

    // A fresh array wrapper each call (callers hold + mutate tree.nodes/working)...
    expect(b.nodes).not.toBe(a.nodes);
    // ...but the node objects inside are identical. FALSIFY: replay + all-fresh objects on every derive
    // → the element `toBe`s go RED.
    expect(b.nodes.length).toBe(a.nodes.length);
    for (let i = 0; i < a.nodes.length; i++) {
      expect(b.nodes[i]).toBe(a.nodes[i]);
    }
  });
});

// The segment stamp + the exported nodeKey the renderer will use for DOM reuse. A resume resets the
// wire seq, so two same-type nodes at the same seq must be distinguishable by segment.
describe("ConversationModel — segment stamp on nodes + segment-qualified nodeKey", () => {
  it("stamps segment 0 before a resume and segment 1 after, and nodeKey keeps same-seq nodes distinct", () => {
    const m = new ConversationModel();
    m.appendStream(sysInit({ seq: 0 }));
    m.appendStream(text(5, "a"));
    m.appendExit({ code: 0 }, SYNTH);
    m.appendStream(sysInit({ seq: 0 })); // RESUME — fresh system_init → segment 1, wire seq reset
    m.appendStream(text(5, "a"));

    const nodes = m.derive().nodes;
    const texts = nodes.filter((n) => n.type === "text");
    expect(texts).toHaveLength(2);

    // Each text carries its arrival-order segment. FALSIFY: don't stamp segment → both undefined → RED.
    expect(texts.map((t) => t.segment).sort()).toEqual([0, 1]);

    // The two byte-equal-except-segment nodes get DISTINCT keys. FALSIFY: drop the segment qualifier
    // from nodeKey's (type, seq) branch → the keys collide → Set size 1 → RED (and the renderer would
    // mis-slot one element onto the other across the resume boundary).
    const keys = texts.map((t) => nodeKey(t));
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain("0:text:5");
    expect(keys).toContain("1:text:5");

    // An id-keyed node ignores segment (ids are globally unique) — pin the two key families.
    m.reset();
    m.appendStream(toolUse(1, "t1", "Read"));
    const tool = m.derive().nodes.find((n) => n.type === "tool")!;
    expect(nodeKey(tool)).toBe("tool:t1");
  });
});

// Two live user echoes with NO intervening wire frame must not share a seq (and thus a nodeKey) — the
// keyed renderer would otherwise map both to one element and drop the first bubble.
describe("ConversationModel — consecutive user echoes get distinct, ordered keys", () => {
  it("two back-to-back appendUserMessage produce DISTINCT nodeKeys and a stable order across derives", () => {
    const m = new ConversationModel();
    m.appendStream(text(1, "agent turn"));
    m.appendUserMessage("first"); // seq 1.5
    m.appendUserMessage("second"); // seq 1.75 (no wire frame advanced lastWireSeq between them)

    const first = m.derive();
    const users = first.nodes.filter((n) => n.type === "user");
    expect(users.map((u) => (u.type === "user" ? u.text : ""))).toEqual(["first", "second"]);

    // Distinct keys. FALSIFY: revert appendUserMessage to a fixed `lastWireSeq + 0.5` → both echoes
    // key to the same `${segment}:user:1.5` → Set size 1 → RED.
    const keys = users.map((u) => nodeKey(u));
    expect(new Set(keys).size).toBe(2);

    expect(users[0].seq).toBe(1.5);
    expect(users[1].seq).toBeGreaterThan(1.5);
    expect(users[1].seq).toBeLessThan(2); // strictly before the next wire frame's slot
    const second = m.derive();
    const users2 = second.nodes.filter((n) => n.type === "user");
    expect(users2.map((u) => (u.type === "user" ? u.text : ""))).toEqual(["first", "second"]);
    expect(users2[0]).toBe(users[0]);
    expect(users2[1]).toBe(users[1]);
  });
});
