// Golden-replay integration tests — vitest + jsdom.
//
// Three falsifiable layers over src/mock/golden.ts (the sanctioned golden→mock bridge):
//   1. DEMUX UNIT: `demuxLine` routes exactly like the host seam it ports
//      (src-tauri/src/agent.rs parse_stream_line + normalize_error_payload) — one test per rule.
//   2. GOLDEN-DIFF GATE (bad-path, overloaded-exhausted): the demux is structure-preserving modulo
//      the DOCUMENTED error normalization. Every pass-through frame is parsed-JSON-equal to its
//      golden line (nothing dropped, nothing reordered, seq preserved); the terminal `error` line
//      maps to an agent-error frame equal to a HAND-WRITTEN normalized-expected shape (written from
//      the CONTRACT.md `agent-error` wire shape, NOT reverse-engineered from adapter output — so a
//      broken error_kind lift fails it; comparing to the RAW golden line would invert
//      falsifiability, a broken lift would move output CLOSER to the raw line and pass).
//   3. PER-CLASS RENDER: each emulated response class, replayed through the REAL ConversationModel
//      + renderTree into jsdom, yields its signature node (scenes.test.ts style) — a dropped or
//      mis-demuxed frame class goes RED. The interactive `tool-permission-requested` prompt is
//      asserted from the HAND-BUILT scene and labeled as the separate non-golden seam.
//
// The quota BANNER half of the quota class (controller + fake-orchestrator wiring) lives in
// quota-banner-wiring.test.ts, fed the golden-derived payload; here the pure model asserts the
// frame's deliberate inertness.

import { describe, it, expect, beforeEach } from "vitest";
import { ConversationModel } from "../conversation/stream";
import { renderTree } from "../conversation/render";
import { applySceneToModel } from "./player";
import {
  demuxLine,
  goldenLines,
  goldenFrames,
  goldenScene,
  GOLDEN_SCENES,
  GOLDEN_SCENE_NAMES,
} from "./golden";
import { SCENARIO_EXIT_CODES } from "../../sidecar/exit-codes";
import { SCENES, systemInitFrame, type SceneFrame } from "./fixtures/scenes";

