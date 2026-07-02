// Conversation domain — keyed DOM reconciliation invariants (jsdom, falsifiable).
//
// renderTree() reuses the DOM element for a node whose object identity is unchanged across derives
// (copy-on-write in stream.ts makes identity a faithful content-changed signal). These tests pin the
// observable consequences: unchanged rows keep their element identity, an incremental append touches
// only the new row, segment-qualified keys keep same-seq rows from different sessions distinct, the
// waiting-banner interval is armed once per element lifetime, a cleared banner's element is removed,
// and interactive cards are always rebuilt (never persist un-submitted form state).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// links.ts (reached transitively via render → markdown → links) imports openUrl at module load.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ConversationModel } from "./stream";
import { renderTree, teardownQuotaCountdown } from "./render";
import type { SystemInit, ToolPermissionRequested } from "./types";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  teardownQuotaCountdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Map every [data-seq] element currently in `host` by its seq (top-level + nested group children).
function seqElements(): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const el of host.querySelectorAll<HTMLElement>("[data-seq]")) {
    out.set(el.dataset.seq!, el);
  }
  return out;
}

describe("reconcile — unchanged rows keep element identity", () => {
  it("(a) rendering the same tree twice reuses EVERY [data-seq] element (identity-equal)", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "assistant_text", text: "hello", parent_tool_use_id: null });
    m.appendStream({ seq: 2, kind: "tool_use", id: "t1", tool: "Read", input: { file_path: "/a" }, parent_tool_use_id: null });
    m.appendStream({ seq: 3, kind: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, parent_tool_use_id: null });

    renderTree(host, m.derive());
    const first = seqElements();
    expect(first.size).toBe(2); // one .conv-text (seq 1), one .conv-tool (seq 2)

    renderTree(host, m.derive());
    const second = seqElements();

    // FALSIFY: restore container.replaceChildren() at the top of renderTree → every element is
    // rebuilt → the identity checks below go RED.
    expect(second.size).toBe(first.size);
    for (const [seq, el] of first) {
      expect(second.get(seq)).toBe(el);
    }
  });
});

describe("reconcile — incremental append touches only the new row", () => {
  it("(b) appending one event reuses all prior elements and adds exactly one new one", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "assistant_text", text: "first", parent_tool_use_id: null });
    m.appendStream({ seq: 2, kind: "tool_use", id: "t1", tool: "Read", input: { file_path: "/a" }, parent_tool_use_id: null });

    renderTree(host, m.derive());
    const before = seqElements();
    expect(before.size).toBe(2);

    m.appendStream({ seq: 3, kind: "assistant_text", text: "second", parent_tool_use_id: null });
    renderTree(host, m.derive());
    const after = seqElements();

    // Every prior element is the SAME object (reused, not rebuilt).
    for (const [seq, el] of before) {
      expect(after.get(seq)).toBe(el);
    }
    // Exactly one new row was added (the seq-3 bubble), and it is NOT one of the prior elements.
    expect(after.size).toBe(before.size + 1);
    const added = after.get("3")!;
    expect(added).toBeTruthy();
    expect(Array.from(before.values())).not.toContain(added);
  });
});

describe("reconcile — segment-qualified keys keep same-seq rows distinct", () => {
  function systemInit(seq: number, sessionId: string): SystemInit {
    return {
      seq,
      kind: "system_init",
      model: "m",
      cwd: "/tmp",
      tools: [],
      skills: [],
      slash_commands: [],
      permission_mode: "default",
      session_id: sessionId,
    };
  }

  it("(c) a two-segment tree (same wire seqs per segment) renders every row exactly once", () => {
    const m = new ConversationModel();
    // Segment 0.
    m.appendStream(systemInit(0, "s0"));
    m.appendStream({ seq: 1, kind: "assistant_text", text: "alpha", parent_tool_use_id: null });
    // Segment 1 — a resume RESETS the wire seq, so this text reuses seq 1.
    m.appendStream(systemInit(0, "s1"));
    m.appendStream({ seq: 1, kind: "assistant_text", text: "beta", parent_tool_use_id: null });

    const tree = m.derive();
    // Sanity: two text nodes at the same seq but different segments.
    expect(tree.nodes.filter((n) => n.type === "text")).toHaveLength(2);

    renderTree(host, tree);

    // FALSIFY: drop the segment qualifier from nodeKey (key becomes `${type}:${seq}`) → both texts
    // collide on "text:1" → the second overwrites the first → only ONE bubble survives → RED.
    const bubbles = host.querySelectorAll(".conv-text");
    expect(bubbles).toHaveLength(2);
    const texts = Array.from(bubbles).map((b) => b.textContent?.trim());
    expect(texts).toEqual(["alpha", "beta"]);
  });
});

