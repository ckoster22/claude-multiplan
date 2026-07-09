import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import {
  initComments,
  onCommentCountChanged,
  clearAllComments,
  type CommentsIO,
} from "./render";
import { buildFeedbackPrompt } from "./feedback";
import { applyReviewBarState } from "./review";
// The ToC DOM-writers are imported from ./render/toc DIRECTLY (not the ./render facade): unit tests
// mock the whole ./render facade, so routing these through it would resolve to undefined mocks.
import { initToc } from "./render/toc";
import {
  setHomePath,
  cwdByStem,
  attemptedStems,
  resolveAttemptCounts,
  displayCwd,
  planSrcText,
  cwdDisplayForStem,
  stemFromPath,
} from "./cwd";
import { resolveCwds } from "./resolve";
import {
  initial,
  fetching,
  failure,
  success,
  fromArray,
  match as foldRemoteData,
  matchScalar,
  unwrapOr,
  isInitial,
  isFetching,
  type RemoteData,
  type ScalarRemoteData,
} from "./remote-data";
import { RenderGuard } from "./render-guard";
import { initTitlebar, initThemeToggle, initTextSize } from "./titlebar";
import { badgeSignature, renderModelBar, renderModelChip } from "./model-bar";
import { initConversation, type ConversationHandle } from "./conversation";
import { createGateObserver } from "./conversation/gate";
import { diag } from "./conversation/diag";
import {
  isOrchestrationActive,
  getOrchestrator,
  pathKey,
  parsePathKey,
  approvalGateOf,
  type PlanTreeSnapshot2,
  type PrototypeGate,
  type AcceptanceGate,
} from "./conversation/orchestrator";
import {
  prototypeBarLabel,
  prototypeApproveLabel,
  prototypeOpenTarget,
  acceptanceBarLabel,
  acceptanceApproveLabel,
  acceptanceDivergeLabel,
  acceptanceRefineLabel,
  acceptanceRefineTargets,
  referencesExternalFiles,
} from "./prototype";
import { openModal, type ModalHandle } from "./modal";
import { initAnnotate, type AnnotateHandle } from "./capture/annotate-overlay";
import type { ToolPermissionRequested, AgentExit, AgentError, AgentStream } from "./conversation/types";
import type {
  PlanRecord,
  CommentRecord,
  ReviewRequest,
  ReviewRequested,
  ReviewCancelled,
} from "./types";
import { asAbsPath, type AbsPath, type Stem } from "./types";
// Imports are one-directional: main → controller; controllers never import ./main.
import {
  initTabs,
  initSidebar,
  applyFilterAndRender,
  resolveSelection,
  collapseOverride,
  subCollapse,
} from "./sidebar";
import {
  computeAffordance,
  isResumeSentinel,
  resumeSentinelTreeId,
  detectResumable,
  renderResumeBanner,
  cancelResumeConfirm,
  showToast,
  getPendingResume,
  clearPendingResume,
} from "./resume-banner";
import { suppressConversationFlip, shouldClearPlaceholderOnExit } from "./run-subscription";
import {
  setHookStatus,
  echoCommentsText,
  initReviewBar,
  currentCommentCount,
  applyCommentCount,
  purgeInprocReviews,
  renderPrototypePreview,
} from "./review-bar";
import {
  chainHandler,
  initIpc,
  handleReviewRequested,
  handleReviewCancelled,
  handleToolPermissionRequested,
} from "./ipc";
// plan-flow is a SINK: only `main` imports it (re-exported via the shim below). `export … from` adds no
// local binding, so main also imports the six symbols it still calls internally + the initPlanFlow seam.
import {
  initPlanFlow,
  openPlan,
  resumeNewestReview,
  newestPendingReview,
  openReviewPlanFile,
  openGatePlanFile,
  handlePlanChanged,
} from "./plan-flow";
import {
  initAppState,
  getSelection,
  setSelection,
  openPath,
  pendingReviews,
  currentReviewId,
  currentReviewSource,
  getRunPlaceholder,
  setRunPlaceholder,
  viewingGate,
  activePrototypeGate,
  activeAcceptanceGate,
  stageOrAttachCaptures,
  renderStagedGateChips,
  removeStagedGateCaptures,
  clearStagedGateCaptures,
  resetStagedGateCaptures,
  stagedGateCapturesSnapshot,
  type PendingSurface,
} from "./app-state";

// Re-exported so `./main` importers (tests) keep resolving; `export ... from` adds no local binding.
export { placeholderVisible, initTabs, renderSidebar } from "./sidebar";
export { buildToc } from "./render/toc";
export { computeAffordance, detectResumable, renderResumeBanner } from "./resume-banner";
export type { Affordance, ResumeVerdict } from "./resume-banner";
export { suppressConversationFlip, shouldClearPlaceholderOnExit } from "./run-subscription";
export { setHookStatus } from "./review-bar";
export { reviewCommentCount, refreshCommentCount, currentCommentCount, purgeInprocReviews } from "./review-bar";
export { chainHandler } from "./ipc";
export { openPlan, reloadOpenPlan } from "./plan-flow";

// ---- Frozen contract type (mirrors the Rust PlanChanged wire shape) ----
interface PlanChanged {
  path: string;
  kind: string;
}

// ---- DOM handles (the frozen selector contract) ----
let planListEl: HTMLElement | null;
let planCountEl: HTMLElement | null;
let readerScrollEl: HTMLElement | null;
let readingPaneEl: HTMLElement | null;
let docHeaderEl: HTMLElement | null;
let docFilenameEl: HTMLElement | null;
let docSrcEl: HTMLElement | null;
let modelBarEl: HTMLElement | null;
let convModelChipEl: HTMLElement | null;
let tocListEl: HTMLElement | null;
let filterInputEl: HTMLInputElement | null;
let filterClearEl: HTMLElement | null;
let searchEl: HTMLElement | null;
// Review action bar (non-occluding, docked in the reading-pane header). Shown whenever a review
// is pending (viewing OR summary); see applyReviewBarState.
let reviewBarEl: HTMLElement | null;
let reviewBarLabelEl: HTMLElement | null;
let reviewSubmitEl: HTMLButtonElement | null;
// Exactly-once dispatch lock for #review-submit and #review-approve. Set after a branch's
// validation guard and before its first await; reset to "none" in try/finally on every exit.
// Both handlers early-return if not "none" — the top-of-handler early-return IS the exactly-once
// invariant. Only "submit" feeds the bar's "submitting" visual lock; "approve" is correctness-only.
// ActionInFlight is a dispatch lock, NOT a RemoteData read — it has no success payload and the
// submit/approve identity is load-bearing.
// INVARIANT[action-in-flight-tristate] (type-level): at most one review action dispatches at a time — identity is the single union none | submit | approve, not two booleans.
//   prevents: the "submit AND approve both in flight" state
type ActionInFlight = "none" | "submit" | "approve";
let actionInFlight: ActionInFlight = "none";
let reviewClearEl: HTMLButtonElement | null;
let reviewResumeEl: HTMLButtonElement | null;
// dedicated "Approve & Build" button — shown only while VIEWING an in-process review.
let reviewApproveEl: HTMLButtonElement | null;
// Forced-acceptance REFINE button + its sub-plan picker — shown ONLY in ACCEPTANCE mode.
let reviewRefineEl: HTMLButtonElement | null = null;
let reviewRefineTargetEl: HTMLSelectElement | null = null;
// External Submit button's label captured at wire-time so in-process relabels can be reverted.
let REVIEW_SUBMIT_EXTERNAL_LABEL = "Submit feedback";
// PROTOTYPE-mode controls: #prototype-feedback (refine textarea) and #prototype-open (browser;
// visible only for kind "html"). Hidden outside PROTOTYPE mode.
let prototypeFeedbackEl: HTMLTextAreaElement | null = null;
let prototypeOpenEl: HTMLButtonElement | null = null;
let prototypePreviewEl: HTMLButtonElement | null = null;
let prototypeAttachmentsEl: HTMLElement | null = null;
// At most one preview modal may be open at a time. `previewModal` holds it while open;
// `previewOpening` guards the async window before the first read_prototype_file resolves so two
// rapid clicks cannot both reach openModal.
let previewModal: ModalHandle | null = null;
let previewOpening = false;
// Working-reference checkbox: UNCHECKED = "just a sketch"; CHECKED = "working reference" →
// approve freezes prototype/ → baseline/ and records baseline_ on the ledger.
let prototypeWorkingRefEl: HTMLInputElement | null = null;
let prototypeWorkingRefLabelEl: HTMLLabelElement | null = null;
// #review-approve's default label, captured at wire-time so PROTOTYPE mode's relabels revert exactly.
let REVIEW_APPROVE_DEFAULT_LABEL = "Approve & Build";
// #hook-status: setHookStatus() surfaces review-response / save-for-review errors.
let hookStatusEl: HTMLElement | null;

// ---- Resume banner — the LOWEST-precedence reading-pane affordance ----------------------------
// Shown when the open plan belongs to a non-terminal .plan-tree/ with no active orchestration.
// Separate from the review bar; suppressed whenever a higher affordance occupies it.
let resumeBannerEl: HTMLElement | null = null;
let resumeBannerMsgEl: HTMLElement | null = null;
let resumePlanBtnEl: HTMLButtonElement | null = null;
// HAZARDOUS-resume confirmation: a verdict with requiresConfirm:true reveals an inline confirm
// row (#resume-confirm) instead of resuming immediately; resume() fires only from #resume-confirm-btn.
let resumeHazardEl: HTMLElement | null = null;
let resumeConfirmRowEl: HTMLElement | null = null;
let resumeConfirmBtnEl: HTMLButtonElement | null = null;
let resumeCancelBtnEl: HTMLButtonElement | null = null;
// #toast: lightweight non-blocking notice element (the auto-dismiss timer lives in ./resume-banner).
let toastEl: HTMLElement | null = null;

// ---- reading-pane [Plan | Conversation] tab handles (hoisted to module scope) ----
// Hoisted so switchToConversationTab / switchToPlanTab are module-level (main.ts owns this tab
// for the in-process review case). Null under unit tests → switchers no-op.
let readerTabRowEl: HTMLElement | null = null;
let tabPlanPaneEl: HTMLElement | null = null;
let tabConversationEl: HTMLElement | null = null;
// Assigned in DOMContentLoaded once initConversation resolves; null until then.
// Hoisted so tab switchers can repaint the minimap when the Conversation pane becomes visible.
let conversationHandle: ConversationHandle | null = null;

// Switch the reading pane to the Conversation tab (used when an agent run starts/streams, and after
// an in-process Approve so execution is visible). Pure view switch — never rebuilds pane content.
function switchToConversationTab(): void {
  if (!readerTabRowEl || !tabPlanPaneEl || !tabConversationEl) return;
  for (const t of Array.from(readerTabRowEl.querySelectorAll<HTMLElement>(".tab"))) {
    t.classList.toggle("active", t.dataset.tab === "conversation");
  }
  tabPlanPaneEl.classList.remove("active");
  tabConversationEl.classList.add("active");
  // Repaint the minimap on the next frame — offsets are 0 until layout settles after the display
  // toggle. No-op if handle or minimap is absent.
  requestAnimationFrame(() => conversationHandle?.refreshMinimap());
}

// Flip to the Plan tab. Used by the in-process ExitPlanMode handler. Pure view switch.
function switchToPlanTab(): void {
  if (!readerTabRowEl || !tabPlanPaneEl || !tabConversationEl) return;
  for (const t of Array.from(readerTabRowEl.querySelectorAll<HTMLElement>(".tab"))) {
    t.classList.toggle("active", t.dataset.tab === "plan");
  }
  tabConversationEl.classList.remove("active");
  tabPlanPaneEl.classList.add("active");
}

// Latest snapshot from the shared orchestrator (null until a run is active, null after it ends).
// Holds the active node's approval-kind pendingGate while the user reviews.
let orchSnapshot: PlanTreeSnapshot2 | null = null;

// ---- PendingSurface[]: the unified set of "things awaiting the user" -------------------------
// One list so pendingCount and resumeNewestReview derive from the same source:
//   • external / in-process — tracked pendingReviews (held hooks / canUseTool seams).
//   • orchestrator-gate     — the live run's held ApprovalGate2 (NOT in pendingReviews).
//   • prototype / acceptance — the live run's held visual/forced-acceptance gates.
// Gate surfaces use the same precedence helpers (activePrototypeGate / activeAcceptanceGate),
// so at most one gate surface is ever present. The PendingSurface type lives in ./app-state (shared
// with plan-flow's resumeNewestReview); this is its sole builder.

// INVARIANT[pending-surface-union] (convention): every "thing awaiting the user" is one typed PendingSurface from this single builder, which both the SUMMARY count and the Resume target consult.
//   prevents: the count and the resume button computing "what's pending" from divergent paths
function pendingSurfaces(): PendingSurface[] {
  const surfaces: PendingSurface[] = [];
  for (const r of pendingReviews.values()) surfaces.push({ kind: r.source, review: r });
  const orchGate = isOrchestrationActive() ? approvalGateOf(orchSnapshot) : null;
  if (orchGate) surfaces.push({ kind: "orchestrator-gate", gate: orchGate });
  const proto = activePrototypeGate();
  if (proto) surfaces.push({ kind: "prototype", gate: proto });
  const accept = activeAcceptanceGate();
  if (accept) surfaces.push({ kind: "acceptance", gate: accept });
  return surfaces;
}