function renderScene(frames: SceneFrame[]): HTMLElement {
  const model = new ConversationModel();
  applySceneToModel(model, frames);
  const container = document.createElement("div");
  document.body.appendChild(container);
  renderTree(container, model.derive());
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// The roster is DERIVED from the glob keys — never a hardcoded count. Its one invariant: the
// goldens on disk and the shared exit-code map cover exactly the same basenames (a golden without
// an exit code cannot synthesize agent-exit; an exit code without a golden is a stale entry).
describe("golden roster — glob-derived, in lockstep with SCENARIO_EXIT_CODES", () => {
  it("every golden has an exit code and every exit code has a golden", () => {
    expect(GOLDEN_SCENE_NAMES.length).toBeGreaterThan(0);
    expect(GOLDEN_SCENE_NAMES).toEqual(Object.keys(SCENARIO_EXIT_CODES).sort());
  });

  it("every golden scene replays through the real model + renderer without throwing", () => {
    for (const name of GOLDEN_SCENE_NAMES) {
      expect(() => renderScene(GOLDEN_SCENES[name]())).not.toThrow();
    }
  });
});

describe("demuxLine — the ported agent.rs routing rules", () => {
  it("kind 'error' WITH error_kind: lifts error_kind into the public kind and drops the field", () => {
    const frame = demuxLine('{"seq":1,"kind":"error","error_kind":"auth","message":"m","fatal":true}');
    expect(frame).toEqual({
      event: "agent-error",
      payload: { seq: 1, kind: "auth", message: "m", fatal: true },
    });
    expect(frame!.payload).not.toHaveProperty("error_kind");
  });

  it("kind 'error' WITHOUT error_kind: public kind defaults to 'sdk'", () => {
    const frame = demuxLine('{"seq":2,"kind":"error","message":"m","fatal":true}');
    expect(frame).toEqual({
      event: "agent-error",
      payload: { seq: 2, kind: "sdk", message: "m", fatal: true },
    });
  });

  it("kind 'tool_permission_requested' splits onto the tool-permission-requested channel, payload untouched", () => {
    const line = '{"seq":3,"kind":"tool_permission_requested","id":"p1","tool":"Write","input":{},"agent_id":null}';
    const frame = demuxLine(line);
    expect(frame!.event).toBe("tool-permission-requested");
    expect(frame!.payload).toEqual(JSON.parse(line));
  });

  it("any other kind passes through untouched onto agent-stream", () => {
    const line = '{"seq":4,"kind":"status","label":"thinking…"}';
    const frame = demuxLine(line);
    expect(frame!.event).toBe("agent-stream");
    expect(frame!.payload).toEqual(JSON.parse(line));
  });

  it("a non-JSON line becomes a synthetic non-fatal contamination agent-error carrying the raw line", () => {
    const frame = demuxLine("not json {");
    expect(frame!.event).toBe("agent-error");
    const payload = frame!.payload as { kind: string; message: string; fatal: boolean };
    expect(payload.kind).toBe("contamination");
    expect(payload.fatal).toBe(false);
    expect(payload.message).toContain("non-JSON line on sidecar stdout");
    expect(payload.message).toContain("not json {");
  });

  it("a whitespace-only line is skipped (null), never a frame", () => {
    expect(demuxLine("")).toBeNull();
    expect(demuxLine("   \n")).toBeNull();
  });
});

// The gate runs on a BAD-PATH scenario on purpose: a trivial-text diff would pass even if the
// out-of-band frames (status retries, the terminal error) were dropped; overloaded-exhausted
// exercises pass-through AND the error normalization in one stream.
describe("golden-diff gate — overloaded-exhausted, structure-preserving modulo error normalization", () => {
  const GATE = "overloaded-exhausted";

  // The indexes at which a frame's payload is NOT parsed-JSON-equal to its golden line (error
  // lines excluded — they are asserted against the normalized-expected shape instead). Factored so
  // the committed FALSIFY case below can prove the comparison actually detects corruption.
  function passThroughMismatches(lines: string[], frames: SceneFrame[]): number[] {
    const bad: number[] = [];
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as { kind?: string };
      if (parsed.kind === "error") return;
      const frame = frames[i];
      if (
        frame === undefined ||
        frame.event !== "agent-stream" ||
        JSON.stringify(frame.payload) !== JSON.stringify(parsed)
      ) {
        bad.push(i);
      }
    });
    return bad;
  }

  it("every pass-through frame is parsed-JSON-equal to its golden line — nothing dropped, nothing reordered, seq preserved", () => {
    const lines = goldenLines(GATE);
    const frames = goldenFrames(GATE);
    // Line-for-line: same frame count (nothing dropped, nothing invented)…
    expect(frames.length).toBe(lines.length);
    // …every non-error line byte-identical modulo JSON parsing, at the SAME index (no reorder)…
    expect(passThroughMismatches(lines, frames)).toEqual([]);
    // …and the seq column is carried through verbatim in order.
    const goldenSeqs = lines.map((l) => (JSON.parse(l) as { seq: number }).seq);
    const frameSeqs = frames.map((f) => (f.payload as { seq: number }).seq);
    expect(frameSeqs).toEqual(goldenSeqs);
  });

  it("the terminal error line maps to the HAND-WRITTEN normalized agent-error shape (contract, not adapter output)", () => {
    // Written from CONTRACT.md's public `agent-error` shape + the documented error_kind lift over
    // the golden's known terminal line — NOT copied from what demuxLine returns. A broken lift
    // (kind left "error", error_kind retained, fatal lost) fails this toEqual.
    const EXPECTED_NORMALIZED_ERROR = {
      seq: 6,
      kind: "sdk",
      message: "Anthropic API overloaded (HTTP 529); retried 6× over ~61 min, giving up.",
      fatal: true,
    };
    const frames = goldenFrames(GATE);
    const last = frames[frames.length - 1];
    expect(last.event).toBe("agent-error");
    expect(last.payload).toEqual(EXPECTED_NORMALIZED_ERROR);
  });

  it("goldenScene appends the synthesized agent-exit with the exhaustion exit code 1", () => {
    const frames = goldenScene(GATE);
    expect(frames[frames.length - 1]).toEqual({ event: "agent-exit", payload: { code: 1 } });
    // And exactly ONE frame more than the demux (only the exit is synthesized).
    expect(frames.length).toBe(goldenFrames(GATE).length + 1);
  });

  it("FALSIFY: corrupting one golden line in-memory is detected by the pass-through comparison", () => {
    const lines = goldenLines(GATE);
    const corrupted = [...lines];
    corrupted[0] = corrupted[0].replace('"seq":0', '"seq":99');
    expect(corrupted[0]).not.toBe(lines[0]); // the corruption actually landed
    // Demux the CORRUPTED stream, diff against the REAL golden lines: index 0 must be flagged.
    const frames = corrupted.map((l) => demuxLine(l)!).filter((f) => f !== null);
    expect(passThroughMismatches(lines, frames)).toEqual([0]);
  });
});