describe("reconcile — waiting-banner interval is armed once per element lifetime", () => {
  it("(d) an unchanged waiting banner across two renders arms setInterval exactly once", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");

    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt: Date.now() + 3_600_000, remaining: 1, source: "s" });

    renderTree(host, m.derive(), { onCancelSession: () => {} });
    renderTree(host, m.derive(), { onCancelSession: () => {} });

    // FALSIFY: re-arm the interval on every frame (per-frame teardown + re-arm) → setSpy called twice → RED.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".conv-quota-banner")).toBeTruthy();
  });

  it("(e) a cleared banner's element is removed from the DOM", () => {
    const m = new ConversationModel();
    m.appendQuotaBanner({ state: "waiting", resetAt: Date.now() + 3_600_000, remaining: 1, source: "s" });
    renderTree(host, m.derive(), { onCancelSession: () => {} });
    expect(host.querySelector(".conv-quota-banner")).toBeTruthy();

    m.clearQuotaBanner();
    renderTree(host, m.derive(), { onCancelSession: () => {} });
    // The banner node vanished from the tree → its element (a now-stale key) is removed.
    expect(host.querySelector(".conv-quota-banner")).toBeNull();
  });
});

describe("reconcile — interactive cards are always rebuilt", () => {
  function askEvent(): ToolPermissionRequested {
    return {
      seq: 1,
      kind: "tool_permission_requested",
      id: "tool-1",
      tool: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick a color",
            header: "Color",
            options: [{ label: "Red" }, { label: "Blue" }],
            multiSelect: false,
          },
        ],
      },
      agent_id: null,
    };
  }

  it("(f) rendering the same model twice does NOT reuse the question card element (fresh card)", () => {
    const m = new ConversationModel();
    m.appendPermissionRequest(askEvent());

    renderTree(host, m.derive());
    const card1 = host.querySelector(".conv-question");
    expect(card1).toBeTruthy();

    renderTree(host, m.derive());
    const card2 = host.querySelector(".conv-question");
    expect(card2).toBeTruthy();

    // FALSIFY: treat question_request as reusable (drop it from isInteractiveNode) → the === node
    // reuses the element → card1 === card2 → RED. A fresh card is required so un-submitted form state
    // (checked radios / draft text) never persists across rerenders.
    expect(card2).not.toBe(card1);
  });
});

describe("reconcile — consecutive user echoes each render their own bubble", () => {
  it("(g) two back-to-back user echoes with no intervening wire frame render TWO .conv-text-user bubbles", () => {
    const m = new ConversationModel();
    m.appendStream({ seq: 1, kind: "assistant_text", text: "agent turn", parent_tool_use_id: null });
    // The composer stays typable while the agent is active and its next frame lags, so the user sends
    // two messages before any wire frame arrives.
    m.appendUserMessage("first message");
    m.appendUserMessage("second message");

    renderTree(host, m.derive());

    // FALSIFY: revert appendUserMessage to a fixed `lastWireSeq + 0.5` → both echoes share the nodeKey
    // `${segment}:user:1.5` → the keyed renderer maps them to one element and the first bubble is
    // dropped → only 1 → RED. This is the direct regression pin.
    const userBubbles = host.querySelectorAll(".conv-text-user");
    expect(userBubbles).toHaveLength(2);
    const texts = Array.from(userBubbles).map((b) => b.textContent?.trim());
    expect(texts).toEqual(["first message", "second message"]);
  });
});