// Test-only: clear all review state.
export function __resetReviewStateForTest(): void {
  pendingReviews.clear();
  // Reset selection to clear stale openPath/currentReviewId() for the next test.
  setSelection({ k: "none" });
  orchSnapshot = null;
  // Drop leaked placeholder (selection=none above already clears placeholder-selected state).
  setRunPlaceholder(null);
  clearPendingResume();
  // Clear leaked in-flight lock so the next test's Submit isn't stuck disabled.
  actionInFlight = "none";
  // Drop any captures staged by a prior test so they cannot ride the next test's gate send. NON-rendering
  // reset (resetStagedGateCaptures, not clearStagedGateCaptures) so the reset fires no `#prototype-attachments`
  // DOM mutation the bare-array clear it replaces never performed.
  resetStagedGateCaptures();
}

// Test-only: install a live-run placeholder + selection for testing applyFilterAndRender paths.
export function __setRunPlaceholderForTest(
  ph: { treeId: string; label: string } | null,
  selected: boolean,
): void {
  setRunPlaceholder(ph);
  // A selected placeholder IS the selection (folded). A deselect drops only a stale placeholder
  // selection — must not clobber a real plan/sentinel left open by a prior test.
  if (selected && ph !== null) setSelection({ k: "placeholder", treeId: ph.treeId });
  else if (!selected && getSelection().k === "placeholder") setSelection({ k: "none" });
}

// Mock/automation hook: force a tree fully expanded. Clears session collapse intent
// (collapseOverride for the master + all subCollapse entries), then repaints via applyFilterAndRender.
export function __expandTreeForMock(treeId: string): void {
  collapseOverride.set(treeId, false);
  // Drop all subCollapse entries for this tree (key = tree_id + NUL + nn_path).
  const prefix = treeId + "\u0000";
  for (const key of Array.from(subCollapse.keys())) {
    if (key.startsWith(prefix)) subCollapse.delete(key);
  }
  applyFilterAndRender();
}

// Mock/automation hook: set `selection` (and thus openPath) WITHOUT re-rendering the pane. The mock
// ANIMATE player renders the pane directly via renderInto, so openPath stays stale; this setter
// aligns it so viewingGate()/currentReviewId() match the gate's planPath. Production always uses openPlan().
export function __setOpenPathForMock(path: string | null): void {
  setSelection(path === null ? { k: "none" } : { k: "plan", path: asAbsPath(path) });
}

// ---- Sidebar filter ----
// Live filter query. Held at module scope so a late cwd patch can re-run the filter without a
// list_plans round-trip. Records live solely in listState (read via currentRecords()).
let filterQuery = "";

// Sidebar plan-list as a five-state RemoteData. The lifecycle is split:
//   • INITIAL load (listState `initial`): drives initial → fetching → success | zeroResults | error.
//   • IN-PLACE refresh: must NOT revert to `fetching` or flash `zeroResults`. See INVARIANT[list-refresh-no-fetching-flash].
// Sole store of the records (no parallel array). All readers use currentRecords().
let listState: RemoteData<PlanRecord[]> = initial();

// Unwraps listState's success payload (same array reference the fold renders and cwd late-patch
// mutates), or [] for non-success states.
function currentRecords(): PlanRecord[] {
  return unwrapOr(listState, []);
}

// PATH-KEYED RemoteData<CommentRecord[]> per plan path is owned by the comments facade
// (src/render/comments.ts). main.ts wires the facade's IO; no second comment-list model lives here.

// Monotonic render-generation guard — bails post-await if a newer render has begun.
const renderGuard = new RenderGuard();

// ---- Review action bar (persistent, non-occluding, resumable) ----
// Two modes (pure derivation in applyReviewBarState):
//   • VIEWING  — the open plan is a pending review: Submit (enabled with ≥1 comment). In-process
//                reviews also show Approve & Build.
//   • SUMMARY  — reviews pending but user is browsing elsewhere: count + Resume only.
// Derives off pendingReviews / commentCount / selection and the #review-bar DOM.
function refreshReviewBar(countOverride?: number): void {
  if (!reviewBarEl) return;
  // PROTOTYPE mode — activePrototypeGate() is non-null only when the single held pendingGate is of
  // kind "prototype", so reaching here means a prototype gate is the pending surface.
  const protoGate = activePrototypeGate();
  if (protoGate !== null) {
    applyPrototypeBar(protoGate);
    return;
  }
  // ACCEPTANCE mode — activeAcceptanceGate() is non-null only when the single held pendingGate is of
  // kind "acceptance"; reaching here with a non-null gate means it is the pending surface.
  const acceptGate = activeAcceptanceGate();
  if (acceptGate !== null) {
    applyAcceptanceBar(acceptGate);
    return;
  }
  // Leaving (or never in) PROTOTYPE mode: its additive controls hide and #review-approve's
  // relabel reverts so the modes below render exactly as before the prototype feature.
  // The `.proto` modifier scopes the prototype-only bar layout (see styles.css); strip it so the
  // shared bar reverts to its legacy/approval-gate layout untouched.
  reviewBarEl.classList.remove("proto");
  prototypeFeedbackEl?.classList.add("hidden");
  prototypeOpenEl?.classList.add("hidden");
  prototypePreviewEl?.classList.add("hidden");
  prototypeWorkingRefLabelEl?.classList.add("hidden");
  // Staged-capture strip is PROTOTYPE-mode only. Hide WITHOUT clearing the stage — its lifecycle is
  // send-success / run-end, mirroring the feedback textarea's preservation.
  prototypeAttachmentsEl?.classList.add("hidden");
  // The REFINE button + its picker are ACCEPTANCE-mode-only; hide on every other mode.
  reviewRefineEl?.classList.add("hidden");
  reviewRefineTargetEl?.classList.add("hidden");
  if (reviewApproveEl) reviewApproveEl.textContent = REVIEW_APPROVE_DEFAULT_LABEL;
  // the SUMMARY-mode count is the number of pending surfaces. By the precedence above
  // (PROTOTYPE/ACCEPTANCE short-circuit out before here), no prototype/acceptance gate is held at this
  // point, so pendingSurfaces() == the tracked pendingReviews PLUS the held orchestrator gate (the one
  // gate-surface that is NOT in pendingReviews) — i.e. identical to the legacy
  // `pendingReviews.size + orchGatePending`. `viewing` is true on a tracked review's plan OR the gate's.
  const state = applyReviewBarState({
    // INVARIANT[pending-count-equals-surfaces-length-at-the-bar-site] (convention): the SUMMARY count is pendingSurfaces().length — the same builder the Resume picker consults.
    //   prevents: the count double-counting or omitting a gate surface
    pendingCount: pendingSurfaces().length,
    viewing: currentReviewId() !== null || viewingGate() !== null,
    viewedCommentCount: countOverride ?? currentCommentCount(),
    // Source-aware: drives #review-approve visibility + the Submit label ("Request changes" for
    // in-process, "Submit" for external). currentReviewSource() reads the SAME matched review (or the
    // orchestrator gate, which it reports as "in-process").
    source: currentReviewSource(),
    // a submit already in flight refines VIEWING into "submitting" (Submit disabled, Approve
    // hidden). Ignored in summary/hidden and in the prototype/acceptance bars (those short-circuit
    // above) — the handler's top-of-handler early-return is what guarantees exactly-once there.
    // INVARIANT[approve-never-drives-the-submitting-visual-lock] (convention): only "submit" maps into the bar's visual "submitting" lock; an in-flight "approve" gates dispatch but feeds no bar change.
    //   prevents: an in-flight approve spuriously flipping the bar into "Submitting…"
    submitInFlight: actionInFlight === "submit",
  });
  reviewBarEl.classList.toggle("hidden", !state.barVisible);
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = state.label;
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.toggle("hidden", !state.submitVisible);
    reviewSubmitEl.disabled = state.submitDisabled;
    // Source-aware label. In-process deny RE-PLANS in the same session → relabel to "Request changes".
    // External keeps its richer HTML default ("Submit feedback"); the pure state's external submitLabel
    // is "Submit" (asserted in the pure test) but we deliberately do NOT overwrite the external button's
    // existing descriptive text — relabel ONLY for the in-process source so external display is unchanged.
    if (currentReviewSource() === "in-process") reviewSubmitEl.textContent = state.submitLabel;
    else reviewSubmitEl.textContent = REVIEW_SUBMIT_EXTERNAL_LABEL;
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.toggle("hidden", !state.approveVisible);
  }
  if (reviewClearEl) {
    reviewClearEl.classList.toggle("hidden", !state.clearVisible);
    // If the manual clear button just became hidden (mode change / count hit 0), disarm any pending
    // two-click confirm so it can't fire later in a stale state.
    if (!state.clearVisible) reviewClearDisarm?.();
  }
  if (reviewResumeEl) reviewResumeEl.classList.toggle("hidden", !state.resumeVisible);
}

// The bar's PROTOTYPE mode. Shown while a visual-prototype gate is held (and no
// approval gate outranks it — see refreshReviewBar's precedence). Affordances:
//   • label — `Visual prototype — round N of 3` (pure prototypeBarLabel; rounds are 1-based,
//     display-clamped to 3).
//   • #review-approve — ALWAYS enabled → approvePrototype(). Relabeled "Approve visual"
//     ("Proceed as-is" from round 3 — the loop-escape affordance; pure prototypeApproveLabel).
//   • #review-submit — "Request changes" → refinePrototype(feedback). Enabled only while
//     #prototype-feedback holds non-empty text (the feedback IS the refine prompt's payload).
//   • #prototype-feedback — the inline feedback textarea (PROTOTYPE mode only).
//   • #prototype-open — visible ONLY for kind "html": opens the prototype in the default browser
//     via the open_prototype command (HTML cannot render inline in the pane).
// The comment-driven controls (clear/dismiss/resume) hide: prototype feedback is the textarea,
// not inline comments.
function applyPrototypeBar(gate: PrototypeGate): void {
  if (!reviewBarEl) return;
  reviewBarEl.classList.remove("hidden");
  // `.proto` scopes the prototype-only bar layout (textarea-grows, nowrap buttons, taller bar) so
  // the shared review-bar's other two modes are untouched. See styles.css `.review-bar.proto`.
  reviewBarEl.classList.add("proto");
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = prototypeBarLabel(gate.round);
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.remove("hidden");
    reviewSubmitEl.textContent = "Request changes";
    reviewSubmitEl.disabled = (prototypeFeedbackEl?.value.trim() ?? "") === "";
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.remove("hidden");
    // ADAPTIVE approve label: with non-empty feedback typed, approving APPLIES the feedback then
    // auto-advances to recon (combined apply-and-approve) — label "Apply changes & approve". With an
    // empty textarea it is the plain approve ("Approve visual" / "Proceed as-is" from round 3). The
    // #prototype-feedback `input` listener calls refreshReviewBar() so this recomputes live as the
    // user types — read the CURRENT textarea value here.
    const hasFeedback = (prototypeFeedbackEl?.value.trim() ?? "") !== "";
    reviewApproveEl.textContent = hasFeedback ? "Apply changes & approve" : prototypeApproveLabel(gate.round);
  }
  if (reviewClearEl) {
    reviewClearEl.classList.add("hidden");
    reviewClearDisarm?.();
  }
  reviewResumeEl?.classList.add("hidden");
  // The REFINE button + its picker are ACCEPTANCE-mode-only; keep hidden in PROTOTYPE mode.
  reviewRefineEl?.classList.add("hidden");
  reviewRefineTargetEl?.classList.add("hidden");
  if (prototypeFeedbackEl) {
    prototypeFeedbackEl.classList.remove("hidden");
    // Restore the prototype placeholder (ACCEPTANCE mode repurposes the same textarea).
    prototypeFeedbackEl.placeholder = "Describe what to change in the visual…";
  }
  // Restore the open-button's prototype label (ACCEPTANCE mode relabels it "Open baseline").
  if (prototypeOpenEl) prototypeOpenEl.textContent = "Open in browser";
  prototypeOpenEl?.classList.toggle("hidden", gate.kind !== "html");
  prototypePreviewEl?.classList.toggle("hidden", gate.kind !== "html");
  // Working-reference checkbox: shown for EVERY prototype kind (the floor classification applies to
  // any prototype, not just HTML). Its checked state is read at approve time (applyPrototypeBar
  // never forces it — the user's choice persists across live re-derivations while the gate is held).
  prototypeWorkingRefLabelEl?.classList.remove("hidden");
  renderStagedGateChips();
}

