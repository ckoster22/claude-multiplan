// Review-bar STRAY PURE leaves — a DOM status-setter + a comments-text formatter.
//
// Side-effect-free at import time (only function declarations; no DOM-handle closure). `setHookStatus`
// takes its target element as a PARAMETER (it does NOT close over main.ts's module-level
// `hookStatusEl`), so it is a pure leaf. The stateful review bar (`refreshReviewBar`,
// `applyReviewBarState` from the existing pure `src/review.ts`) stays in main.ts — only these two
// leaves move. main.ts re-exports `setHookStatus` so its `./main` importers keep resolving unchanged;
// `echoCommentsText` was never in main's public export surface, so main imports it back directly.

import type { CommentRecord } from "./types";

// Build a STRUCTURED, human-readable echo of the plan-review comments the user submitted — one line
// per comment showing the anchor quote and the comment text. This is what the user SEES (their own
// words, attributed to them), NOT the wrapped buildFeedbackPrompt() output (that is the system text
// the agent receives). A whole-pane comment (no anchor quote) shows the comment alone. Empty input
// degrades to a bare "Requested changes" line so the bubble is never blank.
export function echoCommentsText(records: CommentRecord[]): string {
  if (records.length === 0) return "Requested changes.";
  const lines = records.map((rec) => {
    const quote = rec.quote.trim();
    const comment = rec.comment.trim();
    if (quote && comment) return `Re: "${quote}" — ${comment}`;
    if (quote) return `Re: "${quote}"`;
    return comment || "(comment)";
  });
  return lines.join("\n");
}

// Set the in-DOM hook status line. `kind` selects success (accent) vs error (red); empty text
// clears + hides it. EXPORTED so the status surface is directly unit-testable.
export function setHookStatus(
  statusEl: HTMLElement | null,
  text: string,
  kind: "success" | "error" = "success",
): void {
  if (!statusEl) return;
  if (!text) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    statusEl.classList.remove("error");
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle("error", kind === "error");
  statusEl.classList.remove("hidden");
}
