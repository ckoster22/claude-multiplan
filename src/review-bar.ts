import { invoke } from "@tauri-apps/api/core";
import {
  initial,
  success,
  failure,
  matchScalar,
  unwrapOr,
  type ScalarRemoteData,
} from "./remote-data";
import { openPath, currentReviewId, pendingReviews } from "./app-state";
import { renderInto, settle } from "./render";
// The ToC DOM-writer is imported from ./render/toc DIRECTLY (not the ./render facade): unit tests
// mock the whole ./render facade, so routing it through there would resolve to an undefined mock.
import { rebuildTocFromPane } from "./render/toc";
import { getHomePath, collapseHome } from "./cwd";
import { composePreviewMarkdown } from "./prototype";
import { RenderGuard } from "./render-guard";
import type { PrototypeGate } from "./conversation/orchestrator";
import type { AbsPath, CommentRecord } from "./types";

// ---- init-injection seam ----------------------------------------------------------------------
// The main-resident sources the moved review-bar logic reaches through, supplied once by `main` via
// `initReviewBar`. Default to no-op closures so a unit test that never calls initReviewBar still gets
// well-defined behavior (behavior-identical to today's `!reviewBarEl` early-return before DOM wiring).
let getRefreshReviewBar: (countOverride?: number) => void = () => {};
let getRefreshAffordances: () => void = () => {};
let getRenderGuard: () => RenderGuard = () => new RenderGuard();
let getReadingPaneEl: () => HTMLElement | null = () => null;
let getDocHeaderEl: () => HTMLElement | null = () => null;
let getDocFilenameEl: () => HTMLElement | null = () => null;
let getDocSrcEl: () => HTMLElement | null = () => null;
let getReaderScrollEl: () => HTMLElement | null = () => null;

export interface ReviewBarDeps {
  refreshReviewBar: (countOverride?: number) => void;
  refreshAffordances: () => void;
  getRenderGuard: () => RenderGuard;
  getReadingPaneEl: () => HTMLElement | null;
  getDocHeaderEl: () => HTMLElement | null;
  getDocFilenameEl: () => HTMLElement | null;
  getDocSrcEl: () => HTMLElement | null;
  getReaderScrollEl: () => HTMLElement | null;
}

export function initReviewBar(deps: ReviewBarDeps): void {
  getRefreshReviewBar = deps.refreshReviewBar;
  getRefreshAffordances = deps.refreshAffordances;
  getRenderGuard = deps.getRenderGuard;
  getReadingPaneEl = deps.getReadingPaneEl;
  getDocHeaderEl = deps.getDocHeaderEl;
  getDocFilenameEl = deps.getDocFilenameEl;
  getDocSrcEl = deps.getDocSrcEl;
  getReaderScrollEl = deps.getReaderScrollEl;
}

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
// clears + hides it.
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

// ---- comment count (backend is the single source of truth) ----
// Held as a ScalarRemoteData<number>; only `initial()` and `success(n)` are ever stored
// (a failed read is a no-op preserving the last-good count). Consumers unwrap with a 0 fallback.
let commentCount: ScalarRemoteData<number> = initial();

// Latest-wins sequence counter for refreshCommentCount. Each call takes `seq = ++countReqSeq`
// before its await and bails if a newer call has begun (guards cross-plan A→B and bursty reorders).
let countReqSeq = 0;

// Commit-IF-CURRENT: apply an authoritative count synchronously. Used by onCommentCountChanged after
// an in-session save/clear (the facade already has the post-mutation count; no cold re-read needed).
// Foreign-plan callbacks (path ≠ openPath) are a total no-op — must not touch the count or bump
// countReqSeq (which would strand the open plan's own in-flight cold refresh).
export function applyCommentCount(path: AbsPath, count: number): void {
  if (path !== openPath()) return; // foreign-plan callback: ignore entirely (no commit, no seq bump).
  ++countReqSeq;
  commentCount = success(count);
  // Re-derive the bar so a pending review's VIEWING count is up to date.
  getRefreshReviewBar(count);
}