// The bar's ACCEPTANCE mode (the forced acceptance gate). Shown while a held
// AcceptanceGate is the highest-precedence pending surface (a held approval/prototype gate outranks
// it — see refreshReviewBar's precedence). The run is built; the user must record a verdict against
// the frozen working-reference baseline before it is reported done. Reuses the prototype bar's
// layout/controls:
//   • label — `Acceptance — does the build meet the baseline floor?` (pure acceptanceBarLabel).
//   • #review-approve — ALWAYS enabled → approveAcceptance() ("Accept (meets baseline)").
//   • #review-submit — "Accept divergence…" → divergeAcceptance(reason). Enabled only while
//     #prototype-feedback holds a non-empty reason (the reason IS the persisted audit trail).
//   • #prototype-feedback — reused as the divergence-reason textarea (ACCEPTANCE mode only).
//   • #prototype-open — relabeled "Open baseline" → open_baseline (the driver auto-opens it once on
//     gate arming; this is the manual re-open affordance).
// The comment-driven controls (clear/dismiss/resume) and the working-reference checkbox hide.
function applyAcceptanceBar(_gate: AcceptanceGate): void {
  if (!reviewBarEl) return;
  reviewBarEl.classList.remove("hidden");
  // Reuse the `.proto` layout (textarea-grows, nowrap buttons, taller bar).
  reviewBarEl.classList.add("proto");
  if (reviewBarLabelEl) reviewBarLabelEl.textContent = acceptanceBarLabel();
  if (reviewSubmitEl) {
    reviewSubmitEl.classList.remove("hidden");
    reviewSubmitEl.textContent = acceptanceDivergeLabel();
    // Divergence REQUIRES a reason (the audit trail) — disabled until the textarea has non-empty text.
    reviewSubmitEl.disabled = (prototypeFeedbackEl?.value.trim() ?? "") === "";
  }
  if (reviewApproveEl) {
    reviewApproveEl.classList.remove("hidden");
    reviewApproveEl.textContent = acceptanceApproveLabel(); // always enabled — the floor is met
  }
  // The REFINE action (re-plan a sub-plan) is the THIRD acceptance action, shown ONLY in
  // ACCEPTANCE mode and only when there is at least one refinable sub-plan (a split root). The picker
  // (#review-refine-target) is the target-selection step; the button routes the picked target into
  // refineAcceptance. Populate the picker from the snapshot (DERIVED — acceptanceRefineTargets), then
  // toggle both controls together.
  const refineTargets = orchSnapshot ? acceptanceRefineTargets(orchSnapshot.root) : [];
  const hasTargets = refineTargets.length > 0;
  if (reviewRefineTargetEl) {
    // Preserve the user's prior selection across re-derivations when it still exists.
    const prior = reviewRefineTargetEl.value;
    reviewRefineTargetEl.innerHTML = "";
    for (const t of refineTargets) {
      const opt = document.createElement("option");
      opt.value = t.pathKey;
      opt.textContent = `${t.pathKey} — ${t.title}`;
      reviewRefineTargetEl.appendChild(opt);
    }
    if (refineTargets.some((t) => t.pathKey === prior)) reviewRefineTargetEl.value = prior;
    reviewRefineTargetEl.classList.toggle("hidden", !hasTargets);
  }
  if (reviewRefineEl) {
    reviewRefineEl.classList.toggle("hidden", !hasTargets);
    reviewRefineEl.textContent = acceptanceRefineLabel();
  }
  if (reviewClearEl) {
    reviewClearEl.classList.add("hidden");
    reviewClearDisarm?.();
  }
  reviewResumeEl?.classList.add("hidden");
  // The divergence-reason textarea (reused #prototype-feedback) is shown; the working-reference
  // checkbox is hidden (it belongs to the prototype gate, not the acceptance gate).
  if (prototypeFeedbackEl) {
    prototypeFeedbackEl.classList.remove("hidden");
    prototypeFeedbackEl.placeholder = "Why does the build diverge from the baseline floor?";
  }
  prototypeWorkingRefLabelEl?.classList.add("hidden");
  prototypePreviewEl?.classList.add("hidden");
  // Staged captures belong to the prototype gate, not the acceptance gate — hide the strip here.
  prototypeAttachmentsEl?.classList.add("hidden");
  // Reuse #prototype-open as "Open baseline".
  if (prototypeOpenEl) {
    prototypeOpenEl.classList.remove("hidden");
    prototypeOpenEl.textContent = "Open baseline";
  }
}

// Disarm hook for the #review-clear two-click confirm (set by its wiring; null under unit tests that
// never wire it). refreshReviewBar calls it when the button hides.
let reviewClearDisarm: (() => void) | null = null;

// Set once initConversation returns (the .then below): tells the conversation model a held
// interactive permission was resolved HERE (ExitPlanMode Approve / Request-changes — no
// question_answered exists for it), so its "Waiting for your input…" working label clears the
// instant the user clicks, not on the SDK's next inbound frame. Null until the handle exists.
let notifyPermissionResolved: ((toolUseId: string) => void) | null = null;

// Set once initConversation returns: echoes a VERBATIM user message as a user-attributed bubble in
// the conversation stream. Used by the out-of-band feedback sites (prototype "Request changes",
// plan-review comment submit) so the user's own words appear in the conversation. MUST be called only
// AFTER the corresponding dispatch SUCCEEDS — never before (a failed send must add no bubble). Null
// until the handle exists.
let echoUserMessage: ((text: string) => void) | null = null;

// Surface a NON-FATAL notice into the conversation stream (a `.conv-notice` row) — used by the gate
// handlers to report a failed dispatch instead of swallowing it. Null until the handle exists.
let surfaceMessage: ((text: string) => void) | null = null;

// Set once initConversation returns: reconstruct + replay a plan's PAST conversation into the
// CONVERSATION pane (silent populate on plan-select). Fired un-awaited from openPlan; a NO-OP while a
// live session / orchestration owns the pane (guarded inside the handle). Null until the handle exists.
let loadPlanHistory: ((stem: Stem) => void) | null = null;

// Shared review-response logic (the SINGLE place that calls respond_to_review), so the bar handlers
// never duplicate the invoke. On success, the review is removed from pendingReviews; the plan stays
// open + selected and its comments remain saved. The bar is then refreshed (drops to summary mode if
// other reviews remain, or hides entirely). Errors are surfaced in-DOM via #hook-status.
//   • Submit  = "deny" + buildFeedbackPrompt(the open plan's comments) → Claude revises.
//   • Approve = "allow" → IN-PROCESS reviews ONLY (the #review-approve "Approve & Build" click) allows
//               the held plan and begins building in-session. EXTERNAL reviews are NOT approvable from
//               the app: the external path below is DENY-ONLY (it guards "allow" and the Rust
//               respond_to_review command rejects "allow" too). External approvals happen only in the
//               terminal — the old "Dismiss → approve in terminal" button that once drove an in-app
//               external "allow" was removed and #review-approve is hidden for external reviews.
// Returns true iff the response was sent successfully (so callers — e.g. Submit — can take a
// success-only follow-up action such as clearing the submitted plan's now-consumed comments).
async function resolveReview(reviewId: string, decision: "allow" | "deny", reason: string): Promise<boolean> {
  const review = pendingReviews.get(reviewId);
  // Model the round-trip's outcome as a ScalarRemoteData<void>: success = the response landed, error =
  // it failed (initial/fetching are unreachable for this awaited one-shot — no-op arms). Folding via
  // matchScalar replaces a bare catch-and-return with an EXPLICIT error arm that drives the visible
  // #hook-status surface and leaves the review pending; ONLY the success arm removes it + re-derives
  // the affordances. The boolean return is preserved (Submit clears comments only on success).
  let outcome: ScalarRemoteData<void>;
  try {
    if (review?.source === "in-process") {
      // ---- In-process (Agent SDK canUseTool seam): round-trip the SAME toolUseId ----------------
      // The toolUseId is the SDK's id for the held ExitPlanMode request (= the reviewId here). It is
      // round-tripped IDENTICALLY whether or not this was a subagent plan (agentId is never branched
      // on), so a subagent's plan resolves exactly like the main agent's.
      const id = review.toolUseId ?? reviewId;
      if (decision === "allow") {
        // Approve & Build: allow the plan (no message), switch the live session to acceptEdits, and
        // flip to the Conversation tab so execution streams in place. This is the ONLY path that ever
        // calls resolve_tool_permission(allow) — reachable solely from the #review-approve click.
        await invoke("resolve_tool_permission", { id, allow: true, message: null });
        await invoke("set_agent_permission_mode", { mode: "acceptEdits" });
        switchToConversationTab();
      } else {
        // Request changes: deny with the assembled feedback prompt → the agent re-plans in the SAME
        // session (re-entering review when it re-emits ExitPlanMode).
        await invoke("resolve_tool_permission", { id, allow: false, message: reason });
      }
      // Either way the hold is released — drop the conversation's waiting-for-input label NOW.
      notifyPermissionResolved?.(id);
    } else {
      // ---- External (settings.json ExitPlanMode hook): the file-IPC path — DENY-ONLY ------------
      // External reviews can only be DENIED/Submitted from the app; approval happens exclusively in
      // the terminal (the old in-app "Dismiss → approve" affordance was removed, and #review-approve
      // is hidden for external reviews — review.ts approveVisible === source==="in-process"). Guard
      // the now-unreachable "allow" so a future caller can never silently re-introduce an in-app
      // external approval; the Rust respond_to_review command rejects it too (defense in depth).
      if (decision !== "deny") {
        throw new Error(
          `external reviews are deny-only from the app (got "${decision}"); approve in the terminal`,
        );
      }
      await invoke("respond_to_review", { reviewId, decision, reason });
    }
    outcome = success(undefined);
  } catch (e) {
    console.error(`resolveReview (${decision}, ${review?.source ?? "external"}) failed`, e);
    outcome = failure(String(e));
  }
  return matchScalar<void, boolean>(outcome, {
    initial: () => false,
    fetching: () => false,
    error: (message) => {
      setHookStatus(hookStatusEl, `Could not send review response: ${message}`, "error");
      setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
      return false;
    },
    success: () => {
      pendingReviews.delete(reviewId);
      // Removing a pending review can UN-suppress the resume banner (precedence: a pending review
      // outranks resume). Re-derive BOTH surfaces so a now-unsuppressed resumable open plan shows its
      // Resume button without waiting for a re-open.
      // INVARIANT[surface-removal-unsuppresses-resume] (convention): each site that removes a pending surface re-derives both affordances via refreshAffordances().
      //   prevents: an out-of-band cancel leaving the resume banner stuck hidden
      refreshAffordances();
      return true;
    },
  });
}

// ---- cwd resolution + read/unread wiring (sidebar only) ----
// The mutable cwd collections (cwdByStem / attemptedStems / resolveAttemptCounts), homePath, and the
// DOM-free display helpers (displayCwd / planSrcText / cwdDisplayForStem / dirOf / stemFromPath) live
// in ./cwd; this module imports them and keeps the DOM/IO-touching wiring below.

// Mark a plan viewed on the backend (clears its unread state). Errors are non-fatal.
async function markViewed(path: AbsPath): Promise<void> {
  try {
    await invoke("mark_viewed", { path });
  } catch (e) {
    console.error("mark_viewed failed", e);
  }
}

// Reveal the inline confirm row for a HAZARDOUS resume: hide the primary button, show the hazard text +
// Confirm/Cancel pair. resume() does NOT fire here — only #resume-confirm-btn fires it.
function showResumeConfirmRow(hazard: string | null): void {
  resumePlanBtnEl?.classList.add("hidden");
  if (resumeHazardEl) {
    resumeHazardEl.textContent = hazard
      ? `Are you sure? ${hazard}`
      : "Are you sure? The assistant will inspect the working tree and continue the remaining steps; " +
        "if it misjudges what's already applied, edits could be duplicated or corrupted.";
  }
  resumeConfirmRowEl?.classList.remove("hidden");
}

// Re-evaluate the resume banner for the currently-open record (fire-and-forget from openPlan). Reads
// the freshest record for `path` from currentRecords() (its tree_id/cwd may have been patched since
// open), runs detectResumable, and paints the banner — but only if `path` is STILL the open plan when
// the async read lands (a fast A→B switch must not paint A's banner over B).
async function refreshResumeBanner(path: AbsPath): Promise<void> {
  const rec = currentRecords().find((r) => r.absolute_path === path);
  if (!rec) {
    if (openPath() === path) renderResumeBanner(null);
    return;
  }
  const verdict = await detectResumable(rec);
  if (openPath() !== path) return; // superseded — a newer open owns the banner.
  renderResumeBanner(verdict);
}

// Re-derive ALL reading-pane affordances together from the current state — the SINGLE entry point every
// run/open transition calls so the review bar and the resume banner can never drift. refreshReviewBar
// owns prototype/acceptance/review (it short-circuits into PROTOTYPE/ACCEPTANCE mode, else renders
// review/summary); the resume banner is the lowest-precedence surface, so it is suppressed whenever any
// higher affordance is active (computeAffordance states that precedence) and only (re-)derived when the
// bar is otherwise idle. A run ending therefore re-evaluates the open plan's resumability WITHOUT
// reopening it (the active run was the only thing suppressing the banner — detectResumable null while
// orchestrating). A null openPath (nothing open / a live placeholder) just hides the banner.
// INVARIANT[reading-pane-affordance-precedence] (precedence): the resume banner is (re-)derived only when computeAffordance reports no higher affordance occupies the bar.
//   prevents: the resume banner showing beneath a held review / gate
function refreshAffordances(): void {
  refreshReviewBar();
  const op = openPath();
  const higher = computeAffordance({
    prototype: activePrototypeGate() !== null,
    acceptance: activeAcceptanceGate() !== null,
    review: viewingGate() !== null || currentReviewId() !== null || pendingSurfaces().length > 0,
    resume: false, // resolved below by refreshResumeBanner only when nothing higher occupies the bar
  });
  if (op === null || higher !== "none") renderResumeBanner(null);
  else void refreshResumeBanner(op);
}

