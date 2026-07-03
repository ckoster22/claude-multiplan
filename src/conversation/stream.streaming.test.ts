// Token-by-token streaming — falsifiable, multi-turn tests (vitest + jsdom).
//
// Drives the REAL ConversationModel → renderTree() through the streaming wire (assistant_text_delta
// chunks + the terminal assistant_text commit), asserting the load-bearing behavior:
//   (a) a block's deltas grow ONE bubble in place; an intermediate render shows partial text; the
//       terminal commit finalizes the SAME single bubble to the authoritative full text.
//   (b) two sequential turns with DISTINCT session-unique block_uids render TWO distinct bubbles.
//   (c) FALSIFIABILITY GUARD (committed): two turns that (wrongly) reuse the SAME block_uid collapse
//       into ONE bubble — proving the session-unique block_uid is what prevents cross-turn collision.

import { describe, it, expect, beforeEach } from "vitest";
import { ConversationModel } from "./stream";
import { renderTree } from "./render";
import type {
  SystemInit,
  AssistantText,
  AssistantTextDelta,
  ResultMsg,
  QuotaExceeded,
} from "./types";

function sysInit(seq: number): SystemInit {
  return {
    seq,
    kind: "system_init",
    model: "claude",
    cwd: "/tmp",
    tools: [],
    skills: [],
    slash_commands: [],
    permission_mode: "acceptEdits",
    session_id: "s1",
  };
}

function delta(seq: number, blockUid: string, text: string, parent: string | null = null): AssistantTextDelta {
  return { seq, kind: "assistant_text_delta", text, block_uid: blockUid, parent_tool_use_id: parent };
}

function commit(seq: number, blockUid: string, text: string, parent: string | null = null): AssistantText {
  return { seq, kind: "assistant_text", text, block_uid: blockUid, parent_tool_use_id: parent };
}

function quota(seq: number): QuotaExceeded {
  return { seq, kind: "quota_exceeded", resetAt: 1, source: "rate_limit_event" };
}

function result(seq: number): ResultMsg {
  return {
    seq,
    kind: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
    session_id: "s1",
  };
}

function render(model: ConversationModel, container: HTMLElement): void {
  renderTree(container, model.derive());
}

function bubbleTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".conv-text")).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