// One render assertion per emulated response class — each fails if its frame class is dropped or
// mis-rendered by the replay (the same signature-selector style as scenes.test.ts).
describe("golden scenes — per-class render through the real pipeline", () => {
  it("happy-text: exactly ONE bubble per block_uid, each bubble equal to its terminal block text", () => {
    const container = renderScene(GOLDEN_SCENES["happy-text"]());
    const texts = Array.from(container.querySelectorAll(".conv-text"));
    // The golden streams two blocks (block_uid 0 and 1) as a flood of assistant_text_delta tokens then
    // a terminal assistant_text per block. On screen that MUST be exactly two bubbles (one per block —
    // NOT one per token), each showing its full committed text. Falsifiable: scattering the deltas into
    // separate bubbles changes the count; dropping any delta/commit changes the text.
    expect(texts.length).toBe(2);
    expect(texts[0].textContent!.trim()).toBe("Here is the first part of my answer.");
    expect(texts[1].textContent!.trim()).toBe("And here is the conclusion.");
    const result = container.querySelector(".conv-result");
    expect(result).not.toBeNull();
    expect(result!.classList.contains("conv-result-error")).toBe(false);
  });

  it("assistant markdown renders to real elements (heading/list/code), never literal markdown text", () => {
    // Feed an assistant bubble markdown with a heading, a list, and a fenced code block. The reading
    // surface renders it through renderMarkdown → real <h1>/<li>/<code> elements — NOT escaped "#
    // Heading" text or a literal "\n". This is the structural assertion that catches a raw-JSON /
    // unrendered-markdown regression (a dumped tool input would leave the markers as visible text).
    const md = "# Heading\n\n- item\n\n```js\nconst x = 1;\n```\n";
    const frames: SceneFrame[] = [
      { event: "agent-stream", payload: systemInitFrame(0) },
      {
        event: "agent-stream",
        payload: { seq: 1, kind: "assistant_text", text: md, block_uid: "0", parent_tool_use_id: null },
      },
    ];
    const container = renderScene(frames);
    const bubble = container.querySelector(".conv-text")!;
    expect(bubble).not.toBeNull();
    expect(bubble.querySelector("h1")!.textContent).toBe("Heading");
    expect(bubble.querySelector("li")!.textContent).toBe("item");
    expect(bubble.querySelector("pre code")!.textContent).toContain("const x = 1;");
    // The raw markdown markers and the literal escaped newline never survive into the rendered text.
    expect(bubble.textContent).not.toContain("# Heading");
    expect(bubble.textContent).not.toContain("```");
    expect(bubble.textContent).not.toContain("\\n");
  });

  it("tool-call: a done tool row whose tool_use/tool_result id correlation survived the replay", () => {
    const container = renderScene(GOLDEN_SCENES["tool-call"]());
    const row = container.querySelector('.conv-tool[data-status="done"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector(".conv-tool-name")!.textContent).toBe("Bash");
    // The correlated result landed in the row body — only an id-matched tool_result can put it there.
    expect(row!.querySelector(".conv-tool-result")!.textContent).toContain("build succeeded");
  });

  it("FALSIFY: re-pointing the tool_result's tool_use_id breaks the correlation (no done row)", () => {
    const frames = GOLDEN_SCENES["tool-call"]().map((f) => {
      const p = f.payload as { kind?: string; tool_use_id?: string };
      if (f.event === "agent-stream" && p.kind === "tool_result") {
        return { ...f, payload: { ...p, tool_use_id: "someone-else" } };
      }
      return f;
    });
    const container = renderScene(frames);
    expect(container.querySelector('.conv-tool[data-status="done"]')).toBeNull();
  });

  it("plan-write: a Write tool row targeting ~/.claude/plans/", () => {
    const container = renderScene(GOLDEN_SCENES["plan-write"]());
    const row = container.querySelector('.conv-tool[data-status="done"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector(".conv-tool-name")!.textContent).toBe("Write");
    expect(row!.querySelector(".conv-tool-input")!.textContent).toContain("/.claude/plans/");
  });

  it("prototype-write: a Write tool row contained to .plan-tree/prototype/", () => {
    const container = renderScene(GOLDEN_SCENES["prototype-write"]());
    const row = container.querySelector('.conv-tool[data-status="done"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector(".conv-tool-input")!.textContent).toContain("/.plan-tree/prototype/");
  });

  it("review-cycle: the HYBRID scene shows the streamed text + the pending plan-approval marker, not a raw-JSON tool row", () => {
    // FIX 1: review-cycle is a hybrid — the golden's ExitPlanMode arrives as an already-approved
    // tool_use/tool_result round-trip (renders a generic tool row dumping JSON.stringify(input) with a
    // literal "\n"); the real UX is the PENDING review prompt, which a query()-seam golden cannot
    // capture. The hybrid keeps the streamed lead-up and injects a tool_permission_requested frame.
    const container = renderScene(GOLDEN_SCENES["review-cycle"]());
    // The streamed pre-plan text survived.
    const text = container.querySelector(".conv-text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain("I have a complete plan ready for your review.");
    // The pending ExitPlanMode review affordance — the real UX — is present…
    const marker = container.querySelector(".conv-perm-request");
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toBe("Plan ready — reviewing in the Plan tab");
    // …and there is NO generic completed tool row dumping the plan JSON with a literal "\n".
    expect(container.querySelector(".conv-tool")).toBeNull();
    expect(container.textContent).not.toContain("\\n");
    expect(container.textContent).not.toContain("# Plan under review");
  });

  it("subagent-fanout: a labeled subagent group whose nested child tool correlates inside it", () => {
    const container = renderScene(GOLDEN_SCENES["subagent-fanout"]());
    const group = container.querySelector(".conv-subagent");
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain("Investigate the renderer seam");
    // The child tool_use + its tool_result folded INTO the group (parent_tool_use_id grouping).
    const childTool = group!.querySelector('.conv-tool[data-status="done"]');
    expect(childTool).not.toBeNull();
    expect(childTool!.querySelector(".conv-tool-name")!.textContent).toBe("Grep");
  });

  it("permission-denied: the deny frame renders the .conv-perm-denied row with its message", () => {
    const container = renderScene(GOLDEN_SCENES["permission-denied"]());
    const row = container.querySelector(".conv-perm-denied");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("Write");
    expect(row!.textContent).toContain("outside the allowed prototype directory");
  });

  it("resume-fallback: the resume_fallback frame is inert in the reducer; the fresh run still renders", () => {
    // The controller (conversation/index.ts) surfaces the non-fatal notice; the pure reducer adds
    // no node for it — asserted here so a reducer regression (a spurious node / crash) goes RED.
    const container = renderScene(GOLDEN_SCENES["resume-fallback"]());
    expect(container.querySelectorAll(".conv-text").length).toBe(2);
    expect(container.querySelector(".conv-result")).not.toBeNull();
  });

  it("overloaded-retry: retry status frames add no timeline node; the recovered turn renders clean", () => {
    const container = renderScene(GOLDEN_SCENES["overloaded-retry"]());
    expect(container.querySelector(".conv-text")!.textContent).toContain("Recovered after backoff.");
    const result = container.querySelector(".conv-result");
    expect(result).not.toBeNull();
    expect(result!.classList.contains("conv-result-error")).toBe(false);
  });

  it("error-midstream: the is_error result renders the loud failure row", () => {
    const container = renderScene(GOLDEN_SCENES["error-midstream"]());
    expect(container.querySelector(".conv-result-error")).not.toBeNull();
  });

  it("overloaded-midturn: partial output survives; the synthetic not-retried result renders as failure", () => {
    const container = renderScene(GOLDEN_SCENES["overloaded-midturn"]());
    expect(container.querySelector(".conv-text")!.textContent).toContain("Partial answer");
    const result = container.querySelector(".conv-result-error");
    expect(result).not.toBeNull();
    expect(result!.textContent).toContain("after partial output; not retried");
  });

  it("overloaded-exhausted: the normalized terminal error renders .conv-error-fatal", () => {
    const container = renderScene(GOLDEN_SCENES["overloaded-exhausted"]());
    const err = container.querySelector(".conv-error-fatal");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("retried 6×");
  });

  it("auth-failure: the lifted error_kind 'auth' arrives fatal, rendered with a SINGLE Error prefix", () => {
    const container = renderScene(GOLDEN_SCENES["auth-failure"]());
    const err = container.querySelector(".conv-error-fatal");
    expect(err).not.toBeNull();
    // FIX 3: the golden's message begins with the sidecar's String(e) "Error:" prefix. The render layer
    // strips it so it reads ONCE — "Error (auth): 401…", not the doubled "Error (auth): Error: 401…".
    // Falsifiable: revert the strip in render.ts → the doubled prefix fails this exact-equality.
    expect(err!.textContent).toBe("Error (auth): 401 Unauthorized: OAuth token expired");
  });

  it("stream-abort: partial output survives, then the fatal transport error renders with a SINGLE Error prefix", () => {
    const container = renderScene(GOLDEN_SCENES["stream-abort"]());
    expect(container.querySelector(".conv-text")!.textContent).toContain("Working on it…");
    const err = container.querySelector(".conv-error-fatal");
    expect(err).not.toBeNull();
    expect(err!.textContent).toBe("Error (sdk): stream disconnected: ECONNRESET while reading the response body");
  });

  it("FALSIFY: dropping the golden's error line drops the fatal error row (stream-abort)", () => {
    const frames = GOLDEN_SCENES["stream-abort"]().filter((f) => f.event !== "agent-error");
    const container = renderScene(frames);
    expect(container.querySelector(".conv-error-fatal")).toBeNull();
  });
});

// quota_exceeded is deliberately INERT in the reducer (stream.ts): no timeline node, `complete`
// untouched, the session stays live — the waiting banner + auto-resume are owned by the
// orchestrator-observer wiring (asserted with the golden payload in quota-banner-wiring.test.ts).
describe("golden scenes — quota_exceeded ingests inertly through the pure model", () => {
  for (const name of ["quota-rate-limit", "quota-result", "thrown-quota"] as const) {
    it(`${name}: no crash, no spurious node, session stays live`, () => {
      const model = new ConversationModel();
      // goldenFrames (not goldenScene): the live-session claim is about the stream BEFORE the
      // process termination the adapter synthesizes.
      applySceneToModel(model, goldenFrames(name));
      const tree = model.derive();
      expect(tree.nodes).toHaveLength(0); // system_init + quota_exceeded add NO timeline node
      expect(tree.complete).toBe(false); // no result — the turn is paused, not over
      expect(tree.working).not.toBeNull(); // the session is still live
    });
  }

  it("the golden quota payload carries the pinned reset + source the banner wiring consumes", () => {
    const quota = goldenFrames("quota-rate-limit").find(
      (f) => (f.payload as { kind?: string }).kind === "quota_exceeded",
    );
    expect(quota).toBeDefined();
    expect(quota!.payload).toEqual({
      seq: 1,
      kind: "quota_exceeded",
      resetAt: 1_750_000_000_000,
      source: "rate_limit_event",
    });
  });
});

// THE SEPARATE, NON-GOLDEN SEAM: the interactive tool-permission-requested prompt is driven by the
// sidecar's canUseTool path, which the query()-seam emulator cannot produce — no golden exists. It
// stays covered by injecting the event directly (the hand-built scene), asserted here so this
// file's per-class coverage is complete across the response catalog.
describe("non-golden seam — injected tool-permission-requested prompt", () => {
  it("the injected AskUserQuestion permission frame renders the interactive question card", () => {
    const container = renderScene(SCENES.questionCard());
    expect(container.querySelector(".conv-question")).not.toBeNull();
  });

  it("the injected ExitPlanMode permission frame renders the review-pointer marker", () => {
    const container = renderScene(SCENES.exitPlanMode());
    expect(container.querySelector(".conv-perm-request")).not.toBeNull();
  });
});