// #resume-plan-btn click → drive getOrchestrator().resume() and, on success, mirror the composer's
// onStarted path: the onSnapshot observer mints the live-run placeholder + selects it (real sidebar
// rows already exist for this tree, so placeholderVisible suppresses a phantom row), and for a gate
// phase the onAwaitingApproval observer opens the held plan + flips to the Plan tab. We flip to the
// Conversation tab up front (matching the composer start) and hide the banner on success.
async function resumeFromBanner(): Promise<void> {
  const pr = getPendingResume();
  if (pr === null) return;
  // HAZARDOUS gate: a verdict whose plan requiresConfirm (leaf/executing — edits may be
  // partially applied) must NOT resume on this first click. Reveal the inline confirm row and return;
  // resume() fires ONLY from the subsequent #resume-confirm-btn click (executeResume). Non-hazardous
  // verdicts fall through and fire immediately, exactly as before.
  if (pr.requiresConfirm) {
    showResumeConfirmRow(pr.hazard);
    return;
  }
  await executeResume();
}

// Actually drive getOrchestrator().resume() for the pending verdict. Reached from the non-hazardous
// button click directly, OR from #resume-confirm-btn after the user confirmed a hazardous resume — so
// resume() is provably never invoked for a hazardous verdict until confirmation.
async function executeResume(): Promise<void> {
  const pr = getPendingResume();
  if (pr === null) return;
  const { cwd, ledger } = pr;
  // Disable BOTH the primary and the confirm button to prevent a double-click re-entry while resume()
  // is in flight (either could be the visible control depending on the confirm step).
  if (resumePlanBtnEl) resumePlanBtnEl.disabled = true;
  if (resumeConfirmBtnEl) resumeConfirmBtnEl.disabled = true;
  try {
    const ok = await getOrchestrator().resume({ cwd, ledger });
    if (ok) {
      // Mirror the composer onStarted path: show the live run. The onSnapshot observer flips the
      // placeholder/selection and switches the tab; flip here too so the user sees the run immediately
      // even before the first snapshot lands. A gate-phase resume's onAwaitingApproval observer will
      // then re-assert the Plan tab on the held plan.
      switchToConversationTab();
      renderResumeBanner(null);
    }
  } catch (e) {
    console.error("resume() failed", e);
    showToast("Couldn't resume this plan — see the log for details.");
  } finally {
    if (resumePlanBtnEl) resumePlanBtnEl.disabled = false;
    if (resumeConfirmBtnEl) resumeConfirmBtnEl.disabled = false;
  }
}