// Cold-read the open plan's comment count (used on OPEN/RELOAD). Latest-wins seq guard applies.
// After an in-session save/clear the count arrives via onCommentCountChanged → applyCommentCount
// instead (backend write may not be observed yet).
export async function refreshCommentCount(): Promise<void> {
  // Short-circuit: nothing open ⇒ count is known to be 0 (no await needed; no stale landing to guard).
  const op = openPath();
  if (op === null) {
    commentCount = success(0);
    getRefreshReviewBar(0);
    return;
  }
  const seq = ++countReqSeq;
  // Parse at the boundary: a resolved read is success(n) (never zeroResults); rejected is error(e).
  let result: ScalarRemoteData<number>;
  try {
    result = success(await invoke<number>("get_comment_count", { path: op }));
  } catch (e) {
    console.error("get_comment_count failed", e);
    result = failure(String(e));
  }
  // Stale landing — a newer refresh or authoritative applyCommentCount began. Drop it.
  if (seq !== countReqSeq) return;
  matchScalar<number, void>(result, {
    // Unreachable for a just-awaited read; required only for exhaustiveness.
    initial: () => {},
    fetching: () => {},
    success: (n) => {
      commentCount = success(n);
      // Re-derive the bar so a pending review's VIEWING count is right.
      getRefreshReviewBar(n);
    },
    // Read failed (already logged). Leave last-good count in place; skip bar re-derive.
    error: () => {},
  });
}

// Test-only: unwraps the comment count to a number (0 when unloaded/fetching/error).
export function currentCommentCount(): number {
  return unwrapOr(commentCount, 0);
}

// Test-only: the open plan's comment count.
export function reviewCommentCount(): number {
  return currentReviewId() === null ? 0 : unwrapOr(commentCount, 0);
}

// lifecycle cleanup. On agent-exit / fatal agent-error / user cancel, any in-process
// pending review describes a DEAD SDK seam: its held canUseTool promise is gone, so an Approve would
// resolve nothing (and must be impossible). Drop every in-process pending review (external reviews are
// untouched — they ride the independent file-IPC substrate) and refresh the bar. Returns the count
// purged.
export function purgeInprocReviews(): number {
  let purged = 0;
  for (const [id, r] of Array.from(pendingReviews.entries())) {
    if (r.source === "in-process") {
      pendingReviews.delete(id);
      purged++;
    }
  }
  // removing the last in-process review can UN-suppress the resume banner (a pending review
  // outranks resume). The agent-exit / agent-error-fatal callers rely on THIS refresh (they don't call
  // refreshAffordances themselves, unlike #conversation-cancel), so re-derive BOTH surfaces — else a
  // resumable open plan's Resume button stays stuck hidden after the seam dies.
  if (purged > 0) getRefreshAffordances();
  return purged;
}

// Render the held prototype's preview into the reading pane, DETACHED: composePreviewMarkdown's
// markdown goes through the normal renderInto/settle pipeline but openPath is NEVER touched — the
// preview is not a plan file, so the next openPlan naturally replaces it (its renderGuard
// generation supersedes ours). The filename header reads "prototype-preview"; gate.cwd is the
// render base dir (relative image/link resolution).
export async function renderPrototypePreview(gate: PrototypeGate): Promise<void> {
  const readingPaneEl = getReadingPaneEl();
  if (!readingPaneEl) return;
  const renderGuard = getRenderGuard();
  const docHeaderEl = getDocHeaderEl();
  const docFilenameEl = getDocFilenameEl();
  const docSrcEl = getDocSrcEl();
  const readerScrollEl = getReaderScrollEl();
  const gen = renderGuard.begin();
  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  if (docFilenameEl) docFilenameEl.textContent = "prototype-preview";
  if (docSrcEl) {
    const home = getHomePath();
    docSrcEl.textContent = home ? collapseHome(gate.cwd, home) : gate.cwd;
  }
  renderInto(readingPaneEl, composePreviewMarkdown(gate), gate.cwd);
  readerScrollEl?.scrollTo({ top: 0 });
  await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
  // settle() is async; a newer open/reload may have begun — bail so a late settle from this
  // superseded preview never touches the pane or the ToC (mirrors openPlan's guard discipline).
  if (!renderGuard.isCurrent(gen)) return;
  rebuildTocFromPane();
}