describe("streaming — deltas grow one bubble, terminal commit finalizes it", () => {
  it("(a) a single streamed block: partial mid-stream, ONE bubble, final == terminal text", () => {
    const model = new ConversationModel();
    model.appendStream(sysInit(0));

    // First three chunks — render mid-stream.
    model.appendStream(delta(1, "0", "Here "));
    model.appendStream(delta(2, "0", "is "));
    model.appendStream(delta(3, "0", "a "));
    render(model, container);

    // INTERMEDIATE: exactly one bubble, PARTIAL text (the tail chunks haven't arrived yet).
    let texts = bubbleTexts(container);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Here is a");
    expect(texts[0]).not.toContain("streamed");

    // Capture the live bubble element — it must be REUSED (grown in place), not rebuilt, per delta.
    const liveEl = container.querySelector(".conv-text");
    expect(liveEl).not.toBeNull();

    // Remaining chunks + the authoritative terminal block.
    model.appendStream(delta(4, "0", "streamed "));
    model.appendStream(delta(5, "0", "answer."));
    render(model, container);
    // Still one bubble, still the SAME element (element reuse across deltas — no flash/rebuild).
    expect(bubbleTexts(container)).toHaveLength(1);
    expect(container.querySelector(".conv-text")).toBe(liveEl);

    model.appendStream(commit(6, "0", "Here is a streamed answer."));
    model.appendStream(result(7));
    render(model, container);

    // COMMITTED: exactly ONE bubble; the SAME element; text == the authoritative terminal block.
    texts = bubbleTexts(container);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("Here is a streamed answer.");
    expect(container.querySelector(".conv-text")).toBe(liveEl);
  });

  it("(a') the terminal block is authoritative over concatenated chunks", () => {
    // The concatenated deltas ("par tial") differ from the terminal text — the commit wins.
    const model = new ConversationModel();
    model.appendStream(sysInit(0));
    model.appendStream(delta(1, "0", "par "));
    model.appendStream(delta(2, "0", "tial"));
    model.appendStream(commit(3, "0", "The full corrected answer."));
    render(model, container);

    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("The full corrected answer.");
  });

  it("(b) two sequential turns with DISTINCT block_uids render TWO distinct bubbles", () => {
    const model = new ConversationModel();
    model.appendStream(sysInit(0));

    // Turn 1 — block_uid "0".
    model.appendStream(delta(1, "0", "First "));
    model.appendStream(delta(2, "0", "turn."));
    model.appendStream(commit(3, "0", "First turn."));
    model.appendStream(result(4));

    // Turn 2 — block_uid "1" (session-unique; the SDK's per-turn content index would reset to 0).
    model.appendStream(delta(5, "1", "Second "));
    model.appendStream(delta(6, "1", "turn."));
    model.appendStream(commit(7, "1", "Second turn."));
    model.appendStream(result(8));

    render(model, container);

    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("First turn.");
    expect(texts[1]).toBe("Second turn.");
  });

  it("(d) a terminal block_uid with NO preceding deltas finalizes as ONE committed bubble", () => {
    // The finalize-miss branch: `assistant_text` carries a block_uid but liveTextByUid has no live
    // node for it (the deltas were dropped, or the block streamed none). It must emit exactly ONE
    // committed bubble carrying the terminal text — not zero, not a lingering live node.
    // FALSIFY: drop the fresh-node emit in that branch → zero bubbles → RED.
    const model = new ConversationModel();
    model.appendStream(sysInit(0));
    model.appendStream(commit(1, "0", "No deltas preceded me."));
    model.appendStream(result(2));
    render(model, container);

    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe("No deltas preceded me.");
  });

  it("(e) interleaved root + subagent index-0 blocks → two bubbles, subagent NESTED", () => {
    // Fan-out: the fixed normalizer mints distinct AGENT-SCOPED uids — "0" for the root stream, "1"
    // for subagent T1 — even though both open a text block at SDK index 0. Here we feed the exact
    // delta/terminal frames that normalizer produces, INTERLEAVED, and assert the frontend correlates
    // each to its own single bubble: the root bubble at the top level, T1's bubble nested inside its
    // subagent group. (The falsifiable proof that the sidecar produces these distinct uids lives in
    // sidecar/normalize.test.ts; this pins the frontend correlation given them.)
    const model = new ConversationModel();
    model.appendStream(sysInit(0));
    model.appendStream(delta(1, "0", "Root ", null));
    model.appendStream(delta(2, "1", "Sub ", "T1"));
    model.appendStream(delta(3, "0", "text.", null));
    model.appendStream(delta(4, "1", "text.", "T1"));
    model.appendStream(commit(5, "0", "Root text.", null));
    model.appendStream(commit(6, "1", "Sub text.", "T1"));
    model.appendStream(result(7));
    render(model, container);

    // Two distinct bubbles, correct text each — NOT collapsed/cross-contaminated.
    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(2);
    expect(texts).toContain("Root text.");
    expect(texts).toContain("Sub text.");

    // The subagent block is nested inside its group; the root block is NOT.
    const nested = Array.from(container.querySelectorAll(".conv-subagent .conv-text")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    expect(nested).toEqual(["Sub text."]);
  });

  it("(f) FIX-2: a resume orphan does NOT cross-attach the new segment's block_uid \"0\"", () => {
    // A block streamed in segment 0 is interrupted (a delta, then a quota pause) BEFORE its terminal —
    // it leaves a live orphan node. On resume the sidecar restarts its block_uid counter at 0 AND its
    // wire seq at 0, so the new segment opens a block that ALSO carries uid "0" at seq 1. The reducer
    // keys its live-node map by (segment, block_uid), so the new segment's block is a SEPARATE node —
    // it must NOT grow the orphaned segment-0 node.
    // FALSIFY: key liveTextByUid by block_uid ALONE → the two collapse into ONE node carrying the new
    // segment's terminal text under segment 0 → this expects TWO bubbles → RED.
    const model = new ConversationModel();
    model.appendStream(sysInit(0));
    model.appendStream(delta(1, "0", "Interrupted seg0 ", null));
    model.appendStream(quota(2)); // pause — no terminal for the seg0 block

    // Resume: fresh sidecar → seq AND block_uid counter both reset to 0.
    model.appendStream(sysInit(0));
    model.appendStream(delta(1, "0", "Fresh ", null));
    model.appendStream(delta(2, "0", "answer.", null));
    model.appendStream(commit(3, "0", "Fresh answer."));
    model.appendStream(result(4));
    render(model, container);

    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(2);
    // The orphaned segment-0 partial survives as its own bubble (never overwritten by segment 1).
    expect(texts).toContain("Interrupted seg0");
    // The resumed segment-1 block finalized to its authoritative terminal text on its OWN bubble.
    expect(texts).toContain("Fresh answer.");
  });

  it("(c) FALSIFY: two turns REUSING the same block_uid collapse into ONE bubble", () => {
    // The buggy sidecar variant the plan warns about: emitting the SDK's per-turn content index
    // (which resets to 0 each turn) as block_uid would key both turns to the SAME slot. Here we feed
    // that degenerate stream directly; the two turns collide onto one bubble (the later text wins),
    // proving the session-unique block_uid in case (b) is load-bearing, not incidental.
    const model = new ConversationModel();
    model.appendStream(sysInit(0));

    model.appendStream(delta(1, "0", "First "));
    model.appendStream(commit(2, "0", "First turn."));
    model.appendStream(result(3));

    model.appendStream(delta(4, "0", "Second "));
    model.appendStream(commit(5, "0", "Second turn."));
    model.appendStream(result(6));

    render(model, container);

    const texts = bubbleTexts(container);
    expect(texts).toHaveLength(1); // collapsed — the cross-turn collision the unique uid prevents
    expect(texts[0]).toBe("Second turn.");
  });
});