// Re-fetch the list and re-render the sidebar (re-sort by recency / nesting happens in Rust).
async function refreshList(): Promise<void> {
  if (!planListEl) return;

  // INVARIANT[list-refresh-no-fetching-flash] (runtime-guard): only the INITIAL load (listState `initial`) transitions to `fetching`; an in-place refresh of an already-loaded list leaves the rendered list untouched while the next read is in flight.
  //   prevents: a watcher tick blanking a populated sidebar to the empty `fetching` render mid-fetch.
  //   test: list-refresh-never-renders-fetching-in-place
  // The `isInitial(listState)` guard is LOAD-BEARING — see the test
  // `list-refresh-never-renders-fetching-in-place`: dropping it (setting `fetching()` + rendering on
  // EVERY refresh) repaints the empty fetching state on an in-place refresh, clearing the populated
  // list while `list_plans` resolves. The initial load DOES paint `fetching` (an empty render — the
  // sidebar is empty before the first load anyway), completing the lifecycle initial -> fetching.
  if (isInitial(listState)) {
    listState = fetching();
    applyFilterAndRender();
  }

  let records: PlanRecord[];
  try {
    records = await invoke<PlanRecord[]>("list_plans");
  } catch (e) {
    // INVARIANT[transient-list-failure-is-a-noop] (runtime-guard): a failed list_plans returns early, leaving listState/selection/pane untouched.
    //   prevents: a transient IPC failure collapsing the open plan (empty list → resolveSelection "vanish" → blanked pane)
    // A TRANSIENT list_plans failure must be a NO-OP for the selection + pane. Substituting an empty
    // list (the old behavior) would flow into resolveSelection's collapse path — prevRecords still
    // holds the open plan, records=[] ⇒ "vanished" — and blank the pane the user is reading + drop the
    // selection to `none` (non-self-healing; refreshList fires on every plan-changed). Bail without
    // touching listState/selection/pane; the next successful refresh repaints.
    // RemoteData error arm: when ANY last-good result exists — a populated `success` OR a
    // successful-but-EMPTY `zeroResults` — we keep it untouched (a TRUE no-op preserving the rendered
    // list/empty-state). Only a failure with NO last-good at all (a rejected load before any result
    // landed — listState is still `initial`/`fetching`) surfaces the `error` arm; there is no sidebar
    // error UI, so it folds to the same empty render, but the state is now distinguishably `error`.
    console.error("list_plans failed — leaving the sidebar/selection intact", e);
    if (isInitial(listState) || isFetching(listState)) {
      listState = failure(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // Capture the PRIOR list BEFORE the boundary parse below reassigns `listState`, so the reducer can
  // tell a genuine vanish (was listed, now gone) from a never-listed open (a not-yet-indexed plan /
  // the __setOpenPathForMock demo / a lagging gate row). `currentRecords()` still reflects the
  // last-good `listState` here (it has not been reassigned yet).
  const prevRecords = currentRecords();

  // Boundary parse: model the resolved array as RemoteData. `fromArray` maps [] -> zeroResults (drives
  // the empty-state) and a populated array -> success (data replaced in place). This is the ONLY
  // producer of success/zeroResults and runs ONLY on a resolved fetch, so an in-place refresh never
  // flashes `fetching` or a spurious `zeroResults` — the new state is the authoritative parse of the
  // fresh array. `listState` is now the SOLE store of the records (no parallel module-level copy).
  listState = fromArray(records);

  // Selection reduction: collapse a `plan` that genuinely VANISHED → `none`, closing the
  // ghost pane. The held gate's plan is exempt (its row can lag the write — the placeholder stands in).
  const gate = isOrchestrationActive() ? approvalGateOf(orchSnapshot) : null;
  const heldGatePlan = gate ? asAbsPath(gate.planPath) : null;
  const before = getSelection();
  setSelection(resolveSelection(before, records, prevRecords, heldGatePlan));
  if (before.k === "plan" && getSelection().k === "none") {
    // The open plan vanished — reset the pane to empty (resetToEmptyPane repaints the sidebar + bar).
    resetToEmptyPane();
  } else {
    applyFilterAndRender();
  }

  // Stale-sentinel cleanup: if the OPEN row is a resume sentinel that no longer
  // appears in the fresh records (the tree finished elsewhere, or a real row replaced the synthetic
  // one via a NON-resume path), its placeholder pane + resume banner would otherwise stay painted over
  // a dangling openPath with no matching `.active` row. Reset to the empty state so nothing stale
  // remains. GUARD the happy resume→placeholder path: when the orchestrator has minted a live-run
  // placeholder for THIS tree (runPlaceholder.treeId matches), the placeholder legitimately stands in
  // for the vanished sentinel — leave the selection/banner alone (placeholderVisible keeps the row).
  const op = openPath();
  if (op !== null && isResumeSentinel(op)) {
    const treeId = resumeSentinelTreeId(op);
    const stillListed = records.some((r) => r.absolute_path === op);
    const ph = getRunPlaceholder();
    const placeholderStandsIn = ph !== null && ph.treeId === treeId;
    if (!stillListed && !placeholderStandsIn) {
      resetToEmptyPane();
    }
  }

  // Resolve any still-unknown cwds off the main path, then late-patch the rows.
  void resolveMissingCwds(records);
}

// Reset the reading pane to the no-plan-open empty state: clear the selection (so no stale row derives
// `.active`), hide the doc header, drop any resume banner, and repaint the pane's "select a plan"
// note + clear the ToC. Idempotent. Used when a `plan` selection collapses (its file vanished) or the
// currently-open resume sentinel vanishes from the list without a placeholder taking over (see
// refreshList). `renderResumeBanner(null)` (not `refreshResumeBanner`) is used directly here — the
// selection is being cleared, so there is no record to re-derive a verdict from; the banner just hides.
function resetToEmptyPane(): void {
  setSelection({ k: "none" });
  renderResumeBanner(null);
  docHeaderEl?.classList.add("hidden");
  if (readingPaneEl) {
    readingPaneEl.classList.remove("raw");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a plan from the sidebar to read it.";
    readingPaneEl.replaceChildren(empty);
  }
  tocListEl?.replaceChildren();
  // Repaint the sidebar so the now-cleared openPath drops the stale `.active` row.
  applyFilterAndRender();
  refreshReviewBar();
}

// Find rows with no resolved cwd, ask the backend to resolve any stems we haven't already
// attempted this session (ONE call), then patch each affected row's `.plan-src` and the
// reader header. Rows stay EMPTY until this completes (no "unknown" flash). The selection,
// the attempted-stems guard, and the retry-on-thrown-error policy live in `src/resolve.ts`
// (unit-tested); a thrown error un-attempts the stems so the next plan-changed retries them.
async function resolveMissingCwds(records: PlanRecord[]): Promise<void> {
  const ran = await resolveCwds(
    records,
    cwdByStem,
    attemptedStems,
    (stems) => invoke<Record<string, string | null>>("resolve_cwds", { stems }),
    resolveAttemptCounts,
  );
  if (ran) patchAllCwds();
}

// Apply newly-resolved cwds after a `resolve_cwds` round-trip (or once the home dir arrives).
// Each record's `.plan-src` text is the DISPLAYED cwd (home-collapsed) which the filter both
// matches against and highlights, so we sync the resolved DISPLAY cwd back onto the in-memory
// records and re-run the filter render. This is what keeps a late-arriving cwd both MATCHABLE
// (the filter sees it) and HIGHLIGHTED (re-rendered through highlightVisibleRows) — satisfying
// "re-apply the filter after late cwd patches". Also refreshes the reader header for the open
// plan. Cheap; safe to call after any resolution (no-op render when there are no records).
function patchAllCwds(): void {
  // Sync the DISPLAYED cwd onto the in-memory records so the (pure, record-based) filter both
  // matches and highlights the SAME string the user sees. `planSrcText` already yields the
  // displayed value (home-collapsed path, "unknown", or "" while unresolved); store it only
  // when it is a real path so an unresolved/unknown row's `cwd` is not poisoned with a
  // non-path placeholder.
  for (const rec of currentRecords()) {
    const display = planSrcText(rec);
    if (display && display !== "unknown") rec.cwd = display as PlanRecord["cwd"];
  }
  applyFilterAndRender();
  patchDocSrc();
}

// Update the reader header `#doc-src` for the currently-open plan via the same resolved
// cache + late-patch path as the sidebar. Empty until resolved; includes the `.folder`
// accent element the existing markup/CSS expect.
function patchDocSrc(): void {
  if (!docSrcEl) return;
  const op = openPath();
  if (op === null) {
    docSrcEl.replaceChildren();
    return;
  }
  // A synthetic resume-sentinel row is not in the resolve cache (its stem is the tree_id, never
  // resolved through resolve_cwds) — its cwd rides the record's `cwd` instead. Read it from there so
  // the reader header shows the tree's cwd, not an empty string.
  const text = isResumeSentinel(op)
    ? displayCwd(currentRecords().find((r) => r.absolute_path === op)?.cwd ?? "")
    : cwdDisplayForStem(stemFromPath(op));
  docSrcEl.replaceChildren();
  if (!text) return;
  const folder = document.createElement("span");
  folder.className = "folder";
  folder.textContent = "📁";
  docSrcEl.appendChild(folder);
  const label = document.createElement("span");
  label.textContent = text;
  docSrcEl.appendChild(label);
}

// Max age (ms) before a pending review is considered STALE: its blocking hook has already timed
// out, so its request file describes a dead review whose Submit/Dismiss would be a silent no-op.
// Stale entries are filtered out of launch recovery.
const STALE_REVIEW_MS = 600_000;

// ---- Plan Review status line (DEPENDENCY-FREE in-DOM UX) ----
//
// WHY THIS REPLACES window.alert: in Tauri v2 (Wry + WKWebView on macOS) JS dialogs have no UI
// delegate — window.alert() is a no-op, so an error alert would be invisible. The review-response
// and save-for-review paths surface success/error on an in-DOM transient status line (#hook-status)
// via setHookStatus() instead. The #review-clear button keeps its own two-click confirm — that is a
// separate, destructive comment-wipe action.

// How long the #review-clear two-click confirm stays "armed" before reverting (ms), and how long a
// status message lingers before auto-clearing (ms). Module constants so the test can reason about them.
const HOOK_CONFIRM_MS = 4000;
const HOOK_STATUS_MS = 6000;

// Fire a one-shot "open in the default browser" command (open_baseline / open_prototype). This is a
// VOID fire-once command, not a data read — there is nothing to surface on success (the OS opened the
// file), so a plain try/catch is the right shape: success is silent, a FAILURE drives the visible
// #hook-status surface (not a swallowed .catch()). The raw error object is logged to preserve its stack
// in devtools, while the user-facing message stringifies it.
async function openExternally(
  command: "open_baseline" | "open_prototype",
  args: { cwd: string; path: string },
  failureLabel: string,
): Promise<void> {
  try {
    await invoke(command, args);
  } catch (e) {
    console.error(`${command} failed`, e);
    setHookStatus(hookStatusEl, `${failureLabel}: ${String(e)}`, "error");
    setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
  }
}

// Render an HTML prototype INSIDE the app. `srcdoc` has NO base URL, so a prototype referencing
// RELATIVE assets would render silently-broken — those route to the external browser instead. The
// iframe keeps `allow-same-origin` (not allow-scripts alone) so prototype scripts can touch `document`
// (many prototypes read/write the DOM on load); it is kept out of the modal focus-trap (tabindex="-1")
// because a DOM trap cannot contain focus inside a same-origin iframe.
async function openPrototypePreview(gate: PrototypeGate): Promise<void> {
  if (previewModal !== null || previewOpening) return;
  const target = prototypeOpenTarget(gate);
  if (target === null) return;
  previewOpening = true;

  let html: string;
  try {
    html = await invoke<string>("read_prototype_file", { cwd: gate.cwd, path: target });
  } catch (e) {
    previewOpening = false;
    console.error("read_prototype_file failed", e);
    setHookStatus(hookStatusEl, `Could not read prototype: ${String(e)}`, "error");
    setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
    return;
  }

  if (referencesExternalFiles(html)) {
    previewOpening = false;
    setHookStatus(hookStatusEl, "Prototype references external files — opening in browser…");
    setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
    void openExternally("open_prototype", { cwd: gate.cwd, path: target }, "Could not open prototype");
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.tabIndex = -1;
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.srcdoc = html;
  let annotate: AnnotateHandle | null = null;
  previewModal = openModal({
    label: "HTML prototype preview",
    content: iframe,
    className: "proto-preview",
    onClose: () => {
      // Persist + attach any still-pending captures BEFORE teardown so closing never drops a capture.
      // flushPending snapshots its pending set synchronously (before its first await), so firing it
      // fire-and-forget here and then destroying (which clears `captures` synchronously) cannot race.
      const handle = annotate;
      void handle?.flushPending();
      handle?.destroy();
      annotate = null;
      previewModal = null;
    },
  });
  annotate = initAnnotate({
    card: previewModal.card,
    iframe,
    invoke: <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
    now: () => performance.now(),
    onError: (message) => {
      setHookStatus(hookStatusEl, message, "error");
      setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
    },
    cwd: gate.cwd,
    attachImages: (imgs) => stageOrAttachCaptures(imgs),
  });
  previewOpening = false;
}

window.addEventListener("DOMContentLoaded", () => {
  planListEl = document.querySelector("#plan-list");
  planCountEl = document.querySelector("#plan-count");
  readerScrollEl = document.querySelector("#reader-scroll");
  readingPaneEl = document.querySelector("#reading-pane");
  docHeaderEl = document.querySelector(".doc-header");
  docFilenameEl = document.querySelector("#doc-filename");
  docSrcEl = document.querySelector("#doc-src");
  modelBarEl = document.querySelector("#model-bar");
  convModelChipEl = document.querySelector("#conversation-model-chip");
  tocListEl = document.querySelector("#toc-list");
  filterInputEl = document.querySelector("#plan-filter");
  filterClearEl = document.querySelector(".search .clear");
  searchEl = document.querySelector(".search");
  // Persistent, non-occluding review action bar (reading-pane header).
  reviewBarEl = document.querySelector("#review-bar");
  reviewBarLabelEl = document.querySelector("#review-bar-label");
  reviewSubmitEl = document.querySelector("#review-submit");
  reviewClearEl = document.querySelector("#review-clear");
  reviewResumeEl = document.querySelector("#review-resume");
  reviewApproveEl = document.querySelector("#review-approve");
  // Forced-acceptance REFINE button + sub-plan picker (ACCEPTANCE mode only).
  reviewRefineEl = document.querySelector("#review-refine");
  reviewRefineTargetEl = document.querySelector("#review-refine-target");
  // PROTOTYPE-mode controls: feedback textarea + open-in-browser button.
  prototypeFeedbackEl = document.querySelector("#prototype-feedback");
  prototypeOpenEl = document.querySelector("#prototype-open");
  prototypePreviewEl = document.querySelector("#prototype-preview");
  prototypeAttachmentsEl = document.querySelector("#prototype-attachments");
  // Working-reference checkbox: classifies the prototype approval (sketch vs floor).
  prototypeWorkingRefEl = document.querySelector("#prototype-working-ref");
  prototypeWorkingRefLabelEl = document.querySelector("#prototype-working-ref-label");
  // Capture the external Submit button's descriptive label so an in-process relabel can be reverted
  // exactly (refreshReviewBar restores this for external reviews).
  if (reviewSubmitEl?.textContent) REVIEW_SUBMIT_EXTERNAL_LABEL = reviewSubmitEl.textContent;
  // Capture #review-approve's default label so PROTOTYPE mode's relabel reverts exactly.
  if (reviewApproveEl?.textContent) REVIEW_APPROVE_DEFAULT_LABEL = reviewApproveEl.textContent;
  hookStatusEl = document.querySelector("#hook-status");

  // Inject the three non-pure sources app-state's gate accessors read, as lazy getter closures over
  // the live `let`s. MUST run before the orchestrator observer subscribes (below) and before any gate
  // accessor can fire, so the injected getters are wired first. The closures read the live bindings, so
  // this can precede the conversationHandle / prototypeAttachmentsEl assignments.
  initAppState({
    orchSnapshot: () => orchSnapshot,
    conversationHandle: () => conversationHandle,
    prototypeAttachmentsEl: () => prototypeAttachmentsEl,
    records: () => currentRecords(),
    filterQuery: () => filterQuery,
    planListEl: () => planListEl,
    planCountEl: () => planCountEl,
    modelBarEl: () => modelBarEl,
    convModelChipEl: () => convModelChipEl,
    resumeBannerEl: () => resumeBannerEl,
    resumeBannerMsgEl: () => resumeBannerMsgEl,
    resumePlanBtnEl: () => resumePlanBtnEl,
    resumeConfirmRowEl: () => resumeConfirmRowEl,
    resumeHazardEl: () => resumeHazardEl,
    toastEl: () => toastEl,
  });

  // Supply the sidebar's two cross-domain reading-pane callbacks (plan-open + Conversation-tab flip)
  // so makeSidebarCtx can wire them into the SidebarCtx without importing `./main`.
  initSidebar({
    openPlan: (path, stem) => void openPlan(path, stem),
    switchToConversationTab,
  });

  // Supply the ToC module's reading-pane / #toc-list DOM handles (its own injection seam, kept off
  // ./app-state to avoid a src/render ↔ app-state module cycle).
  initToc({
    tocListEl: () => tocListEl,
    readingPaneEl: () => readingPaneEl,
    readerScrollEl: () => readerScrollEl,
  });

  // Supply the review-bar module's bar-refresh entry point so its moved comment-count logic can
  // re-derive the bar without importing `./main`. Grown in later phases (refreshAffordances, the
  // render guard + reading-pane DOM getters).
  initReviewBar({
    refreshReviewBar,
    refreshAffordances,
    // The SINGLE shared render guard — never a fresh instance, or the "next openPlan supersedes an
    // in-flight preview" invariant breaks.
    getRenderGuard: () => renderGuard,
    getReadingPaneEl: () => readingPaneEl,
    getDocHeaderEl: () => docHeaderEl,
    getDocFilenameEl: () => docFilenameEl,
    getDocSrcEl: () => docSrcEl,
    getReaderScrollEl: () => readerScrollEl,
  });

  // Supply the ipc module's M4 plan-review handlers with the reading-pane entry points they drive,
  // so they can open/refresh/flip without importing `./main`. getHookStatusEl reads the live handle.
  initIpc({
    openReviewPlanFile,
    refreshReviewBar,
    refreshAffordances,
    switchToPlanTab,
    getHookStatusEl: () => hookStatusEl,
    hookStatusMs: HOOK_STATUS_MS,
  });

  // Supply the plan-flow sink with the main-resident DOM handles + compose sites its open/reload/gate
  // flows drive, so it never imports `./main`. Injected via LIVE getters (getLoadPlanHistory reads a
  // main `let` assigned ASYNC inside initConversation(...).then below — a by-value capture would freeze
  // null). MUST run before any openPlan/handlePlanChanged can fire (the plan-changed listen + launch
  // recovery below).
  initPlanFlow({
    getLoadPlanHistory: () => loadPlanHistory,
    // The SINGLE shared render guard — never a fresh instance, or the "next openPlan supersedes an
    // in-flight render" invariant breaks.
    getRenderGuard: () => renderGuard,
    getHookStatusEl: () => hookStatusEl,
    getReadingPaneEl: () => readingPaneEl,
    getReaderScrollEl: () => readerScrollEl,
    getPlanListEl: () => planListEl,
    getDocHeaderEl: () => docHeaderEl,
    getDocFilenameEl: () => docFilenameEl,
    getTocListEl: () => tocListEl,
    patchDocSrc,
    markViewed,
    refreshList,
    resolveReview,
    switchToPlanTab,
    refreshReviewBar,
    refreshAffordances,
    pendingSurfaces,
    currentRecords,
    hookStatusMs: HOOK_STATUS_MS,
  });

  // Resume banner: resolve its handles + wire the resume button. A separate surface from the
  // review bar, but the LOWEST affordance (precedence — refreshAffordances suppresses it
  // while the bar shows a higher one). The button reads `pendingResume` (set by renderResumeBanner) and
  // drives getOrchestrator().resume(). The toast element is the resume_fallback notice target.
  resumeBannerEl = document.querySelector("#resume-banner");
  resumeBannerMsgEl = document.querySelector("#resume-banner-msg");
  resumePlanBtnEl = document.querySelector("#resume-plan-btn");
  resumePlanBtnEl?.addEventListener("click", () => void resumeFromBanner());
  // The HAZARDOUS-resume inline confirm row (hazard text + Confirm/Cancel). The primary
  // button reveals it (resumeFromBanner) for a requiresConfirm verdict; Confirm fires resume()
  // (executeResume), Cancel collapses back to the one-click button (cancelResumeConfirm).
  resumeConfirmRowEl = document.querySelector("#resume-confirm");
  resumeHazardEl = document.querySelector("#resume-hazard");
  resumeConfirmBtnEl = document.querySelector("#resume-confirm-btn");
  resumeCancelBtnEl = document.querySelector("#resume-cancel-btn");
  resumeConfirmBtnEl?.addEventListener("click", () => void executeResume());
  resumeCancelBtnEl?.addEventListener("click", () => cancelResumeConfirm());
  toastEl = document.querySelector("#toast");

  // Wire the sidebar filter (Plans tab only). Typing re-renders the filtered Plans list from
  // the in-memory records (no IPC per keystroke); the ✕ button clears the query and re-renders.
  // The `.has-text` class on `.search` reveals the clear button (CSS) only when there is text.
  if (filterInputEl) {
    filterInputEl.addEventListener("input", () => {
      filterQuery = filterInputEl?.value ?? "";
      searchEl?.classList.toggle("has-text", filterQuery.trim().length > 0);
      applyFilterAndRender();
    });
  }
  if (filterClearEl) {
    filterClearEl.addEventListener("click", () => {
      filterQuery = "";
      if (filterInputEl) {
        filterInputEl.value = "";
        filterInputEl.focus();
      }
      searchEl?.classList.remove("has-text");
      applyFilterAndRender();
    });
  }

  // Wire the Plans/Contents tab switching. Default-active tab is Plans (set in index.html);
  // opening/reloading a plan rebuilds the ToC silently without changing the active tab.
  const tabRowEl = document.querySelector<HTMLElement>(".tab-row");
  const tabPlansEl = document.querySelector<HTMLElement>("#tab-plans");
  const tabContentsEl = document.querySelector<HTMLElement>("#tab-contents");
  if (tabRowEl && tabPlansEl && tabContentsEl) {
    initTabs(tabRowEl, [tabPlansEl, tabContentsEl]);
  }
  // Nothing-open initial state: #toc-list stays blank (NOT the "No headings"
  // affordance — that is reserved for an OPEN plan with zero headings).

  // ---- reading-pane [Plan | Conversation] tab row + conversation domain ----
  // The reader tab row is a SECOND .tab-row; we select it by its specific .reader-tab-row class
  // so this never grabs the sidebar's (first) .tab-row, and the sidebar contract TOKENS
  // (data-tab="plans"/id="tab-plans") are unaffected. initTabs is the same generic toggle.
  // Resolve the hoisted module-scope reading-pane tab handles (used by switchToConversationTab /
  // switchToPlanTab — main.ts owns this tab for the in-process review case).
  readerTabRowEl = document.querySelector<HTMLElement>(".reader-tab-row");
  tabPlanPaneEl = document.querySelector<HTMLElement>("#tab-plan");
  tabConversationEl = document.querySelector<HTMLElement>("#tab-conversation");
  if (readerTabRowEl && tabPlanPaneEl && tabConversationEl) {
    initTabs(readerTabRowEl, [tabPlanPaneEl, tabConversationEl]);
    // User-click path: initTabs (generic, also used by the sidebar) toggles .active but knows nothing
    // about the minimap. Hook the Conversation tab's own click so the minimap repaints whenever the
    // user reveals the pane. initTabs's click listener runs on the SAME event and has already added
    // .active synchronously; the rAF defers the repaint until layout settles after the display toggle.
    // Guarded on the handle (null until initConversation resolves); refreshMinimap no-ops without a
    // minimap element. (The programmatic switchToConversationTab path repaints separately.)
    const conversationTabBtn = readerTabRowEl.querySelector<HTMLElement>('.tab[data-tab="conversation"]');
    conversationTabBtn?.addEventListener("click", () => {
      requestAnimationFrame(() => conversationHandle?.refreshMinimap());
    });
  }

  // Initialize the conversation domain: subscribes the 5 agent events, drives stream->render,
  // owns cancel + teardown. main.ts only hands it DOM handles + a tab-switch callback. The
  // composer modal + status pill live entirely inside the domain. Disjoint from the sidebar +
  // src/render/* — this is the single convergence point.
  void initConversation(
    {
      stream: document.querySelector<HTMLElement>("#conversation-stream"),
      // Right-margin minimap gutter (sibling of #conversation-stream). The controller no-ops if null.
      minimap: document.querySelector<HTMLElement>("#conversation-minimap"),
      // Stop (full-stop) — kept under its legacy id #conversation-cancel.
      cancelBtn: document.querySelector<HTMLButtonElement>("#conversation-cancel"),
      stopBtn: document.querySelector<HTMLButtonElement>("#conversation-cancel"),
      // Pause (interrupt the turn only) / Resume (continue the idle session). The 3-state machine in
      // initConversation derives their enabled/disabled state purely from SessionState.
      pauseBtn: document.querySelector<HTMLButtonElement>("#conversation-pause"),
      resumeBtn: document.querySelector<HTMLButtonElement>("#conversation-resume"),
      // New-plan button — the conversation controller disables it while a session is live.
      newPlanBtn: document.querySelector<HTMLButtonElement>("#new-plan-btn"),
      // Free-text message composer (human-in-the-loop) — enabled while a session is live.
      messageInput: document.querySelector<HTMLTextAreaElement>("#conversation-input-field"),
      sendBtn: document.querySelector<HTMLButtonElement>("#conversation-send"),
      // Multimodal image input for the in-conversation follow-up surface.
      attachStrip: document.querySelector<HTMLElement>("#conversation-attachments"),
      attachBtn: document.querySelector<HTMLElement>("#conversation-attach"),
      fileInput: document.querySelector<HTMLInputElement>("#conversation-file-input"),
      attachError: document.querySelector<HTMLElement>("#conversation-attach-error"),
      composer: {
        modal: document.querySelector<HTMLElement>("#composer-modal"),
        request: document.querySelector<HTMLTextAreaElement>("#composer-request"),
        dirField: document.querySelector<HTMLInputElement>("#composer-dir"),
        chooseDirBtn: document.querySelector<HTMLButtonElement>("#composer-choose-dir"),
        // Build mode removed — the composer is plan-only; no #composer-mode toggle exists.
        modeToggle: null,
        startBtn: document.querySelector<HTMLButtonElement>("#composer-start"),
        cancelBtn: document.querySelector<HTMLButtonElement>("#composer-cancel"),
        // Start reads the paste-token field so a typed-but-unsaved token is honored, and surfaces
        // failures inline (never a silent no-op).
        tokenInput: document.querySelector<HTMLInputElement>("#composer-token"),
        error: document.querySelector<HTMLElement>("#composer-error"),
        // Multimodal image input — chip strip, attach button, and hidden file input. Attach-time
        // rejections reuse #composer-error (passed as errorEl when the attachments controller is built).
        attachStrip: document.querySelector<HTMLElement>("#composer-attachments"),
        attachBtn: document.querySelector<HTMLElement>("#composer-attach"),
        fileInput: document.querySelector<HTMLInputElement>("#composer-file-input"),
        // Auto-resume-after-quota select. The composer self-persists its value on change;
        // the chosen budget is read at Start by the orchestrator's defaultDeps adapter.
        autoResume: document.querySelector<HTMLSelectElement>("#composer-auto-resume"),
      },
      status: {
        pill: document.querySelector<HTMLElement>("#sdk-status"),
        authBlock: document.querySelector<HTMLElement>("#composer-auth"),
        tokenInput: document.querySelector<HTMLInputElement>("#composer-token"),
        tokenSubmit: document.querySelector<HTMLButtonElement>("#composer-token-submit"),
        // Shared inline error line — "Save token" failures surface here (same element the
        // composer's Start path uses).
        error: document.querySelector<HTMLElement>("#composer-error"),
      },
    },
    // onActivity: every non-result stream frame fires this. While an approval gate is
    // held (snapshot's pendingGate is of kind "approval"), the flip is SUPPRESSED so streaming frames cannot steal
    // the tab from the Plan view the gate handler just opened. A "clarify"-kind gate deliberately does NOT
    // suppress — AskUserQuestion cards render in the Conversation tab and need the flip.
    () => {
      if (suppressConversationFlip(orchSnapshot)) return;
      switchToConversationTab();
    },
  )
    .then((handle) => {
      conversationHandle = handle;
      // Expose the resolve-time clear to the module-level resolve paths (resolveReview + the
      // orchestrator gate handlers).
      notifyPermissionResolved = (toolUseId) => handle.notifyPermissionResolved(toolUseId);
      echoUserMessage = (text) => handle.echoUserMessage(text);
      surfaceMessage = (text) => handle.surfaceMessage(text);
      // Expose the silent plan-history reconstruction to openPlan (module-level). Fire-and-forget.
      loadPlanHistory = (stem) => void handle.loadHistoryForPlan(stem);
      // Wire the titlebar "+ New plan" button to open the composer modal.
      const newPlanBtn = document.querySelector<HTMLElement>("#new-plan-btn");
      newPlanBtn?.addEventListener("click", () => handle.openComposer());
    })
    .catch((e) => console.error("initConversation failed", e));

  // ---- approval-gate controller (observer-driven) -------------------------------
  // Subscribe to the SHARED orchestrator instance. We
  // hold the latest snapshot in `orchSnapshot` and drive the approval bar off it:
  //   • onAwaitingApproval(gate) — a sub-plan is awaiting approval: open its plan file via the NORMAL
  //     plan flow, flip to the Plan tab, and refresh the bar (mirrors openReviewPlanFile + switchToPlanTab).
  //   • onSnapshot — re-derive the bar after every transition (so it clears when the approval-kind
  //     pendingGate becomes null after Approve).
  //   • onDone / onFatal — terminal: drop the snapshot and refresh (the bar hides).
  // This observer is a closure inside DOMContentLoaded that mutates the orchSnapshot singleton and the
  // bar DOM handles.
  getOrchestrator().subscribe(
    createGateObserver({
      setOrchSnapshot: (snap) => {
        orchSnapshot = snap;
      },
      getConversationHandle: () => conversationHandle,
      isOrchestrationActive,
      getRunPlaceholder,
      setRunPlaceholder,
      getSelection,
      setSelection,
      clearStagedGateCaptures,
      applyFilterAndRender,
      badgeSignature,
      renderModelBar,
      renderModelChip,
      refreshAffordances,
      refreshReviewBar,
      openGatePlanFile,
      switchToPlanTab,
      renderPrototypePreview,
      openPrototypePreview,
      diag,
    }),
  );

  // End the agent session on window unload so quitting never leaves an orphaned run.
  window.addEventListener("beforeunload", () => {
    void conversationHandle?.teardown();
  });

  // Wire the custom overlay titlebar for window drag + double-click-to-zoom.
  initTitlebar();
  // Wire the icon-only dark/light theme toggle in the titlebar-controls slot.
  initThemeToggle(document.querySelector("#theme-toggle"));
  // Wire the A−/A+ reading-pane text-size steppers (left of the theme toggle).
  initTextSize(
    document.querySelector("#text-dec"),
    document.querySelector("#text-inc"),
    document.documentElement,
    localStorage,
    readingPaneEl,
  );
  // wire the highlight/comment feature behind the render facade. main.ts only
  // hands the pane element + a LIVE openPath reader + the IO adapters to the facade — it never
  // reaches into #reading-pane for this feature. The facade fires onCommentCountChanged after a
  // save/clear mutation; main.ts refreshes the (backend-owned) count in response.
  if (readingPaneEl) {
    // Comments are ALWAYS the open plan's normal persisted comments now (Option A): a reviewed plan
    // is a real file, so its comments key off its real path and persist to comments.json like any
    // other plan. There is no synthetic review store. The IO is the plain backend invoke path.
    // Each adapter is the plain backend invoke. The facade parses these arrays into its PATH-KEYED
    // RemoteData<CommentRecord[]> model (fromArray at the IO boundary) — the single source of truth
    // for comments — so no second comment-list model lives here.
    const commentsIo: CommentsIO = {
      load: (p) => invoke<CommentRecord[]>("get_comments", { path: p }),
      save: (p, c) => invoke<CommentRecord[]>("set_comments", { path: p, comments: c }),
      clearAll: (p) => invoke<CommentRecord[]>("clear_comments", { path: p }),
    };
    // The comment-path reader is simply the open plan's real path.
    initComments(readingPaneEl, openPath, commentsIo);
    // The facade hands us the MUTATED path + AUTHORITATIVE post-mutation count after an in-session
    // save/clear. Route to applyCommentCount (the Prompt-Feedback badge path, guarded to the open
    // plan), which also re-derives the #review-bar — so if the open plan IS a review, Submit enables
    // on the first comment.
    onCommentCountChanged((path, count) => {
      applyCommentCount(asAbsPath(path), count);
    });
  }

  // ---- Review action bar wiring (the persistent, non-occluding, resumable affordance) ----
  // Unconditional: the review bar is the sole surface for acting on a pending plan review now that
  // the old titlebar "Prompt Feedback" button + overlay are gone (commenting goes through the
  // conversation composer + this bar). The individual `reviewXEl?.addEventListener` guards keep it
  // safe when a given button is absent (e.g. under unit tests with a partial DOM).
  {
    //   Submit  → deny + the assembled feedback prompt for the VIEWED review → Claude revises.
    //   Approve → (in-process reviews only, #review-approve) allow the held plan + begin building.
    //   Resume  → re-open the NEWEST pending review (summary mode → viewing mode).
    reviewSubmitEl?.addEventListener("click", () => {
      // EXACTLY-ONCE: a review action (submit OR the sibling approve) is already in flight.
      // Bail BEFORE any branch runs so a fast double-click — or a cross click after an Approve — cannot
      // start a second dispatch. This early-return is the invariant; the "submitting" disabled state
      // (refreshReviewBar) is only the visual half and is not relied upon (a disabled button still
      // receives a programmatically dispatched click, and the prototype/acceptance/summary submit paths
      // are not disabled by the derivation at all).
      // INVARIANT[exactly-once-action-dispatch] (runtime-guard): the top-of-handler early-return bails whenever a sibling action is already dispatching, before any branch runs.
      //   prevents: a fast double-click on Submit/Approve, or a cross-click, starting a second dispatch
      if (actionInFlight !== "none") return;
      // UNIFIED GATE: "Request changes" on the orchestrator's held gate — decomposition (root
      // included) OR leaf — routes into the ONE handle method requestChanges(pathKey, feedback). The
      // kind-routing (deny-resumes-the-decomposition-turn vs re-draft-the-leaf-in-place) lives in the
      // orchestrator's exhaustive gate.kind switch, NOT here. Build the feedback from the OPEN plan's
      // comments EXACTLY like the legacy in-process deny path, then clear them only on a successful
      // dispatch (they've been consumed into the feedback).
      const gate = viewingGate();
      if (gate) {
        const planPath = openPath();
        if (reviewSubmitEl?.disabled || planPath === null) return; // disabled at 0 comments
        // INVARIANT[lock-set-after-guard-before-await] (runtime-guard): the lock is taken only after this branch's validation guard has passed, and before the branch's first await.
        //   prevents: a guard-rejected click sticking the lock and freezing the bar
        actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.
        refreshReviewBar();
        void (async () => {
          try {
            let records: CommentRecord[] = [];
            try {
              // RemoteData<CommentRecord[]> at the IO boundary (fromArray), collapsed to the
              // feedback array. Both empty and error yield [] (the catch preserves fault tolerance).
              records = unwrapOr(fromArray(await invoke<CommentRecord[]>("get_comments", { path: planPath })), []);
            } catch (e) {
              console.error("get_comments failed", e);
            }
            try {
              await getOrchestrator().requestChanges(pathKey(gate.path), buildFeedbackPrompt(records));
              // The held ExitPlanMode was resolved (deny + feedback) — drop the waiting label NOW.
              notifyPermissionResolved?.(gate.toolUseId);
            } catch (e) {
              // Surface the failure — the session may have ended. The return skips clearAllComments
              // below, so the submitted comments are preserved for a retry.
              console.error("orchestrator gate: requestChanges failed", e);
              surfaceMessage?.("Couldn't send your changes — the session may have ended. Try again.");
              return;
            }
            // Dispatch succeeded — echo a STRUCTURED, human-readable view of the comments the user
            // submitted (one line per comment: anchor quote + comment text). NOT the wrapped
            // buildFeedbackPrompt output (that is system text). Only after the send succeeded.
            echoUserMessage?.(echoCommentsText(records));
            if (readingPaneEl) await clearAllComments(readingPaneEl, planPath);
          } finally {
            // INVARIANT[lock-reset-on-every-exit] (runtime-guard): the finally returns actionInFlight to "none" on every exit path once a dispatched round-trip settles.
            //   prevents: a failed dispatch leaving the lock stuck and permanently blocking actions
            actionInFlight = "none";
            refreshReviewBar();
          }
        })();
        return;
      }
      // PROTOTYPE mode: "Request changes" on the held visual-prototype gate requires
      // non-empty feedback (#prototype-feedback) and routes into refinePrototype(feedback) — the
      // driver loops the root back to clarifying-intent and sends the refine prompt. The textarea
      // clears AFTER a successful dispatch (the feedback was consumed into the prompt).
      const protoGate = activePrototypeGate();
      if (protoGate) {
        const feedback = prototypeFeedbackEl?.value.trim() ?? "";
        if (reviewSubmitEl?.disabled || feedback === "") return;
        // Snapshot the staged captures NOW (before the async gap) so a mid-flight edit can't change
        // what rides this send. On success exactly this slice is spliced out (below); on failure it's
        // left in place — refinePrototype consumes the gate before the send, so a rejected send leaves
        // the snapshot lingering hidden until the run ends or the next begins.
        const images = stagedGateCapturesSnapshot();
        actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.
        refreshReviewBar();
        void (async () => {
          try {
            try {
              if (images.length) await getOrchestrator().refinePrototype(feedback, { images });
              else await getOrchestrator().refinePrototype(feedback);
            } catch (e) {
              // Surface the failure — the session may have ended. The textarea is NOT cleared (the
              // return skips the clear below) so the typed feedback survives; the snapshot is not
              // spliced here — the gate was already consumed, so it lingers hidden until run-end.
              console.error("prototype gate: refinePrototype failed", e);
              surfaceMessage?.("Couldn't send your changes — the session may have ended. Try again.");
              return;
            }
            // Success path only (the catch above returned): echo the feedback, clear the textarea, and
            // splice out exactly the captures that rode this send.
            echoUserMessage?.(feedback);
            if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
            removeStagedGateCaptures(images);
          } finally {
            actionInFlight = "none";
            refreshReviewBar();
          }
        })();
        return;
      }
      // ACCEPTANCE mode: "Accept divergence…" on the held acceptance gate requires a
      // non-empty REASON (#prototype-feedback, reused) and routes into divergeAcceptance(reason) —
      // the run finalizes (notifyDone) AND the reason is persisted as the audit trail for the waived
      // floor. The textarea clears AFTER a successful dispatch.
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        const reason = prototypeFeedbackEl?.value.trim() ?? "";
        if (reviewSubmitEl?.disabled || reason === "") return;
        actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.
        refreshReviewBar();
        void (async () => {
          try {
            try {
              await getOrchestrator().divergeAcceptance(reason);
            } catch (e) {
              // Surface the failure — the session may have ended. The return skips clearing the
              // textarea below, so the typed reason is preserved for a retry.
              console.error("acceptance gate: divergeAcceptance failed", e);
              surfaceMessage?.("Couldn't send your acceptance — the session may have ended. Try again.");
              return;
            }
            echoUserMessage?.(`Accepted divergence from the baseline: ${reason}`);
            if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
            switchToConversationTab();
          } finally {
            actionInFlight = "none";
            refreshReviewBar();
          }
        })();
        return;
      }
      const reviewId = currentReviewId();
      const planPath = openPath();
      if (reviewSubmitEl?.disabled || reviewId === null || planPath === null) return; // disabled at 0 comments
      // Assemble the reason from the OPEN plan's persisted comments (the same gathering the overlay
      // Copy uses), then deny. ORDER MATTERS: build the reason from the comments FIRST, send the deny,
      // and ONLY on success CLEAR the comments (they've been consumed into the feedback). The plan
      // stays open + selected; clearing wipes its persisted comments + in-pane highlights.
      actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.
      refreshReviewBar();
      void (async () => {
        try {
          let records: CommentRecord[] = [];
          try {
            // RemoteData<CommentRecord[]> at the IO boundary (fromArray), collapsed to the feedback
            // array. Both empty and error yield [] (the catch preserves fault tolerance).
            records = unwrapOr(fromArray(await invoke<CommentRecord[]>("get_comments", { path: planPath })), []);
          } catch (e) {
            console.error("get_comments failed", e);
          }
          const sent = await resolveReview(reviewId, "deny", buildFeedbackPrompt(records));
          // Clear the submitted plan's comments only AFTER the deny landed (the feedback carried them).
          // facade clearAllComments removes highlights for planPath, clears the backend (clear_comments),
          // and fires onCommentCountChanged → the count + review bar refresh to zero. planPath is still
          // the open plan (we just submitted it), so its highlights visibly disappear.
          if (sent && readingPaneEl) {
            await clearAllComments(readingPaneEl, planPath);
          }
        } finally {
          actionInFlight = "none";
          refreshReviewBar();
        }
      })();
    });
    reviewResumeEl?.addEventListener("click", () => resumeNewestReview());

    // ---- #review-approve (in-process ONLY): single-click Approve & Build -----------------------
    // One click allows the held ExitPlanMode plan and begins execution (no confirm step). This is the
    // SOLE path that reaches resolve_tool_permission(allow). resolveReview (in-process allow) round-
    // trips the review's toolUseId, sets the session to acceptEdits, and flips to the Conversation tab.
    reviewApproveEl?.addEventListener("click", () => {
      // (sibling) — EXACTLY-ONCE: a review action (the sibling submit OR a prior approve) is
      // already in flight. Bail BEFORE any branch runs so a fast double-click on Approve — or a cross
      // click after Submit — cannot start a second dispatch. Mirrors the submit handler's guard;
      // approve is correctness-only (no visual change), so the flag is NOT fed into the bar derivation.
      if (actionInFlight !== "none") return;
      // UNIFIED GATE: ONE Approve button, ONE handle method — approve(pathKey(gate.path)). The
      // dangerous routing (a decomposition approval arms the resuming hold + interrupts; a leaf
      // approval resolves + arms exec and never interrupts) lives in the orchestrator's exhaustive
      // gate.kind switch, NOT here. Flip to the Conversation tab so the next turn streams in place.
      const gate = viewingGate();
      if (gate) {
        actionInFlight = "approve"; // lock BEFORE the first await; reset in finally on EVERY exit.
        void (async () => {
          try {
            await getOrchestrator().approve(pathKey(gate.path));
            // The held ExitPlanMode was resolved — drop the waiting-for-input label NOW (the
            // orchestrator's next frames lag the click).
            notifyPermissionResolved?.(gate.toolUseId);
            switchToConversationTab();
          } catch (e) {
            // Surface the failure — the session may have ended.
            console.error("orchestrator gate: approve failed", e);
            surfaceMessage?.("Couldn't send your approval — the session may have ended. Try again.");
          } finally {
            actionInFlight = "none";
          }
        })();
        return;
      }
      // PROTOTYPE mode: approve the held visual prototype — always enabled ("Approve
      // visual"; "Proceed as-is" from round 3). approvePrototype() composes + writes INTENT.md and
      // continues into recon; the next snapshot (pendingGate nulled) reverts the bar. Flip to
      // the Conversation tab so the recon turn streams in place (mirrors the approval-gate flow).
      // The prototype gate resolves by TURN COMPLETION (no held tool → no notifyPermissionResolved).
      const protoGate = activePrototypeGate();
      if (protoGate) {
        // ADAPTIVE approve: with non-empty feedback typed, this is the COMBINED apply-and-approve —
        // refinePrototype(feedback, { autoApprove: true }) loops the prototype back to apply the
        // feedback, then the driver auto-advances to recon WITHOUT another review round. With an
        // empty textarea it is the plain approvePrototype() (straight to recon, no echo).
        const feedback = prototypeFeedbackEl?.value.trim() ?? "";
        // WORKING-REFERENCE classification: read the checkbox ONLY on the plain-approve
        // branch. With feedback typed (combined apply-and-approve) the prototype is still being
        // refined — it is not yet the final artifact — so the floor classification does not apply
        // there; the user re-checks it on the round they actually approve as-is.
        const asWorkingReference = prototypeWorkingRefEl?.checked === true;
        // Snapshot the staged captures NOW (before the async gap). Annotations are feedback even on
        // approval, so they ride both the combined apply-and-approve refine send and the plain approve's
        // recon send. On success this slice is spliced out (below); on failure it's left in place (the
        // dispatch consumes the gate before the send, so run-end clears it).
        const images = stagedGateCapturesSnapshot();
        actionInFlight = "approve"; // lock BEFORE the first await; reset in finally on EVERY exit.
        void (async () => {
          try {
            if (feedback !== "") {
              await getOrchestrator().refinePrototype(feedback, images.length ? { autoApprove: true, images } : { autoApprove: true });
              // Success path only: echo the feedback, clear the textarea, and splice out exactly the
              // captures that rode this send.
              echoUserMessage?.(feedback);
              if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
              removeStagedGateCaptures(images);
              refreshReviewBar();
            } else {
              await getOrchestrator().approvePrototype(images.length ? { asWorkingReference, images } : { asWorkingReference });
              // Reset the checkbox so a later prototype gate (a fresh run) opens unchecked.
              if (prototypeWorkingRefEl) prototypeWorkingRefEl.checked = false;
              removeStagedGateCaptures(images);
            }
            switchToConversationTab();
          } catch (e) {
            // Surface the failure — the session may have ended. On the combined apply-and-approve branch
            // the textarea was NOT yet cleared (echo/clear run only after the await resolves), so the
            // typed feedback survives; the snapshot is left in place (the gate is already consumed).
            console.error("prototype gate: apply-and-approve failed", e);
            surfaceMessage?.("Couldn't send your approval — the session may have ended. Try again.");
          } finally {
            actionInFlight = "none";
          }
        })();
        return;
      }
      // ACCEPTANCE mode: the Approve button is "Accept (meets baseline)" → approveAcceptance().
      // The build clears the baseline floor; the deferred finalize runs (notifyDone) and the next
      // snapshot (pendingGate nulled) reverts the bar. The verdict resolves the gate by an
      // explicit action — no held tool to clear.
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        actionInFlight = "approve"; // lock BEFORE the first await; reset in finally on EVERY exit.
        void (async () => {
          try {
            await getOrchestrator().approveAcceptance();
            switchToConversationTab();
          } catch (e) {
            // Surface the failure — the session may have ended.
            console.error("acceptance gate: approve failed", e);
            surfaceMessage?.("Couldn't send your acceptance — the session may have ended. Try again.");
          } finally {
            actionInFlight = "none";
          }
        })();
        return;
      }
      const reviewId = currentReviewId();
      if (reviewId === null) return;
      actionInFlight = "approve"; // lock BEFORE the first await; reset on settle (every exit).
      void resolveReview(reviewId, "allow", "").finally(() => {
        actionInFlight = "none";
      });
    });

    // ---- #prototype-feedback / #prototype-open (PROTOTYPE mode only) ---------------
    // Typing re-derives the bar so "Request changes" enables on the first non-whitespace character
    // (and re-disables when cleared). Cheap: refreshReviewBar is a pure DOM re-derivation.
    prototypeFeedbackEl?.addEventListener("input", () => refreshReviewBar());
    // Open the HTML prototype in the default browser: the gate's index.html path when present,
    // else its first path (pure prototypeOpenTarget; paths may be relative — the open_prototype
    // Rust command resolves them against the gate's cwd and containment-guards the result).
    prototypeOpenEl?.addEventListener("click", () => {
      // ACCEPTANCE mode: the relabeled "Open baseline" button → open_baseline (the gate's
      // openTarget relative to <cwd>/.plan-tree/baseline/, containment-guarded Rust-side). Checked
      // FIRST so it wins while the acceptance gate is held (the prototype gate cannot co-exist).
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        const target = acceptGate.openTarget ?? "index.html";
        void openExternally("open_baseline", { cwd: acceptGate.cwd, path: target }, "Could not open baseline");
        return;
      }
      const gate = activePrototypeGate();
      if (!gate) return;
      const target = prototypeOpenTarget(gate);
      if (target === null) return;
      void openExternally("open_prototype", { cwd: gate.cwd, path: target }, "Could not open prototype");
    });

    prototypePreviewEl?.addEventListener("click", () => {
      const gate = activePrototypeGate();
      if (!gate || gate.kind !== "html") return;
      void openPrototypePreview(gate);
    });

    // ---- #review-refine (ACCEPTANCE mode only): re-plan the picked sub-plan -----------
    // The THIRD acceptance action. Reads the picked target from #review-refine-target and routes it
    // into refineAcceptance(parsePathKey(target)) — the driver resets that sub-plan + its
    // right-siblings and re-runs them (the acceptance gate re-arms on re-completion). Flip to the
    // Conversation tab so the re-run streams in place; the next snapshot (pendingGate nulled)
    // reverts the bar out of ACCEPTANCE mode while the re-execution runs.
    reviewRefineEl?.addEventListener("click", () => {
      const acceptGate = activeAcceptanceGate();
      if (!acceptGate) return;
      const value = reviewRefineTargetEl?.value ?? "";
      if (value === "") return; // no sub-plan picked (empty picker)
      let target;
      try {
        target = parsePathKey(value);
      } catch (e) {
        console.error("acceptance gate: invalid refine target pathKey", value, e);
        return;
      }
      void (async () => {
        try {
          await getOrchestrator().refineAcceptance(target);
        } catch (e) {
          console.error("acceptance gate: refineAcceptance failed", e);
          return;
        }
        echoUserMessage?.(`Refining sub-plan ${value} (resetting it and its right-siblings to re-run)`);
        switchToConversationTab();
        refreshReviewBar();
      })();
    });

    // ---- #review-clear: discoverable MANUAL clear during review (two-click confirm) ----
    // The bar offers a "Clear comments" button (visible in viewing mode with >=1 comment). It uses
    // the SAME dependency-free two-click "click again to confirm" pattern as the hook-setup buttons
    // (window.confirm is inert in this WebView): clearAllComments(pane, openPath) removes the plan's
    // highlights, clears the backend, and fires onCommentCountChanged → the bar refreshes (the button
    // hides at 0). Single click only ARMS (no clear); the second click clears.
    if (reviewClearEl) {
      const clearLabel = reviewClearEl.textContent ?? "Clear comments";
      let armed = false;
      let revertTimer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        armed = false;
        reviewClearEl?.classList.remove("confirming");
        if (reviewClearEl) reviewClearEl.textContent = clearLabel;
        if (revertTimer !== null) {
          clearTimeout(revertTimer);
          revertTimer = null;
        }
      };
      // Expose disarm so refreshReviewBar can cancel a pending confirm when the button hides.
      reviewClearDisarm = disarm;
      reviewClearEl.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          reviewClearEl?.classList.add("confirming");
          if (reviewClearEl) reviewClearEl.textContent = "Click again to confirm";
          revertTimer = setTimeout(disarm, HOOK_CONFIRM_MS);
          return;
        }
        disarm();
        const op = openPath();
        if (readingPaneEl && op !== null) {
          void clearAllComments(readingPaneEl, op);
        }
      });
    }
  }

  // The titlebar Install/Remove plan-review hook buttons were removed (the app drives Claude
  // in-process). The install_hook/uninstall_hook/hook_status Tauri commands remain backend-only.

  if (docHeaderEl) docHeaderEl.classList.add("hidden"); // hide until a plan is opened
  if (readingPaneEl) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a plan from the sidebar to read it.";
    readingPaneEl.appendChild(empty);
  }

  // Fetch the home dir once (for `~/…` collapse). On success, re-patch any already-rendered
  // rows so a list that resolved before the home dir arrived still collapses.
  void homeDir()
    .then((h) => {
      setHomePath(h.endsWith("/") ? h.slice(0, -1) : h);
      patchAllCwds();
    })
    .catch((e) => console.error("homeDir failed (cwd shown verbatim)", e));

  void refreshList();

  // Live file-watch: re-list always; live-reload the open plan if it changed.
  // Serialize handler bodies on a single promise chain so a burst of `plan-changed`
  // events runs one-at-a-time (no interleaved refreshList/reloadOpenPlan); the
  // render-generation guard then ensures only the latest reload mutates the pane.
  let pending: Promise<void> = Promise.resolve();
  void listen<PlanChanged>("plan-changed", (event) => {
    const changedPath = asAbsPath(event.payload.path);
    // chainHandler appends this event's body to the serialized chain with a .catch backstop,
    // so a single failed handler can't wedge the chain rejected and drop ALL future events.
    pending = chainHandler(pending, () => handlePlanChanged(changedPath));
  });

  // ---- Plan Review event listeners (mirror plan-changed's serialized chain) ----
  // Review events are serialized on their OWN chain (separate from plan-changed) so a request and
  // a cancel can't interleave their async open/refresh. chainHandler's .catch backstop keeps
  // a single failed handler from wedging the chain.
  let reviewPending: Promise<void> = Promise.resolve();

  void listen<ReviewRequested>("plan-review-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleReviewRequested(payload));
  });
  void listen<ReviewCancelled>("plan-review-cancelled", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, async () => handleReviewCancelled(payload));
  });

  void listen<ToolPermissionRequested>("tool-permission-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleToolPermissionRequested(payload));
  });

  // ---- lifecycle purge of in-process reviews -------------------------------------
  // On agent-exit / fatal agent-error / user cancel the SDK seam is dead, so any held in-process review
  // must be purged (an Approve after the session died must be impossible). The conversation facade owns
  // its OWN listeners for these events (stream rendering); these are SEPARATE listeners purely for the
  // review-state purge. agent-error purges only when fatal (a non-fatal error keeps the seam alive).
  void listen<AgentExit>("agent-exit", () => {
    // QUOTA-PAUSE RECONCILIATION. A quota wall makes the sidecar gracefulExit(0), so
    // this agent-exit can be a QUOTA PAUSE exit, not a genuine end-of-run. During a pause the run is
    // NOT over — the orchestrator will respawn a session and re-issue the interrupted turn (which may
    // be mid-ExitPlanMode review). So this listener must NOT destructively tear that state down:
    //   • SKIP purgeInprocReviews() — a held in-process ExitPlanMode review must survive the pause so
    //     the resumed turn can still resolve it. (purgeInprocReviews exists to drop reviews whose SDK
    //     seam is permanently dead; during a pause the seam is coming back.)
    //   • SKIP the live-run placeholder clear — the placeholder belongs to the still-paused run.
    // Quota-paused is detected via the orchestrator's quotaPaused() probe, which is SYNCHRONOUSLY
    // correct: the conversation facade's agent-stream listener calls the handle's
    // markQuotaPausePending() the instant a quota_exceeded frame is seen, so quotaPaused() is true
    // from that tick onward — through the microtask-deferred QUOTA_PAUSED dispatch and the auto-resume
    // — NOT only after the deferred dispatch drains. This closes the same-tick race where a
    // quota_exceeded frame and an agent-exit arrive in the SAME tick: without the pending flag,
    // quotaPaused() would still read false here and we would destructively purgeInprocReviews() during
    // a pause, dropping a held in-process ExitPlanMode review the resumed turn still needs.
    // shouldClearPlaceholderOnExit ALREADY no-ops while the active orchestration's treeId matches the
    // placeholder's, but we gate explicitly so the intent is unambiguous and the purge is skipped too.
    if (isOrchestrationActive() && getOrchestrator().quotaPaused()) return;
    purgeInprocReviews();
    // Live-run placeholder clear — the SAFE variant. agent-exit reports an SDK SESSION
    // ending, which is NOT 1:1 with the placeholder's run: notifyDone deregisters the orchestrator
    // BEFORE onDone fires. notifyDone now ends the SDK session on natural completion, so the exit is
    // prompt (it follows onDone closely) rather than arbitrarily late. The clear decision still lives
    // in the pure shouldClearPlaceholderOnExit because that logic stays defensively correct
    // regardless of exit timing — a slow drain could still, rarely, overlap a fast next start (which
    // has minted its own placeholder). See its truth table + tests:
    // clear ONLY a placeholder no ACTIVE orchestration claims.
    if (
      shouldClearPlaceholderOnExit(
        getRunPlaceholder(),
        isOrchestrationActive(),
        orchSnapshot?.treeId ?? null,
      )
    ) {
      setRunPlaceholder(null);
      // Drop the folded placeholder selection too (only if it WAS the placeholder — never clobber a
      // real plan/sentinel the user opened mid-run).
      if (getSelection().k === "placeholder") setSelection({ k: "none" });
      applyFilterAndRender();
    }
  });
  void listen<AgentError>("agent-error", (event) => {
    if (event.payload?.fatal) purgeInprocReviews();
  });

  // ---- resume_fallback toast ---------------------------------------------------------
  // The sidecar emits a non-fatal `resume_fallback` agent-stream frame when a requested SDK resume
  // could not rehydrate the prior transcript (missing/expired) and it ran the current step FRESH
  // instead. Surface a non-blocking toast so the user knows history was dropped. This is a SEPARATE
  // agent-stream subscriber from the conversation facade's (which renders the live stream) — it does
  // NOT touch session/tab state. Other agent-stream kinds are ignored here.
  void listen<AgentStream>("agent-stream", (event) => {
    if (event.payload?.kind === "resume_fallback") {
      showToast("Couldn't resume the previous conversation — re-running the current step fresh.");
    }
  });
  // User cancel (the conversation facade fires cancel_agent_run on #conversation-cancel). interrupt()
  // may not surface as agent-exit, so purge here too — a cancelled session must not leave a held
  // in-process review whose Approve resolves a dead seam. Defensive; the facade still owns the invoke.
  document.querySelector<HTMLElement>("#conversation-cancel")?.addEventListener("click", () => {
    purgeInprocReviews();
    // Defense-in-depth: onDone/onFatal null orchSnapshot, but a user full-stop may not reach
    // either (cancel_agent_run tears the seam down out-of-band). A stale snapshot would keep a
    // dead gate driving the bar / the flip suppression / the agent-exit treeId comparison, so
    // drop it here too and re-derive the affordances (a full-stop is a terminal transition: the open
    // plan may now be resumable, so refreshAffordances re-evaluates the resume banner too).
    orchSnapshot = null;
    // Same defense for the idle-waiting hint: a full-stop kills any pending prototype gate, so the
    // facade must not keep showing "Waiting for your input…" against a dead run.
    conversationHandle?.setIdleWaitingHint(false);
    refreshAffordances();
  });

  // ---- launch recovery ----
  // On startup, if reviews are already pending (the app launched while a hook is blocking), populate
  // pendingReviews with all non-stale entries and open the NEWEST one's real plan file via the normal
  // flow (no focus — the user just launched). console.warn if more than one is pending. Chained so it
  // serializes ahead of any live request that arrives during startup.
  reviewPending = chainHandler(reviewPending, async () => {
    // Boundary parse: model the launch-recovery review read as RemoteData (mirrors the sidebar
    // `listState`). `fromArray` maps [] -> zeroResults (no pending reviews to recover) and a populated
    // array -> success; a thrown read lands in `error`. The recovery logic then folds via `match`, so
    // the empty/error states cannot be silently skipped. Local to this handler — the only reader is the
    // fold below, so the state never needs module scope.
    let reviewListState: RemoteData<ReviewRequest[]>;
    try {
      reviewListState = fromArray(await invoke<ReviewRequest[]>("list_pending_reviews"));
    } catch (e) {
      console.error("list_pending_reviews failed", e);
      reviewListState = failure(e instanceof Error ? e.message : String(e));
    }
    await foldRemoteData(reviewListState, {
      // Pre-/mid-fetch — unreachable at this resolved boundary; no-op for exhaustiveness.
      initial: () => Promise.resolve(),
      fetching: () => Promise.resolve(),
      // No pending reviews (or none survived parse) — nothing to recover.
      zeroResults: () => Promise.resolve(),
      // The read failed (already logged in the catch) — leave recovery untouched.
      error: () => Promise.resolve(),
      success: async (reviews) => {
        // Drop STALE entries (hook already timed out — its Submit/Dismiss would be a silent no-op).
        const now = Date.now();
        const fresh = reviews.filter((r) => now - r.created_ms < STALE_REVIEW_MS);
        if (fresh.length === 0) return;
        if (fresh.length > 1) {
          console.warn(`launch recovery: ${fresh.length} pending reviews; auto-showing the newest`);
        }
        // Track every non-stale pending review so all are resumable + counted.
        for (const r of fresh) {
          pendingReviews.set(r.review_id, {
            reviewId: r.review_id,
            planFilePath: r.plan_file_path,
            planText: r.plan_text,
            createdMs: r.created_ms,
            source: "external",
          });
        }
        if (currentReviewId() !== null) {
          // A live request already opened a reviewed plan during startup — leave it; just refresh.
          refreshReviewBar();
          return;
        }
        // Open the newest pending review's real plan file (newestPendingReview honors the >= tie-break).
        const newest = newestPendingReview();
        if (newest !== null) await openReviewPlanFile(newest);
      },
    });
  });
});
