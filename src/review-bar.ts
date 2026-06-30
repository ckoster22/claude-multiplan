// Review-bar PURE leaves — DOM status-setter + comments-text formatter.
// Side-effect-free at import time. `setHookStatus` takes its element as a parameter (no closure).
// main.ts re-exports `setHookStatus` so its `./main` importers keep resolving unchanged; `echoCommentsText` is imported back directly.

import type { CommentRecord } from "./types";

// Human-readable echo of submitted comments (what the user SEES), NOT the wrapped buildFeedbackPrompt() output
// (which the agent receives). Empty input degrades to "Requested changes." so the bubble is never blank.
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
