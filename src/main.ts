import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import {
  renderInto,
  settle,
  extractToc,
  applyComments,
  initComments,
  onCommentCountChanged,
  loadCommentsFor,
  clearAllComments,
  invalidatePopover,
  type TocEntry,
  type CommentsIO,
} from "./render";
import { buildFeedbackPrompt } from "./feedback";
import { applyReviewBarState } from "./review";
import { captureAnchor, applyDelta, scrollToHeading } from "./render/scroll";
import { collapseHome, expandHome } from "./cwd";
import { resolveCwds } from "./resolve";
import { filterRecords, highlightInto, planCountText } from "./filter";
import {
  initial,
  fetching,
  failure,
  success,
  fromArray,
  fromNullable,
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
import {
  MODEL_PRESETS,
  PRESET_OPTIONS,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  isEffortLevel,
  buildOptions,
  presetClassForModel,
  friendlyModelName,
  type ModelPreset,
  type ModelOptions,
  type EffortLevel,
} from "./model-picker";
import { initConversation, type ConversationHandle } from "./conversation";
import { diag } from "./conversation/diag";
import {
  isOrchestrationActive,
  getOrchestrator,
  effectiveModel,
  pathKey,
  parsePathKey,
  type PlanTreeSnapshot2,
  type ApprovalGate2,
  type PrototypeGate,
  type AcceptanceGate,
  type RecursiveLedger,
  type ResumeScope,
} from "./conversation/orchestrator";
import {
  resumeScopeForRoot,
  treeIsDone,
  planName2,
  activePathOf,
  nodeAtPath,
  resolveNodeByNnPath,
  type TreeNode,
  type NodePath,
} from "./conversation/plan-tree";
import { nodeExecutionModel, phaseModel } from "./conversation/plan-tree/triage";
import {
  composePreviewMarkdown,
  prototypeBarLabel,
  prototypeApproveLabel,
  prototypeGateActive,
  prototypeOpenTarget,
  acceptanceGateActive,
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
  SidebarCtx,
  CommentRecord,
  ReviewRequest,
  ReviewRequested,
  ReviewCancelled,
} from "./types";
import { asAbsPath, asStem, cwdState, type AbsPath, type Stem } from "./types";
// Imports are one-directional: main → controller; controllers never import ./main.
import {
  applyRowState,
  relativeTime,
  buildPlaceholderRow,
  renderSubTree,
  placeholderVisible,
  initTabs,
  type SubTreeNode,
} from "./sidebar";
import { computeAffordance, resumeActionLabel } from "./resume-banner";
import { suppressConversationFlip, shouldClearPlaceholderOnExit } from "./run-subscription";
import { setHookStatus, echoCommentsText } from "./review-bar";
import { chainHandler } from "./ipc";

// Re-exported so `./main` importers (tests) keep resolving; `export ... from` adds no local binding.
export { placeholderVisible, initTabs } from "./sidebar";
export { computeAffordance } from "./resume-banner";
export type { Affordance } from "./resume-banner";
export { suppressConversationFlip, shouldClearPlaceholderOnExit } from "./run-subscription";
export { setHookStatus } from "./review-bar";
export { chainHandler } from "./ipc";

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
// Resume context for the currently-rendered resumable banner; null when hidden / blocked.
// Set by renderResumeBanner when a resumable verdict paints, cleared on hide / blocked / success.
let pendingResume: { cwd: string; ledger: RecursiveLedger; requiresConfirm: boolean; hazard: string | null } | null = null;

// #toast: lightweight non-blocking notice element + auto-dismiss timer.
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

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

// ---- THE SIDEBAR SELECTION MODEL -------------------------------------------------
// `selection` is the SINGLE source of truth for the active reading-pane target, a closed union:
//   • none        — nothing open (the empty pane).
//   • plan        — a real `.md` plan open at `path`.
//   • sentinel    — a synthetic resume-sentinel row; no real file (`cwd` display-incidental).
//   • placeholder — the live-run placeholder is selected; no real file ⇒ openPath null.
// `openPath` is a DERIVED read-only getter over `selection` — writers set `selection`, not `openPath`.
// INVARIANT[selection-single-truth] (type-level): the reading-pane target is exactly one closed-union variant — none | plan | sentinel | placeholder.
//   prevents: independent openPath/placeholder/sentinel flags drifting into a contradictory double-active state
type Selection =
  | { k: "none" }
  | { k: "plan"; path: AbsPath }
  | { k: "sentinel"; treeId: string; cwd: string | null }
  | { k: "placeholder"; treeId: string };

let selection: Selection = { k: "none" };

// DERIVED from `selection` — null for `none`/`placeholder`; sentinel maps to its scheme path.
// The ONE reader the rest of the module consults; nobody assigns it (it is a function, not an lvalue).
// INVARIANT[openpath-is-derived-never-assigned] (type-level): openPath is a pure function over `selection` (no backing field) — recomputed each call, never a stored lvalue writers can set.
//   prevents: a stored openPath desyncing from the active selection
function openPath(): AbsPath | null {
  switch (selection.k) {
    case "none":
    case "placeholder":
      return null;
    case "plan":
      return selection.path;
    case "sentinel":
      return asAbsPath(RESUME_SENTINEL_SCHEME + selection.treeId);
  }
}

// ---- Plan Review (ExitPlanMode hook) — the reviewed plan is a REAL file under ~/.claude/plans/ ----
// Opens it through the normal plan-open flow (sidebar selected, comments persist, live-reload works).
// "Viewing a review" is derived: openPath === pendingReview.planFilePath. Browsing away drops to
// SUMMARY mode — a pending review never traps navigation.
//
//   pendingReviews — keyed by reviewId. Holds planFilePath (what we open) + planText (fallback).
interface PendingReview {
  reviewId: string;
  planFilePath: string;
  planText: string;
  createdMs: number;
  // ---- in-process review support ----------------------------------------------
  // "external" = settings.json ExitPlanMode hook (respond_to_review).
  // "in-process" = Agent SDK canUseTool seam (resolve_tool_permission). planFilePath is the REAL
  // written path for both (in-process plans are materialized to ~/.claude/plans/).
  source: "external" | "in-process";
  // SDK toolUseID to round-trip on resolve_tool_permission (in-process only). Undefined for external.
  toolUseId?: string;
  // Originating subagent id (for diagnostics only — hold/resolve never branch on it). Undefined for external.
  agentId?: string | null;
}
const pendingReviews = new Map<string, PendingReview>();

// The reviewId whose planFilePath === the currently-open plan, or null (the single derivation of
// "viewing a review"). On ties, the last-iterated (newest-inserted) wins.
function currentReviewId(): string | null {
  const op = openPath();
  if (op === null) return null;
  let match: string | null = null;
  for (const r of pendingReviews.values()) {
    if (r.planFilePath === op) match = r.reviewId;
  }
  return match;
}

// Latest snapshot from the shared orchestrator (null until a run is active, null after it ends).
// Holds the active node's pendingApproval gate while the user reviews.
let orchSnapshot: PlanTreeSnapshot2 | null = null;

// The last-rendered badge signature (every live node's displayed model + override source). The
// onSnapshot observer re-renders the sidebar ONLY when this changes — the badge is off the default
// re-render path (a normal EXECUTION_MODEL_SET snapshot mints no placeholder), so without this the
// auto→override flip would not land until the next list_plans. Null when no run is active.
let lastBadgeSig: string | null = null;

// EXACTLY-ONCE guard for a model-override dispatch: a fast double-click on a segment cannot start a
// second setExecutionModel.
type ModelSetDispatch = "idle" | "inflight";
let modelSetDispatch: ModelSetDispatch = "idle";

// ---- Live-run placeholder sidebar row -----------------------------------------------
// A running orchestration has no sidebar row until list_plans picks up the plan file. `runPlaceholder`
// (treeId + label) is rendered as a `.plan.placeholder` row when no real record has its treeId.
// ORTHOGONAL to `selection`: the row can be visible while a DIFFERENT plan is selected.
// The placeholder's SELECTED state is folded into `selection` (k === "placeholder") rather than a
// parallel boolean; `placeholderSelected()` reads it.
let runPlaceholder: { treeId: string; label: string } | null = null;
// INVARIANT[placeholder-selected-folded-into-selection] (type-level): the placeholder is "selected" iff `selection.k === "placeholder"` for the current run — read off the union, with no parallel boolean.
//   prevents: a "placeholder selected AND a real plan open" double-active state
function placeholderSelected(): boolean {
  return selection.k === "placeholder" && selection.treeId === (runPlaceholder?.treeId ?? null);
}

// The held ApprovalGate2 the user is currently viewing (null otherwise). One derivation covers
// decomposition AND leaf gates. Routing by gate.kind happens inside the orchestrator, not here.
function viewingGate(): ApprovalGate2 | null {
  if (!isOrchestrationActive()) return null;
  const gate = orchSnapshot?.pendingApproval ?? null;
  if (!gate) return null;
  return openPath() === asAbsPath(gate.planPath) ? gate : null;
}

// The held PrototypeGate driving the bar's PROTOTYPE mode, or null. Derived strictly from the
// orchestrator snapshot (self-clears when pendingPrototype is nulled). Precedence: pendingApproval
// outranks this; this outranks pendingReviews.
function activePrototypeGate(): PrototypeGate | null {
  return prototypeGateActive(orchSnapshot, isOrchestrationActive());
}

// The held AcceptanceGate driving the bar's ACCEPTANCE mode, or null. Derived strictly from the
// orchestrator snapshot (self-clears when pendingAcceptance is nulled). Precedence: pendingApproval
// and pendingPrototype both outrank it.
function activeAcceptanceGate(): AcceptanceGate | null {
  return acceptanceGateActive(orchSnapshot, isOrchestrationActive());
}

// Source of the currently-viewed review. Reads from the same matched review currentReviewId()
// resolved; defaults to "external" when nothing is viewed. Returns "in-process" when viewing the
// orchestrator approval gate (which is not tracked in pendingReviews).
function currentReviewSource(): "external" | "in-process" {
  if (viewingGate() !== null) return "in-process";
  const id = currentReviewId();
  if (id === null) return "external";
  return pendingReviews.get(id)?.source ?? "external";
}

// ---- PendingSurface[]: the unified set of "things awaiting the user" -------------------------
// One list so pendingCount and resumeNewestReview derive from the same source:
//   • external / in-process — tracked pendingReviews (held hooks / canUseTool seams).
//   • orchestrator-gate     — the live run's held ApprovalGate2 (NOT in pendingReviews).
//   • prototype / acceptance — the live run's held visual/forced-acceptance gates.
// Gate surfaces use the same precedence helpers (activePrototypeGate / activeAcceptanceGate),
// so at most one gate surface is ever present.
type PendingSurface =
  | { kind: "external" | "in-process"; review: PendingReview }
  | { kind: "orchestrator-gate"; gate: ApprovalGate2 }
  | { kind: "prototype"; gate: PrototypeGate }
  | { kind: "acceptance"; gate: AcceptanceGate };

// INVARIANT[pending-surface-union] (convention): every "thing awaiting the user" is one typed PendingSurface from this single builder, which both the SUMMARY count and the Resume target consult.
//   prevents: the count and the resume button computing "what's pending" from divergent paths
function pendingSurfaces(): PendingSurface[] {
  const surfaces: PendingSurface[] = [];
  for (const r of pendingReviews.values()) surfaces.push({ kind: r.source, review: r });
  const orchGate = isOrchestrationActive() ? orchSnapshot?.pendingApproval ?? null : null;
  if (orchGate) surfaces.push({ kind: "orchestrator-gate", gate: orchGate });
  const proto = activePrototypeGate();
  if (proto) surfaces.push({ kind: "prototype", gate: proto });
  const accept = activeAcceptanceGate();
  if (accept) surfaces.push({ kind: "acceptance", gate: accept });
  return surfaces;
}

// Test-only: the open plan's comment count.
export function reviewCommentCount(): number {
  return currentReviewId() === null ? 0 : unwrapOr(commentCount, 0);
}

// Test-only: clear all review state.
export function __resetReviewStateForTest(): void {
  pendingReviews.clear();
  // Reset selection to clear stale openPath/currentReviewId() for the next test.
  selection = { k: "none" };
  orchSnapshot = null;
  // Drop leaked placeholder (selection=none above already clears placeholder-selected state).
  runPlaceholder = null;
  pendingResume = null;
  // Clear leaked in-flight lock so the next test's Submit isn't stuck disabled.
  actionInFlight = "none";
}

// Test-only: install a live-run placeholder + selection for testing applyFilterAndRender paths.
export function __setRunPlaceholderForTest(
  ph: { treeId: string; label: string } | null,
  selected: boolean,
): void {
  runPlaceholder = ph;
  // A selected placeholder IS the selection (folded). A deselect drops only a stale placeholder
  // selection — must not clobber a real plan/sentinel left open by a prior test.
  if (selected && ph !== null) selection = { k: "placeholder", treeId: ph.treeId };
  else if (!selected && selection.k === "placeholder") selection = { k: "none" };
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
  selection = path === null ? { k: "none" } : { k: "plan", path: asAbsPath(path) };
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
function applyCommentCount(path: AbsPath, count: number): void {
  if (path !== openPath()) return; // foreign-plan callback: ignore entirely (no commit, no seq bump).
  ++countReqSeq;
  commentCount = success(count);
  // Re-derive the bar so a pending review's VIEWING count is up to date.
  refreshReviewBar(count);
}

// Cold-read the open plan's comment count (used on OPEN/RELOAD). Latest-wins seq guard applies.
// After an in-session save/clear the count arrives via onCommentCountChanged → applyCommentCount
// instead (backend write may not be observed yet).
export async function refreshCommentCount(): Promise<void> {
  // Short-circuit: nothing open ⇒ count is known to be 0 (no await needed; no stale landing to guard).
  const op = openPath();
  if (op === null) {
    commentCount = success(0);
    refreshReviewBar(0);
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
      refreshReviewBar(n);
    },
    // Read failed (already logged). Leave last-good count in place; skip bar re-derive.
    error: () => {},
  });
}

// Test-only: unwraps the comment count to a number (0 when unloaded/fetching/error).
export function currentCommentCount(): number {
  return unwrapOr(commentCount, 0);
}

// ---- Review action bar (persistent, non-occluding, resumable) ----
// Two modes (pure derivation in applyReviewBarState):
//   • VIEWING  — the open plan is a pending review: Submit (enabled with ≥1 comment). In-process
//                reviews also show Approve & Build.
//   • SUMMARY  — reviews pending but user is browsing elsewhere: count + Resume only.
// Derives off pendingReviews / commentCount / selection and the #review-bar DOM.
function refreshReviewBar(countOverride?: number): void {
  if (!reviewBarEl) return;
  // PROTOTYPE mode — pendingApproval outranks prototype (activePrototypeGate() yields null while
  // it's held), so reaching here means prototype is the highest-precedence pending surface.
  const protoGate = activePrototypeGate();
  if (protoGate !== null) {
    applyPrototypeBar(protoGate);
    return;
  }
  // ACCEPTANCE mode — both higher gates outrank it; reaching here with a non-null gate means it is
  // the highest-precedence pending surface.
  const acceptGate = activeAcceptanceGate();
  if (acceptGate !== null) {
    applyAcceptanceBar(acceptGate);
    return;
  }
  // Leaving (or never in) PROTOTYPE mode: its additive controls hide and #review-approve's
  // relabel reverts so the modes below render exactly as before the prototype feature.
  // The `.proto` modifier scopes the prototype-only bar layout (see styles.css); strip it so the
  // shared bar reverts to its legacy/pendingApproval layout untouched.
  reviewBarEl.classList.remove("proto");
  prototypeFeedbackEl?.classList.add("hidden");
  prototypeOpenEl?.classList.add("hidden");
  prototypePreviewEl?.classList.add("hidden");
  prototypeWorkingRefLabelEl?.classList.add("hidden");
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
    viewedCommentCount: countOverride ?? unwrapOr(commentCount, 0),
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
  // Reuse #prototype-open as "Open baseline".
  if (prototypeOpenEl) {
    prototypeOpenEl.classList.remove("hidden");
    prototypeOpenEl.textContent = "Open baseline";
  }
}

// Render the held prototype's preview into the reading pane, DETACHED: composePreviewMarkdown's
// markdown goes through the normal renderInto/settle pipeline but openPath is NEVER touched — the
// preview is not a plan file, so the next openPlan naturally replaces it (its renderGuard
// generation supersedes ours). The filename header reads "prototype-preview"; gate.cwd is the
// render base dir (relative image/link resolution).
async function renderPrototypePreview(gate: PrototypeGate): Promise<void> {
  if (!readingPaneEl) return;
  const gen = renderGuard.begin();
  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  if (docFilenameEl) docFilenameEl.textContent = "prototype-preview";
  if (docSrcEl) docSrcEl.textContent = homePath ? collapseHome(gate.cwd, homePath) : gate.cwd;
  renderInto(readingPaneEl, composePreviewMarkdown(gate), gate.cwd);
  readerScrollEl?.scrollTo({ top: 0 });
  await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
  // settle() is async; a newer open/reload may have begun — bail so a late settle from this
  // superseded preview never touches the pane or the ToC (mirrors openPlan's guard discipline).
  if (!renderGuard.isCurrent(gen)) return;
  rebuildTocFromPane();
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
  if (purged > 0) refreshAffordances();
  return purged;
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

// The user's home dir, fetched once at startup. Used to collapse a resolved absolute cwd
// into a `~/…` display path. Null until fetched (then we render the absolute path verbatim).
let homePath: string | null = null;

// filename_stem -> resolved cwd display string. Mirrors the backend cwd cache once a
// `resolve_cwds` call returns. `null` means "resolved but unknown" (show "unknown");
// an ABSENT key means "not yet resolved" (show empty — no "unknown" flash).
const cwdByStem = new Map<Stem, string | null>();

// filename_stem of every stem currently in-flight to the backend (or terminally resolved), so
// a stream of `plan-changed` events never re-triggers a full corpus rescan for a stem while one
// is in flight. A `null` (unknown) result under the attempt cap is RELEASED from this set so a
// later event can re-attempt it (see `resolve.ts`); once it hits the cap it stays here.
const attemptedStems = new Set<Stem>();

// Per-stem count of how many times we have asked the backend to resolve it. A stem that keeps
// resolving to `null` ("unknown") is re-attempted up to `MAX_RESOLVE_ATTEMPTS` times so a
// transcript written shortly after the plan file is eventually picked up; past the cap it is
// pinned "unknown" (no unbounded rescans).
const resolveAttemptCounts = new Map<Stem, number>();

// Map a resolved cwd (absolute) to its sidebar display form (home-collapsed, else verbatim).
function displayCwd(absCwd: string): string {
  return homePath ? collapseHome(absCwd, homePath) : absCwd;
}

// Mark a plan viewed on the backend (clears its unread state). Errors are non-fatal.
async function markViewed(path: AbsPath): Promise<void> {
  try {
    await invoke("mark_viewed", { path });
  } catch (e) {
    console.error("mark_viewed failed", e);
  }
}

// Parent directory of an absolute path — used as the base for resolving a plan's
// relative image srcs. Strips the trailing `/<filename>`; falls back to the path
// itself if it has no separator.
function dirOf(absPath: AbsPath): string {
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

// Decide the `.plan-src` text for a record. Precedence: backend-cached `rec.cwd` (absolute)
// wins; otherwise consult `cwdByStem` (populated by a completed `resolve_cwds`). The two
// states a row can be in before/after resolution:
//   - not yet resolved (no cache hit, stem absent from cwdByStem) ⇒ "" (empty — no flash)
//   - resolved to a path ⇒ home-collapsed display
//   - resolved but unknown (cwdByStem has null) ⇒ "unknown"
function planSrcText(rec: PlanRecord): string {
  // Prior gate (NOT part of the three-state machine): a backend-cached absolute cwd wins.
  if (rec.cwd) return displayCwd(rec.cwd);
  const s = cwdState(cwdByStem, rec.filename_stem);
  switch (s.state) {
    case "unresolved":
      return ""; // not yet resolved → empty (no "unknown" flash)
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// ---- Synthetic "resume" sidebar rows ------------------------------------------------
//
// `list_plans` synthesizes a `PlanRecord` for a mid-decompose plan-tree that has NO real plan `.md`
// file yet, so the tree is still visible + its resume banner reachable (synthetic resume sidebar
// rows). The row carries a SENTINEL `absolute_path` of the
// form `plan-tree-resume://<tree_id>` — there is NO file behind it. Anything that would `invoke`
// `read_plan_contents` / `set_open_plan` / `mark_viewed` against the path MUST guard on this
// predicate first (the Rust commands reject a sentinel — canonicalize fails on the scheme string).
const RESUME_SENTINEL_SCHEME = "plan-tree-resume://";

// True iff `path` is a synthetic-row sentinel (no real `.md` file behind it).
function isResumeSentinel(path: string): boolean {
  return path.startsWith(RESUME_SENTINEL_SCHEME);
}

// The tree_id encoded in a sentinel path (`plan-tree-resume://<tree_id>` → `<tree_id>`). Caller MUST
// have already gated on `isResumeSentinel`. Used to test whether a live-run placeholder is standing in
// for the same tree (the happy resume→placeholder takeover) before clearing a vanished sentinel.
function resumeSentinelTreeId(path: string): string {
  return path.slice(RESUME_SENTINEL_SCHEME.length);
}

// ---- Resume detection ---------------------------------------------------------------
//
// Resolve a plan record's originating cwd for the resume read path. Mirrors planSrcText's
// precedence (backend-cached absolute cwd wins; else the resolved cwdByStem path) but returns the
// ABSOLUTE path (never the home-collapsed display form) — the resume reads the real `.plan-tree/`.
// Returns null when the cwd is not yet resolved or resolved-but-unknown: with no real directory
// there is nothing to read, so detectResumable returns null (no banner).
function resolvedCwdFor(rec: PlanRecord): string | null {
  // BELT-AND-SUSPENDERS: expand a leading `~/` (or bare `~`) back to the absolute home path before
  // the resume read. `patchAllCwds` syncs the home-COLLAPSED display string onto `rec.cwd` (so the
  // sidebar filter matches the visible `~`-form); but `read_plan_tree_file` does NOT expand `~`, so a
  // `~`-path would `is_dir()`-fail in Rust and silently kill the Resume banner. expandHome is a no-op
  // on an already-absolute path, so resolved-from-cache (absolute) cwds are unaffected.
  const raw = rec.cwd ? rec.cwd : cwdStateResolvedPath(rec);
  if (raw === null) return null;
  return homePath ? expandHome(raw, homePath) : raw;
}

// The resolved (absolute) cwd for a record from the resolve cache alone, or null when it is not yet
// resolved or resolved-but-unknown. Split out of resolvedCwdFor so the `~`-expansion above applies
// uniformly to both the backend-cached cwd and the cache-resolved path.
function cwdStateResolvedPath(rec: PlanRecord): string | null {
  const s = cwdState(cwdByStem, rec.filename_stem);
  return s.state === "resolved" ? s.path : null;
}

// The verdict detectResumable hands back: the pure ResumeScope (resumable OR blocked) PLUS the cwd +
// parsed ledger the click handler needs to drive getOrchestrator().resume(). Null (returned by
// detectResumable) means "no banner at all".
export type ResumeVerdict = ResumeScope & { cwd: string; ledger: RecursiveLedger };

// Narrow shape-guard for a parsed `state.json`: schema-2 ledger with a `root` node and the tree_id we
// matched on. Deliberately shallow — assertCoherent2 (run inside resumeScopeForRoot/rehydrate) is the
// deep check; this only gates the obviously-wrong (wrong schema, missing root) before any helper that
// could throw runs.
function isLedgerShape(v: unknown): v is RecursiveLedger {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.schema === 2 && typeof o.tree_id === "string" && typeof o.root === "object" && o.root !== null;
}

// READ-ONLY resume detection (NO tokens, NO agent). Given the selected plan record, decide whether a
// Resume banner should appear and, if so, with what verdict. NEVER throws (every throwing step is
// wrapped) — a plan click must not be able to crash. Returns null whenever there is no resumable
// tree: cwd unresolved, no/absent state.json, parse failure, tree_id mismatch (a stale `.plan-tree/`
// for a DIFFERENT tree must not light up), the tree already done, an orchestration already active, or
// a coherence/scope helper that threw. Returns a verdict (resumable OR blocked) otherwise, so the
// banner can render BOTH the resume button and the blocked message.
// Reads the cwd subsystem (homePath / cwdByStem) and isOrchestrationActive.
export async function detectResumable(rec: PlanRecord): Promise<ResumeVerdict | null> {
  try {
    // tree_id is required: a standalone plan (no tree) is never part of a `.plan-tree/`.
    if (!rec.tree_id) {
      diag(`detectResumable: stem=${rec.filename_stem} no tree_id → no banner`);
      return null;
    }
    // An active orchestration owns the seam — never offer a competing resume.
    if (isOrchestrationActive()) {
      diag(`detectResumable: tree_id=${rec.tree_id} orchestrationActive → no banner`);
      return null;
    }
    const cwd = resolvedCwdFor(rec);
    if (cwd === null) {
      diag(`detectResumable: tree_id=${rec.tree_id} cwd UNRESOLVED → no banner`);
      return null; // cwd unresolved → no banner.
    }

    // The state.json read is wrapped in its OWN try/catch so a cwd/IO error here (e.g. a non-existent
    // or `~`-unexpanded cwd making Rust's `read_plan_tree_file` REJECT) is distinguished from the
    // benign "no tree" case (resolve to null) and is NOT silently absorbed by the outer catch as an
    // anonymous "UNEXPECTED ERROR". Both branches → no banner; the diag tells them apart in dev.
    let stateFile: RemoteData<string>;
    try {
      stateFile = fromNullable(
        await invoke<string | null>("read_plan_tree_file", { cwd, name: "state.json" }),
      );
    } catch (e) {
      console.debug("detectResumable: read_plan_tree_file(state.json) rejected", e);
      diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json READ ERROR (${e}) → no banner`);
      return null; // cwd/IO error reading the tree → not resumable (and now visibly diagnosed).
    }
    // `fromNullable` maps an ABSENT state.json (null) -> zeroResults; a present one -> success. Fold all
    // five arms to the raw text, or null when there is no resumable tree (absent/unread).
    const raw = foldRemoteData(stateFile, {
      initial: () => null,
      fetching: () => null,
      zeroResults: (): string | null => {
        diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json NOT FOUND → no banner`);
        return null;
      },
      success: (data): string | null => data,
      error: () => null,
    });
    if (raw === null) {
      return null; // no `.plan-tree/state.json` → not a resumable tree.
    }

    // Defensive parse + shape-guard — a torn/foreign file must degrade to no-banner, never throw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.debug("detectResumable: state.json parse failed", e);
      diag(`detectResumable: tree_id=${rec.tree_id} state.json PARSE FAILED → no banner`);
      return null;
    }
    if (!isLedgerShape(parsed)) {
      diag(`detectResumable: tree_id=${rec.tree_id} state.json wrong shape → no banner`);
      return null;
    }
    const ledger = parsed;

    // STALE-TREE GUARD: a `.plan-tree/` left by a DIFFERENT tree must not light up this plan's banner.
    if (ledger.tree_id !== rec.tree_id) {
      diag(
        `detectResumable: tree_id MISMATCH (ledger=${ledger.tree_id} rec=${rec.tree_id}) → no banner`,
      );
      return null;
    }

    const root = ledger.root as TreeNode;

    // BANNER↔ENGINE DISK-PROBE SYMMETRY: the engine (orchestrator.resume) classifies a persisted
    // `open/decomposing` node by probing disk — does planName2(activePath) exist under `.plan-tree/`? —
    // and gates (re-present the decomposition gate) when present, resends ("decompose") when absent. The
    // banner MUST classify identically, so pre-read that SAME single artifact here and back a synchronous
    // predicate with the cached result. recoveryFor only ever probes the ACTIVE node's path, so probe the
    // DYNAMIC activePathOf(root) (nested decomposes resolve correctly), NOT a hardcoded root. A NON-NULL
    // read ⇒ "present"; null/absent/missing-file/IO-error ⇒ "absent" (the conservative default, matching
    // the engine). Every read is guarded so a missing file degrades to "absent" — never a throw
    // (detectResumable must never throw). The predicate keys on pathKey so a probe of any other path
    // falls through to absent rather than a phantom hit.
    // The probe fires ONLY when the active node is actually open/decomposing (the sole consumer of the
    // predicate in recoveryFor). A leaf gate or any other phase needs no `.plan-tree/` filename read,
    // and firing one there would be a wasted disk hit (and would wrongly probe `.plan-tree/` for a leaf
    // plan that lives under ~/.claude/plans/, tripping the leaf-gate "no plan-tree probe" invariant).
    const decompositionArtifactCache = new Map<string, boolean>();
    const activeForProbe = activePathOf(root);
    if (activeForProbe !== null) {
      const activeNode = nodeAtPath(root, activeForProbe);
      const isDecomposing =
        activeNode?.state.stage === "open" && activeNode.state.phase === "decomposing";
      if (isDecomposing) {
        let probe: RemoteData<string>;
        try {
          probe = fromNullable(
            await invoke<string | null>("read_plan_tree_file", {
              cwd,
              name: planName2(activeForProbe),
            }),
          );
        } catch (e) {
          console.debug("detectResumable: decomposition-artifact probe failed", e);
          probe = failure(String(e)); // missing/IO-error ⇒ absent.
        }
        // present (success) ⇒ exists; absent (zeroResults) or errored ⇒ does not exist.
        const exists = foldRemoteData(probe, {
          initial: () => false,
          fetching: () => false,
          zeroResults: () => false,
          success: () => true,
          error: () => false,
        });
        decompositionArtifactCache.set(pathKey(activeForProbe), exists);
      }
    }
    const decompositionArtifactExists = (path: NodePath): boolean =>
      decompositionArtifactCache.get(pathKey(path)) ?? false;

    // treeIsDone is pure + total, but wrap defensively alongside resumeScopeForRoot (which CAN throw on
    // an unclassified node state via assertNeverRecovery). Any throw → no banner.
    let scope: ResumeScope;
    try {
      if (treeIsDone(root)) {
        diag(`detectResumable: tree_id=${rec.tree_id} treeIsDone=true → no banner`);
        return null; // a completed tree is not resumable.
      }
      // Pass the ledger so the acceptance window (a baseline-bearing root parked awaiting a
      // verdict) classifies as resumable rather than blocked, and the disk-probe predicate so
      // open/decomposing is classified gate-vs-resend identically to the engine.
      scope = resumeScopeForRoot(root, ledger, decompositionArtifactExists);
    } catch (e) {
      console.debug("detectResumable: resume-scope derivation threw", e);
      diag(`detectResumable: tree_id=${rec.tree_id} resumeScopeForRoot THREW → no banner`);
      return null;
    }

    if (!scope.resumable) {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} scope=BLOCKED(${scope.reason}) phase="${scope.phaseLabel}" → blocked banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // For a resumable GATE scope, the user reviews an on-disk plan artifact — verify it exists, else
    // the gate cannot be re-presented. The two gate kinds live in DIFFERENT trees on disk:
    //   - LEAF gate: `scope.plan.planPath` is the ABSOLUTE path recorded on the node at NODE_DRAFTED.
    //     This app writes leaf plans into `~/.claude/plans/` (NOT `.plan-tree/`), so the artifact is
    //     verified through the plans channel (`read_plan_contents`, which canon-checks containment in
    //     the plans dir). Using `read_plan_tree_file` here would ALWAYS miss (the file is not under
    //     `.plan-tree/`) and false-negative every real leaf gate into a blocked banner.
    //   - DECOMPOSITION gate: an `open/awaiting-decomposition-approval` node has no path field, so
    //     `scope.plan.planPath` is the FILENAME `planName2(path)` ("master.md" / "<pathKey>-plan.md")
    //     under `.plan-tree/` — verified through `read_plan_tree_file`.
    // Missing artifact → degrade to a BLOCKED verdict (banner shows the message, not a button).
    // Resend scopes need no artifact (the prompt is re-sent fresh).
    // The forced acceptance window: the build is COMPLETE; the only thing missing is the
    // user's verdict against the frozen baseline. There is NO plan artifact to verify (no model turn
    // resumes — the driver re-mints the acceptance gate and surfaces the bar). Surface it as a
    // resumable banner so reopening the app shows the acceptance bar, not the blocked message.
    if (scope.plan.kind === "acceptance") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE acceptance window phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "gate") {
      const plan = scope.plan;
      // The leaf gate artifact is a SCALAR plans-store read (success, or a thrown read → error); the
      // decomposition gate artifact is an OPTIONAL `.plan-tree/` read (fromNullable: absent →
      // zeroResults, present → success). Both flow into one RemoteData<string> whose only "present"
      // state is `success`.
      let artifact: RemoteData<string>;
      try {
        if (plan.gateKind === "leaf") {
          // The node's absolute `~/.claude/plans/...` path — verify through the plans channel.
          artifact = success(await invoke<string>("read_plan_contents", { path: plan.planPath }));
        } else {
          // The decomposition plan lives under `.plan-tree/` by filename.
          artifact = fromNullable(
            await invoke<string | null>("read_plan_tree_file", {
              cwd,
              name: planName2(plan.path),
            }),
          );
        }
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file — treat any
        // throw as "absent" rather than crashing the click.
        console.debug("detectResumable: gate-artifact read failed", e);
        artifact = failure(String(e));
      }
      // The gate is re-presentable only when the artifact is PRESENT (success); absent (zeroResults)
      // or errored ⇒ missing.
      const artifactPresent = foldRemoteData(artifact, {
        initial: () => false,
        fetching: () => false,
        zeroResults: () => false,
        success: () => true,
        error: () => false,
      });
      if (!artifactPresent) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} ${plan.gateKind} gate artifact MISSING (planPath=${plan.planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${plan.gateKind} gate at "${pathKey(plan.path)}" planPath=${plan.planPath} phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "resend") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE resend(${scope.plan.awaiting}) phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // New kinds (restart / prototype-gate / rewind): the pure scope is now RESUMABLE and the
    // banner offers them as real one-click FORWARD actions. The orchestrator decides the concrete
    // action from the ledger (resume keys off cwd+ledger), so the banner only triggers resume.
    //   - restart{from:"clarify"} / prototype-gate: NO artifact verification — `restart` re-runs the
    //     clarify turn from the root title (no durable plan to read), and `prototype-gate`'s artifact
    //     is the `.plan-tree/prototype/` directory + INTENT.md the driver re-mints (not a single plan
    //     .md verified through the gate channels). Both are resumable as-is.
    //   - rewind: when `planPath` is non-null the rewind re-presents an on-disk plan artifact, but the
    //     CHANNEL depends on the artifact's SHAPE (mirroring how the gate branch above distinguishes
    //     leaf vs decomposition):
    //       * ABSOLUTE `~/.claude/plans/...` planPath ⇒ a LEAF artifact (the leaf/executing
    //         audit-and-continue rewind carries the node's own absolute planPath, recorded at
    //         NODE_DRAFTED — leaves write ONLY to the plans store, never `.plan-tree/`). Verify it
    //         through the PLANS channel (read_plan_contents). Using read_plan_tree_file here would
    //         ALWAYS miss — the Rust allow-list (valid_plan_tree_name) rejects an absolute name — so
    //         every real executing rewind would false-negative into a blocked banner (the "Continue
    //         implementation" button would never appear).
    //       * RELATIVE name ⇒ a decomposition plan filename under `.plan-tree/` (planName2(path)) —
    //         verify it like a DECOMPOSITION gate (read_plan_tree_file).
    //     A null planPath rewind (a torn leaf gate, the runtime-degenerate no-active-node case) has no
    //     single artifact to read → resumable with no verification.
    if (scope.plan.kind === "rewind" && scope.plan.planPath !== null) {
      const planPath = scope.plan.planPath;
      const isAbsolute = planPath.startsWith("/") || planPath.startsWith("~");
      // ABSOLUTE planPath ⇒ a SCALAR plans-store read (success, or thrown → error); RELATIVE ⇒ an
      // OPTIONAL `.plan-tree/` read (fromNullable: absent → zeroResults, present → success). The
      // rewind re-presents the artifact only when it is PRESENT (success).
      let artifact: RemoteData<string>;
      try {
        artifact = isAbsolute
          ? success(await invoke<string>("read_plan_contents", { path: planPath }))
          : fromNullable(await invoke<string | null>("read_plan_tree_file", { cwd, name: planPath }));
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file, and
        // read_plan_tree_file rejects an invalid/out-of-bounds name — treat any throw as "absent"
        // rather than crashing the click.
        console.debug("detectResumable: rewind-artifact probe failed", e);
        artifact = failure(String(e)); // missing/IO-error ⇒ absent.
      }
      const artifactPresent = foldRemoteData(artifact, {
        initial: () => false,
        fetching: () => false,
        zeroResults: () => false,
        success: () => true,
        error: () => false,
      });
      if (!artifactPresent) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} rewind artifact MISSING (planPath=${planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
    }
    diag(
      `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${scope.plan.kind} phase="${scope.phaseLabel}" → Resume banner`,
    );
    return { ...scope, cwd, ledger };
  } catch (e) {
    // Belt-and-suspenders: detectResumable must NEVER throw on a plan click.
    console.debug("detectResumable: unexpected error", e);
    diag(`detectResumable: UNEXPECTED ERROR → no banner`);
    return null;
  }
}

// Render the #resume-banner from a verdict (or hide it for null). Pure DOM derivation: resumable →
// the #resume-plan-btn labeled per-kind (see resumeActionLabel; the resume context stashed for its
// click); blocked → a static muted "<phaseLabel> — resuming from here isn't supported yet" message,
// no button; null → hidden + context cleared. A SEPARATE surface from refreshReviewBar, but per the
// precedence refreshAffordances only paints it when no higher affordance occupies the bar.
export function renderResumeBanner(verdict: ResumeVerdict | null): void {
  if (!resumeBannerEl) return;
  // Always start from the collapsed (one-click) confirm state — any prior verdict's open confirm row
  // must not bleed across a re-render onto a different/blocked/hidden verdict.
  hideResumeConfirmRow();
  if (verdict === null) {
    pendingResume = null;
    resumeBannerEl.classList.add("hidden");
    resumeBannerEl.classList.remove("blocked");
    resumePlanBtnEl?.classList.add("hidden");
    if (resumeBannerMsgEl) resumeBannerMsgEl.textContent = "";
    return;
  }
  resumeBannerEl.classList.remove("hidden");
  if (verdict.resumable) {
    // Only a `rewind` plan carries `requiresConfirm`/`hazard` (leaf/executing today); every other
    // resumable kind is one-click (requiresConfirm absent ⇒ false). Extract them onto pendingResume so
    // the click handler can gate the hazardous case without re-deriving the plan shape.
    const requiresConfirm = verdict.plan.kind === "rewind" && verdict.plan.requiresConfirm === true;
    const hazard =
      verdict.plan.kind === "rewind" && verdict.plan.hazard !== undefined ? verdict.plan.hazard : null;
    pendingResume = { cwd: verdict.cwd, ledger: verdict.ledger, requiresConfirm, hazard };
    resumeBannerEl.classList.remove("blocked");
    if (resumeBannerMsgEl) resumeBannerMsgEl.textContent = "";
    if (resumePlanBtnEl) {
      resumePlanBtnEl.classList.remove("hidden");
      resumePlanBtnEl.textContent = resumeActionLabel(verdict.plan, verdict.phaseLabel);
    }
  } else {
    pendingResume = null;
    resumeBannerEl.classList.add("blocked");
    resumePlanBtnEl?.classList.add("hidden");
    if (resumeBannerMsgEl) {
      resumeBannerMsgEl.textContent = `${verdict.phaseLabel} — resuming from here isn't supported yet`;
    }
  }
}

// Collapse the inline confirm row back to the one-click button (hide the confirm/cancel pair + hazard
// text, re-show the primary button). Idempotent — safe to call when the row was never opened.
function hideResumeConfirmRow(): void {
  resumeConfirmRowEl?.classList.add("hidden");
  if (resumeHazardEl) resumeHazardEl.textContent = "";
  resumePlanBtnEl?.classList.remove("hidden");
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
  if (pendingResume === null) return;
  // HAZARDOUS gate: a verdict whose plan requiresConfirm (leaf/executing — edits may be
  // partially applied) must NOT resume on this first click. Reveal the inline confirm row and return;
  // resume() fires ONLY from the subsequent #resume-confirm-btn click (executeResume). Non-hazardous
  // verdicts fall through and fire immediately, exactly as before.
  if (pendingResume.requiresConfirm) {
    showResumeConfirmRow(pendingResume.hazard);
    return;
  }
  await executeResume();
}

// Cancel the hazardous confirm step: abort WITHOUT resuming, collapsing the confirm row back to the
// one-click button. pendingResume is untouched (the banner stays, the verdict remains resumable).
function cancelResumeConfirm(): void {
  hideResumeConfirmRow();
}

// Actually drive getOrchestrator().resume() for the pending verdict. Reached from the non-hazardous
// button click directly, OR from #resume-confirm-btn after the user confirmed a hazardous resume — so
// resume() is provably never invoked for a hazardous verdict until confirmation.
async function executeResume(): Promise<void> {
  if (pendingResume === null) return;
  const { cwd, ledger } = pendingResume;
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

// Show the lightweight #toast with `msg`, auto-dismissing after TOAST_MS. Non-blocking — it never
// changes session/tab state. A second call resets the timer (latest message wins).
const TOAST_MS = 6000;
function showToast(msg: string): void {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.add("hidden");
    toastTimer = null;
  }, TOAST_MS);
}

// ---- Nested sidebar rendering ----------------------------------------------
//
// `list_plans` returns records PRE-ORDERED for direct nested rendering:
// top-level masters + standalones interleaved by recency,
// each master IMMEDIATELY followed by its children in nn-ascending order, as a closed flavor
// set with orphans/duplicates already normalized. So `renderSidebar` walks top-to-bottom with
// NO re-aggregation and NO flavor-fallback logic.

// The execution-model a sidebar row displays, and whether that state is a LIVE user override.
//   - Live node (the row is in the active tree AND its nn_path resolves in the snapshot): the node's
//     PERSISTED per-node model (execution_model, else the derived nodeExecutionModel), with the
//     auto/override affordance read off model_source.
//   - Persisted / inactive row: the wire `execution_model` (chip only — the source is unknowable
//     off-wire). Null (legacy/pre-feature) ⇒ no model ⇒ no badge.
// `model_source` is never on the PlanRecord wire, so override state is only knowable for a live node.
function rowModelState(rec: PlanRecord): { model: ModelOptions; overridden: boolean; live: boolean } | null {
  if (orchSnapshot && rec.tree_id && rec.tree_id === orchSnapshot.treeId) {
    const hit = resolveNodeByNnPath(orchSnapshot.root, rec.nn_path);
    if (hit) {
      return {
        model: hit.node.execution_model ?? nodeExecutionModel(hit.node).options,
        overridden: hit.node.model_source === "override",
        live: true,
      };
    }
  }
  const persisted = rec.execution_model ?? null;
  return persisted ? { model: persisted, overridden: false, live: false } : null;
}

// Append the trailing `.mbadge` model chip to a row's `.plan-row` (the last child). Omitted entirely
// when the row has no known model (legacy row) or an unrecognized model id.
function appendModelBadge(planRow: HTMLElement, rec: PlanRecord): void {
  const state = rowModelState(rec);
  if (!state) return;
  const cls = presetClassForModel(state.model.model);
  if (!cls) return;
  const badge = document.createElement("span");
  badge.className = `mbadge ${cls}`;
  badge.textContent = friendlyModelName(state.model.model) ?? state.model.model;
  // The auto/override affordance rides ONLY on a live node (model_source is off-wire): a live auto
  // node gets the "auto" suffix, a live override gets the `.override` accent dot, a persisted chip
  // gets neither.
  if (state.live) {
    if (state.overridden) {
      badge.classList.add("override");
    } else {
      const rec_ = document.createElement("span");
      rec_.className = "rec";
      rec_.textContent = "auto";
      badge.appendChild(rec_);
    }
  }
  planRow.appendChild(badge);
}

// Build a flat row matching the documented per-row template:
//   .plan[.active][.unread] data-path  >  .plan-row > .plan-title + .unread-dot + .mbadge
//                                          .plan-src (dimmed cwd; filled by 03)
//                                          .plan-meta (.when)
// Standalone rows and 0-child masters use this shape. A 0-child master keeps flavor=master
// semantics internally and opens normally (see the "0-child master ⇒ flat row" decision).
function buildFlatRow(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const title = document.createElement("span");
  title.className = "plan-title";
  // A synthetic resume-sentinel row's `filename_stem` is the tree_id (display-incidental) — show the
  // tree's title instead, which rides `h1s[0]` (synthetic resume-sentinel rows). Real rows
  // keep the existing `filename_stem` title. A sentinel with no h1s falls back to the stem.
  title.textContent = isResumeSentinel(rec.absolute_path)
    ? rec.h1s[0] ?? rec.filename_stem
    : rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(title);
  planRow.appendChild(dot);
  appendModelBadge(planRow, rec);

  const src = document.createElement("div");
  src.className = "plan-src";
  src.textContent = planSrcText(rec);

  const meta = document.createElement("div");
  meta.className = "plan-meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.mtime_ms);
  meta.appendChild(when);

  row.appendChild(planRow);
  row.appendChild(src);
  row.appendChild(meta);

  return row;
}

// Build an expandable master: a `.master` wrapper holding a `.plan.master-row` (flat-row shape
// PLUS a leading `.twirl` and a trailing `.child-count`) and a `.children` container. Only built
// when child_count >= 1 (0-child masters render flat via buildFlatRow). Returns the wrapper and
// its `.children` box (the walk threads subs into the latter).
function buildMaster(rec: PlanRecord, ctx: SidebarCtx): { wrapper: HTMLElement; children: HTMLElement } {
  const treeId = rec.tree_id ?? "";
  const effectiveCollapsed = ctx.collapseOverride.get(treeId) ?? rec.collapsed;

  const wrapper = document.createElement("div");
  wrapper.className = "master";
  wrapper.dataset.treeId = treeId; // lets onToggleCollapse find this wrapper for instant feedback
  if (effectiveCollapsed) wrapper.classList.add("collapsed");

  const row = buildFlatRow(rec, ctx);
  row.classList.add("master-row");

  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the
  // master plan. Prepend it before the title.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.onToggleCollapse(treeId, !(ctx.collapseOverride.get(treeId) ?? rec.collapsed));
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // "N sub-plans" count (singular at 1) appended after the title/dot.
  const n = rec.child_count ?? 0;
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${n} sub-plan${n === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  // buildFlatRow appended the model badge before the count; keep it the LAST child so the far-right
  // chip position is stable across flat + master rows (its margin-left:auto anchors it right).
  const badge = planRow.querySelector(".mbadge");
  if (badge) planRow.appendChild(badge);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// Render the full nested sidebar from pre-ordered records into `listEl`. `arrange_plans` groups
// each master's subs contiguously in depth-first dotted order; VISUAL depth is built here from
// `nn_path` prefixes with a prefix-keyed stack: a sub whose nn_path extends the top frame's
// nn_path by exactly one segment nests inside it; otherwise frames pop until its parent prefix
// matches. The stack carries SubTreeNodes (not DOM) so "internal" = actually-accumulated kids.
// Reads the module singletons selection / collapseOverride / subCollapse + the cwd subsystem + the
// DOM-handle let-bindings; the sidebar and reading-pane domains never import each other (CLAUDE.md
// keeps them disjoint), so they converge only here.
export function renderSidebar(listEl: HTMLElement, records: PlanRecord[], ctx: SidebarCtx): void {
  listEl.replaceChildren();

  // Live-run placeholder: when the ctx carries one AND no rendered record has its
  // tree_id (the agent hasn't written its plan file yet, or list_plans lags the write), prepend
  // the `.plan.placeholder` row as the FIRST entry. Once the real row exists the placeholder is
  // omitted — the real row takes over.
  const ph = ctx.placeholder ?? null;
  const phShown = placeholderVisible(ph, records);
  if (ph && phShown) {
    listEl.appendChild(buildPlaceholderRow(ph, ctx));
  }

  // The open master's children container + its parse state; null between masters.
  let currentChildren: HTMLElement | null = null;
  let roots: SubTreeNode[] = [];
  // Prefix stack over the open master's subs. nnPath "" is the master-level base (never pops).
  let stack: { nnPath: string; kids: SubTreeNode[] }[] = [];

  // Flush the open master's parsed sub-tree into its `.children` container.
  const flush = (): void => {
    if (!currentChildren) return;
    for (const root of roots) {
      renderSubTree(root, currentChildren, ctx);
    }
    currentChildren = null;
    roots = [];
    stack = [];
  };

  for (const rec of records) {
    if (rec.flavor === "master" && (rec.child_count ?? 0) >= 1) {
      flush();
      const { wrapper, children } = buildMaster(rec, ctx);
      listEl.appendChild(wrapper);
      currentChildren = children;
      roots = [];
      stack = [{ nnPath: "", kids: roots }];
    } else if (rec.flavor === "sub") {
      // Trust the contract (a sub always follows its master), but be LOUD not silent: a sub with
      // no open children container is a backend contract violation — log it and append flat so
      // the sidebar still renders (a visible diagnostic, never a quiet re-classification).
      if (!currentChildren) {
        console.error("renderSidebar: orphan sub with no master container", rec.absolute_path);
        listEl.appendChild(buildFlatRow(rec, ctx));
        continue;
      }
      const nnPath = rec.nn_path ?? "";
      const parentPrefix = nnPath.split(".").slice(0, -1).join("."); // "" for depth-1 subs
      // Pop deeper/sibling frames until the top frame IS this sub's parent (base never pops).
      while (stack.length > 1 && stack[stack.length - 1].nnPath !== parentPrefix) {
        stack.pop();
      }

      const node: SubTreeNode = { rec, kids: [] };
      if (stack[stack.length - 1].nnPath === parentPrefix) {
        stack[stack.length - 1].kids.push(node);
        // Only a properly-parented sub opens a frame; extensions of an ORPHAN stay orphans too
        // (each contract-violating row is individually loud rather than quietly re-grouped).
        stack.push({ nnPath, kids: node.kids });
      } else {
        // Generalized loud orphan: the dotted parent prefix has no preceding row in this tree —
        // a backend contract violation (arrange_plans orders a parent before its extensions).
        // Render FLAT at the master's depth-1 level, never silently re-parent.
        console.error(
          "renderSidebar: orphan dotted sub — parent prefix has no preceding row",
          rec.absolute_path,
          nnPath,
        );
        roots.push(node);
      }
    } else {
      // standalone, or a 0-child master ⇒ flat row.
      flush();
      listEl.appendChild(buildFlatRow(rec, ctx));
    }
  }
  flush();

  // While a rendered placeholder is SELECTED it is THE single active row (the user has been
  // flipped to the Conversation tab to watch the run) — real rows cede `.active` even when one
  // matches ctx.openPath, so a run start can never paint two active rows (the placeholder AND
  // the still-open prior plan). Applies only while the placeholder is actually rendered: once
  // the real row supersedes it, ctx.openPath drives `.active` normally again.
  if (ph && phShown && ph.selected) {
    for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".plan.active[data-path]"))) {
      el.classList.remove("active");
    }
  }
}

// Session record of the user's collapse intent for trees toggled THIS session. Resolved as
// `collapseOverride.get(tree_id) ?? rec.collapsed` in `buildMaster`, so an in-flight refreshList
// reading a not-yet-persisted (stale) `collapsed` value cannot revert the user's toggle — the
// override wins until the backend converges; the empty map on restart cedes to the persisted value.
const collapseOverride = new Map<string, boolean>();

// Session-ONLY collapse state for INTERNAL sub nodes (keyed by subCollapseKey). Never persisted
// and never routed through set_tree_collapsed — restarting the app re-expands all internal nodes
// while masters keep their persisted collapse exactly as before.
const subCollapse = new Map<string, boolean>();

// Optimistic collapse toggle: record intent, toggle `.collapsed` on the master wrapper instantly
// for feedback, then fire-and-forget the persist (errors logged, non-fatal). No re-list.
function onToggleCollapse(treeId: string, next: boolean): void {
  collapseOverride.set(treeId, next);
  if (planListEl) {
    for (const wrapper of Array.from(planListEl.querySelectorAll<HTMLElement>(".master"))) {
      if (wrapper.dataset.treeId === treeId) {
        wrapper.classList.toggle("collapsed", next);
      }
    }
  }
  void invoke("set_tree_collapsed", { treeId, collapsed: next }).catch((e) =>
    console.error("set_tree_collapsed failed", e),
  );
}

// PURE selection reducer: given the prior selection, the PRIOR records list, and the
// fresh records list, return the selection that should survive. The ONLY collapse is a `plan`
// selection that GENUINELY VANISHED — it was in the prior list and is gone from the new one — falling
// to `none` (closing the ghost reading pane). Everything else is EXEMPT and returned unchanged:
//   • placeholder — a live run has no real row until its plan lands; blanking it would drop the run.
//   • sentinel    — a synthetic resume row is kept alive by the dedicated stale-sentinel cleanup below
//                   (which also honors the placeholder-stands-in takeover); this reducer must not
//                   pre-empt that nuance.
//   • a `plan` that was NEVER listed — a freshly-opened/not-yet-indexed plan, a held gate whose row
//                   lags the write, or the __setOpenPathForMock in-process review demo (whose
//                   plan is intentionally absent from list_plans). "Absent from the new list" alone is
//                   NOT a vanish — it must have been PRESENT before, so a not-yet-indexed open is safe.
//   • the held orchestrator gate's plan — exempt even if it WAS listed then dropped (the row can lag
//                   mid-hold; the placeholder stands in), via the explicit `heldGatePlan` guard.
// INVARIANT[selection-collapse-only-on-genuine-vanish] (runtime-guard): a `plan` selection collapses to none only when it was in the prior list AND is absent from the new one.
//   prevents: blanking a freshly-opened / not-yet-indexed plan that was simply never listed
function resolveSelection(
  prev: Selection,
  records: PlanRecord[],
  prevRecords: PlanRecord[],
  heldGatePlan: AbsPath | null,
): Selection {
  if (prev.k !== "plan") return prev;
  // INVARIANT[held-gate-plan-exempt-from-collapse] (runtime-guard): the held orchestrator gate's plan is returned unchanged even if its row drops from list_plans mid-hold.
  //   prevents: a churning gate row collapsing the selection and vanishing the in-process Approve bar
  if (heldGatePlan !== null && prev.path === heldGatePlan) return prev;
  const wasListed = prevRecords.some((r) => r.absolute_path === prev.path);
  const stillListed = records.some((r) => r.absolute_path === prev.path);
  return wasListed && !stillListed ? { k: "none" } : prev;
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
  const heldGatePlan =
    isOrchestrationActive() && orchSnapshot?.pendingApproval != null
      ? asAbsPath(orchSnapshot.pendingApproval.planPath)
      : null;
  const before = selection;
  selection = resolveSelection(selection, records, prevRecords, heldGatePlan);
  if (before.k === "plan" && selection.k === "none") {
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
    const placeholderStandsIn = runPlaceholder !== null && runPlaceholder.treeId === treeId;
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
  selection = { k: "none" };
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

// Build the FRESH sidebar render context (openPath read live, never a stale closure — keeps
// `.active` correct across re-lists). Shared by the filter render path.
function makeSidebarCtx(): SidebarCtx {
  // The placeholder's `.active` derivation (computed LIVE each render): the folded selected flag
  // (placeholderSelected() — selection.k === "placeholder" for this tree) OR "the gate plan is open
  // but its row is missing" — when a held gate's plan IS the open plan, openPlan's [data-path] loop
  // may have found no row to mark `.active`, so the placeholder stands in as the active row
  // (renderSidebar omits it once the row exists, at which point that row carries `.active` via
  // ctx.openPath instead).
  const gate = orchSnapshot?.pendingApproval ?? null;
  const standsInForOpenGatePlan = gate != null && openPath() === asAbsPath(gate.planPath);
  return {
    openPath: openPath(),
    collapseOverride,
    subCollapse,
    onOpen: (path, stem) => {
      // Opening any real plan from the sidebar deselects the placeholder. openPlan sets
      // selection=plan (so the folded placeholderSelected goes false), but it does NOT re-render the
      // sidebar and its [data-path] loop only touches real rows — clear the placeholder's stale
      // `.active` here directly.
      if (planListEl) {
        for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>(".plan.placeholder"))) {
          el.classList.remove("active");
        }
      }
      void openPlan(path, stem);
    },
    onToggleCollapse,
    placeholder: runPlaceholder
      ? {
          treeId: runPlaceholder.treeId,
          label: runPlaceholder.label,
          selected: placeholderSelected() || standsInForOpenGatePlan,
        }
      : null,
    onPlaceholderOpen: () => {
      // Clicking the placeholder makes it the active selection (the user wants to watch the run).
      switchToConversationTab();
      if (runPlaceholder) selection = { k: "placeholder", treeId: runPlaceholder.treeId };
      applyFilterAndRender();
    },
  };
}

// Filter the in-memory records by the live query and render the PLANS TAB only (never the
// Contents/ToC tab — buildToc is not called here). Updates `#plan-count` to the "N of M" form
// while filtering (N = shown files, M = total files), or the plain "M file(s)" form when the
// query is empty. An empty result under a non-empty query shows the `.filter-empty` affordance.
// After rendering, matched substrings are highlighted in the visible `.plan-title` / `.plan-src`
// (a heading-only match still shows its row, un-highlighted).
export function applyFilterAndRender(): void {
  if (!planListEl) return;
  // Collapse the sidebar plan-list RemoteData to the records to render. Only `success` carries rows; the
  // other four states render the same empty sidebar this app has always shown for the pre-load / empty /
  // failed-initial states (no separate loading or error UI exists). `currentRecords()` is exactly that
  // collapse (unwrapOr(listState, [])) — the same array the cwd late-patch mutates and every other reader
  // in this file goes through, so the sidebar render and the by-path lookups cannot drift.
  const records = currentRecords();
  const total = records.length;
  const shown = filterRecords(records, filterQuery);

  if (shown.length === 0 && filterQuery.trim() !== "") {
    // Non-empty query with no matches ⇒ empty-state affordance (NOT an empty list).
    planListEl.replaceChildren();
    // The live-run placeholder is ALWAYS visible regardless of the filter query (it represents
    // live work, not a record the filter can match) — prepend it above the empty-state note.
    // SAME visibility predicate as renderSidebar (checked against the rendered records — here
    // the empty `shown` set, so a set placeholder always passes) so the two sites cannot drift.
    const ctx = makeSidebarCtx();
    const ph = ctx.placeholder ?? null;
    if (ph && placeholderVisible(ph, shown)) planListEl.appendChild(buildPlaceholderRow(ph, ctx));
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No matching plans";
    planListEl.appendChild(empty);
  } else {
    renderSidebar(planListEl, shown, makeSidebarCtx());
    highlightVisibleRows(filterQuery);
  }

  if (planCountEl) {
    planCountEl.textContent = planCountText(shown.length, total, filterQuery);
  }
}

// Re-wrap the matched substring in a `<mark>` across every rendered `.plan-title` / `.plan-src`
// in #plan-list, reading each element's current text. Re-applied on every filter render and
// after a late cwd patch, so highlights survive a cwd arriving after the initial render. An
// empty query clears any marks (highlightInto emits plain text).
function highlightVisibleRows(query: string): void {
  if (!planListEl) return;
  for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>(".plan-title, .plan-src"))) {
    highlightInto(el, el.textContent ?? "", query);
  }
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

// The `.plan-src` / `#doc-src` text for a stem from the resolved cache alone (empty until
// resolved; "unknown" once resolved-but-null; home-collapsed path once resolved).
function cwdDisplayForStem(stem: Stem): string {
  const s = cwdState(cwdByStem, stem);
  switch (s.state) {
    case "unresolved":
      return "";
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// Filename stem (no `.md`) from an absolute plan path. Mirrors the backend stem.
function stemFromPath(absPath: AbsPath): Stem {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  return asStem(base.endsWith(".md") ? base.slice(0, -3) : base);
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

// ---- execution-model badge + picker ---------------------------------------------------------

// A stable digest of every node's DISPLAYED model + override source. The onSnapshot observer compares
// this against lastBadgeSig and re-renders the sidebar only on a change, so a model override flips the
// badge in-session without re-rendering on every unrelated snapshot.
function badgeSignature(root: TreeNode): string {
  const parts: string[] = [];
  const visit = (node: TreeNode, prefix: NodePath): void => {
    const displayed = node.execution_model ?? nodeExecutionModel(node).options;
    parts.push(`${pathKey(prefix)}:${displayed.model}/${displayed.effort ?? ""}:${node.model_source ?? ""}`);
    if (node.state.stage === "split") {
      for (const child of node.state.children) visit(child, [...prefix, child.nn]);
    }
  };
  visit(root, []);
  return parts.join("|");
}

// The TRIAGE-ALIGNED override options for a picker segment. The dispatched {model, effort} must match
// the triage default for that model, NOT the raw PRESET_OPTIONS effort — otherwise "override to the
// already-recommended model" would silently downgrade effort (PRESET_OPTIONS' Fable is effort:"low";
// triage's Fable is "high") and flip the node to override for no real change. Opus defaults to
// DEFAULT_EFFORT ("high", matching triage's decomposition/large Opus); the inline effort row lets the
// user pick a different Opus effort once Opus is selected.
function overrideOptionsFor(preset: ModelPreset): ModelOptions {
  switch (preset) {
    case "opus-4-8":
      return buildOptions("claude-opus-4-8", DEFAULT_EFFORT);
    case "sonnet-5":
      return buildOptions("claude-sonnet-5", "medium");
    case "fable-5":
      return buildOptions("claude-fable-5", "high");
  }
}

// The picker segments, in the prototype's display order (Opus / Sonnet / Fable). MODEL_PRESETS is the
// roster but in a different order, so this fixes only the visual order — the roster stays single-source.
const PICKER_PRESETS: readonly ModelPreset[] = ["opus-4-8", "sonnet-5", "fable-5"];

// Resolve the open plan to its live plan-tree node (or null: no run, foreign tree, unresolved path).
function openPlanLiveNode(): { node: TreeNode; path: NodePath } | null {
  const op = openPath();
  if (!op || !orchSnapshot) return null;
  const rec = currentRecords().find((r) => r.absolute_path === op) ?? null;
  if (!rec || !rec.tree_id || rec.tree_id !== orchSnapshot.treeId) return null;
  return resolveNodeByNnPath(orchSnapshot.root, rec.nn_path);
}

// Render (or hide) the reading-pane "Execution model" picker for the open plan. Visible ONLY when the
// open plan maps to a live node (a static/legacy plan has nothing to recommend or override). Rebuilt
// from scratch on each call (openPlan + every onSnapshot) so the `.on` segment / recommendation /
// override state track the live snapshot.
function renderModelBar(): void {
  const bar = modelBarEl;
  if (!bar) return;
  const hit = openPlanLiveNode();
  if (!hit) {
    bar.classList.add("hidden");
    bar.replaceChildren();
    return;
  }
  const { node, path } = hit;
  const current = node.execution_model ?? nodeExecutionModel(node).options;
  const currentClass = presetClassForModel(current.model);
  const overridden = node.model_source === "override";
  const triage = nodeExecutionModel(node);

  bar.replaceChildren();
  bar.classList.remove("hidden");

  const row1 = document.createElement("div");
  row1.className = "row1";

  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "Execution model";
  row1.appendChild(lbl);

  const seg = document.createElement("div");
  seg.className = "seg";
  for (const preset of PICKER_PRESETS) {
    const family = preset.split("-")[0];
    const btn = document.createElement("button");
    btn.dataset.preset = preset;
    btn.classList.add(family);
    if (family === currentClass) btn.classList.add("on");
    btn.textContent = friendlyModelName(PRESET_OPTIONS[preset].model) ?? preset;
    seg.appendChild(btn);
  }
  row1.appendChild(seg);

  if (overridden) {
    const ovr = document.createElement("span");
    ovr.className = "overridden";
    ovr.textContent = "overridden by you";
    row1.appendChild(ovr);
  } else {
    const recpill = document.createElement("span");
    recpill.className = "recpill";
    recpill.textContent = `Recommended: ${friendlyModelName(triage.options.model) ?? triage.options.model}`;
    row1.appendChild(recpill);
  }
  bar.appendChild(row1);

  // Opus exposes an inline effort row (low…max). Non-Opus presets carry their effort on the preset,
  // so no effort UI is shown for them. The active button is the node's current effort (DEFAULT_EFFORT
  // when unset); choosing a different level dispatches an Opus override at that effort.
  if (currentClass === "opus") {
    const activeEffort: EffortLevel = isEffortLevel(current.effort)
      ? current.effort
      : DEFAULT_EFFORT;
    const row2 = document.createElement("div");
    row2.className = "row2";

    const elbl = document.createElement("span");
    elbl.className = "lbl";
    elbl.textContent = "Effort";
    row2.appendChild(elbl);

    const eseg = document.createElement("div");
    eseg.className = "seg";
    for (const level of EFFORT_LEVELS) {
      const btn = document.createElement("button");
      btn.dataset.effort = level;
      btn.classList.add("opus");
      if (level === activeEffort) btn.classList.add("on");
      btn.textContent = level;
      eseg.appendChild(btn);
    }
    row2.appendChild(eseg);
    bar.appendChild(row2);

    // Fresh listener each render so it closes over THIS render's live NodePath.
    eseg.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest("button[data-effort]") : null;
      if (!(btn instanceof HTMLElement)) return;
      const level = btn.dataset.effort;
      if (!isEffortLevel(level)) return;
      // Self-no-op: re-selecting the active effort would re-stamp an identical override (flipping an
      // auto node to override for no real change), so it is inert — mirrors the model-segment guard.
      if (level === activeEffort) return;
      if (modelSetDispatch === "inflight") return;
      modelSetDispatch = "inflight";
      void (async () => {
        try {
          await getOrchestrator().setExecutionModel(path, buildOptions("claude-opus-4-8", level));
        } catch (e) {
          console.error("model picker: setExecutionModel (effort) failed", e);
        } finally {
          modelSetDispatch = "idle";
        }
      })();
    });
  }

  const rationale = document.createElement("div");
  rationale.className = "rationale";
  rationale.textContent = triage.rationale;
  bar.appendChild(rationale);

  // Fresh listener each render so it closes over THIS render's live NodePath (the node can move
  // between snapshots).
  seg.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("button[data-preset]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const preset = btn.dataset.preset;
    if (!preset || !(MODEL_PRESETS as readonly string[]).includes(preset)) return;
    // Self-no-op: clicking the already-`.on` segment of a NON-overridden (auto) node must not
    // dispatch. The reducer always stamps model_source:"override", and there is no "reset to
    // recommended", so dispatching here would irreversibly flip auto→override for no real change.
    // (An already-overridden node stays clickable — re-clicking re-asserts / can pick a new model.)
    if (!overridden && preset.split("-")[0] === currentClass) return;
    if (modelSetDispatch === "inflight") return;
    modelSetDispatch = "inflight";
    void (async () => {
      try {
        await getOrchestrator().setExecutionModel(path, overrideOptionsFor(preset as ModelPreset));
      } catch (e) {
        console.error("model picker: setExecutionModel failed", e);
      } finally {
        modelSetDispatch = "idle";
      }
    })();
  });
}

// Render (or hide) the conversation-header chip that shows the model the ACTIVE session is running
// right now. Visible ONLY while an orchestration is active with a live active node; hidden otherwise
// (no run, or the terminal/acceptance window where activePathOf is null). The displayed {model, effort}
// is the orchestrator's own effectiveModel(activeNode) — the SAME override-aware resolution the
// dispatch seam asserts via setModel — so the chip can never drift from what the session actually runs.
// The tooltip carries the phase's triage rationale ("why this model"). Rebuilt from scratch each call.
function renderModelChip(): void {
  const chip = convModelChipEl;
  if (!chip) return;
  const snap = orchSnapshot;
  const activeP = snap && isOrchestrationActive() ? activePathOf(snap.root) : null;
  const node = activeP ? nodeAtPath(snap!.root, activeP) : null;
  if (!node) {
    chip.classList.add("hidden");
    chip.replaceChildren();
    chip.removeAttribute("title");
    return;
  }
  const opts = effectiveModel(node);
  const cls = presetClassForModel(opts.model);
  chip.className = `conv-model-chip${cls ? ` ${cls}` : ""}`;
  chip.replaceChildren();

  const name = document.createElement("span");
  name.className = "cm-name";
  name.textContent = friendlyModelName(opts.model) ?? opts.model;
  chip.appendChild(name);

  if (opts.effort) {
    const eff = document.createElement("span");
    eff.className = "cm-effort";
    eff.textContent = opts.effort;
    chip.appendChild(eff);
  }

  chip.title = phaseModel(node).rationale;
}

// ---- Tabbed left panel + table of contents (sidebar domain) ------------------------------
//
// The ToC is the ONE sanctioned reading-pane → sidebar data flow, mediated entirely by the
// render facade: `extractToc(readingPaneEl)` produces a plain `TocEntry[]` (read-only on the
// pane), and `buildToc` consumes that list to populate `#toc-list`. This module never queries
// or mutates `#reading-pane` directly — only via `extractToc` / `scrollToHeading`.

// Render a ToC into `listEl` from a plain entry list. One `.toc-item.toc-h1|.toc-h2` per entry
// carrying `data-line`; a click smooth-scrolls the reader to that heading and flashes the
// clicked row only (transient affordance — NOT scroll-spy). An EMPTY list renders the
// `.toc-empty` "No headings" affordance (caller only passes [] when a plan IS open — the
// nothing-open state clears the list instead). MUST NOT touch any `.tab`/`.tab-pane` `.active`
// class: the active tab is preserved across both open and live reload (no auto-switch).
export function buildToc(listEl: HTMLElement, entries: TocEntry[]): void {
  listEl.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "No headings";
    listEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("a");
    item.className = `toc-item toc-h${entry.level}`;
    item.dataset.line = String(entry.line);
    item.textContent = entry.text;
    item.addEventListener("click", () => {
      if (readerScrollEl && readingPaneEl) {
        scrollToHeading(readerScrollEl, readingPaneEl, entry.line);
      }
      // Flash the clicked row only, then clear (transient click affordance, no scroll-spy).
      for (const el of Array.from(listEl.querySelectorAll(".toc-item.flash"))) {
        el.classList.remove("flash");
      }
      item.classList.add("flash");
      setTimeout(() => item.classList.remove("flash"), 600);
    });
    listEl.appendChild(item);
  }
}

// Rebuild the ToC from the current rendered pane. Called ONLY from inside the render-generation
// guarded region in openPlan/reloadOpenPlan (after the final isCurrent check passes) so a
// superseded render can never clobber a newer render's ToC. Never changes the active tab.
function rebuildTocFromPane(): void {
  if (!tocListEl || !readingPaneEl) return;
  buildToc(tocListEl, extractToc(readingPaneEl));
}

// Open a plan: read raw text into #reading-pane, mark the row active, update the header.
// Mutates the module singletons selection / commentCount / renderGuard and the reading-pane
// DOM-handle lets.
export async function openPlan(path: AbsPath, stem: Stem): Promise<void> {
  if (!readingPaneEl) return;

  // Navigation is FREE and never touches pendingReviews. "Viewing a review" is derived from
  // openPath (see currentReviewId), so simply opening a plan flips the bar to VIEWING (if this is a
  // reviewed plan's file) or SUMMARY (if a review is pending elsewhere) via the refreshReviewBar()
  // call at the end of this function — no teardown/auto-resurface logic. Set the selection union
  // SYNCHRONOUSLY up front (so openPath() reflects it before any await): a sentinel path becomes the
  // `sentinel` variant (no real file — its cwd rides the synthetic record); any other path is `plan`.
  // INVARIANT[selection-set-synchronously-before-await-in-openPlan] (runtime-guard): openPlan assigns `selection` synchronously at the top, before any await, so openPath() reflects the new target throughout.
  //   prevents: a post-await derivation reading a stale selection mid-open
  selection = isResumeSentinel(path)
    ? {
        k: "sentinel",
        treeId: resumeSentinelTreeId(path),
        cwd: currentRecords().find((r) => r.absolute_path === path)?.cwd ?? null,
      }
    : { k: "plan", path };

  // Take a render generation: any later open/reload bumps the guard and supersedes this
  // render, so its post-await pane mutations are skipped (no stale content landing late).
  const gen = renderGuard.begin();

  // A synthetic resume-sentinel row has NO real file behind it: never route its path through the
  // plans channel (read_plan_contents / set_open_plan / mark_viewed all reject a sentinel — Rust
  // canonicalize fails on the scheme string). Detect once up front so every file-touching step below
  // is skipped for it; the reading pane gets a graceful placeholder + the resume banner still fires.
  const sentinel = isResumeSentinel(path);

  // Record the open plan so the backend holds it read by fiat (live-edits won't re-bold it). Skipped
  // for a sentinel (set_open_plan would reject — no file).
  if (!sentinel) {
    try {
      await invoke("set_open_plan", { path });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // A newer open superseded us while set_open_plan was in flight — bail before mutating the
  // sidebar/header so a slow A-then-fast-B double click can't leave the header/active row on A
  // while the (correctly guarded) pane shows B. openPath is already set synchronously and the
  // newer call owns the header, so the stale call must do nothing here.
  if (!renderGuard.isCurrent(gen)) return;

  // Reflect .active selection in the sidebar without a full re-list, and locally clear the
  // unread marker on the just-opened row (it is read the moment it's opened).
  if (planListEl) {
    // While a rendered live-run placeholder holds `.active`, IT is the single active row — real
    // rows cede `.active` here too (mirrors renderSidebar's suppression so the two sites agree).
    // Sidebar clicks never hit this: ctx.onOpen strips the placeholder's selection before calling
    // openPlan. The unread clearing below is unconditional — opening a plan always reads it.
    const placeholderHoldsActive = planListEl.querySelector(".plan.placeholder.active") !== null;
    // Rows are no longer all direct children of #plan-list — subs live inside .master > .children.
    // Iterate every row by data-path so nested sub rows also get .active/.unread updated.
    for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>("[data-path]"))) {
      const isThis = el.dataset.path === path;
      el.classList.toggle("active", isThis && !placeholderHoldsActive);
      if (isThis) el.classList.remove("unread");
    }
  }

  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  // A sentinel's `stem` is the tree_id (display-incidental, not a filename) — show the tree's title
  // (from its synthetic record's `h1s`) instead of an ugly `<tree_id>.md`. Real rows keep `<stem>.md`.
  const sentinelRec = sentinel ? currentRecords().find((r) => r.absolute_path === path) ?? null : null;
  if (docFilenameEl) {
    docFilenameEl.textContent = sentinel
      ? sentinelRec?.h1s?.[0] ?? "Plan in progress"
      : `${stem}.md`;
  }
  // Late-patch the reader header cwd from the resolved cache (empty until resolved).
  patchDocSrc();

  if (sentinel) {
    // SENTINEL PANE: there is no plan `.md` to read — render a graceful placeholder INSIDE the
    // render-generation guard (so a fast switch to/from this row can't land stale content). Prefer
    // the tree's INTENT.md (the original request, written under `.plan-tree/`) when readable, else a
    // static "in progress" note. The resume banner (fired below) carries the actual forward action.
    // The tree's INTENT.md is an OPTIONAL `.plan-tree/` read modeled as RemoteData via fromNullable:
    // an ABSENT file (null) → zeroResults, present → success, a thrown read → error, and "cwd not yet
    // resolved" → initial (the read never fires). The match (all five arms) collapses to the markdown
    // to paint — only a present, NON-BLANK INTENT renders; every other arm falls back to the static
    // in-progress note. The render block below is byte-for-byte unchanged (same gen gating); only the
    // present/absent/blank decision moved into the RemoteData fold.
    let intentRead: RemoteData<string> = initial();
    const cwd = sentinelRec ? resolvedCwdFor(sentinelRec) : null;
    if (cwd !== null) {
      try {
        intentRead = fromNullable(
          await invoke<string | null>("read_plan_tree_file", { cwd, name: "INTENT.md" }),
        );
      } catch (e) {
        console.debug("openPlan: sentinel INTENT.md read failed", e);
        intentRead = failure(String(e)); // missing/IO-error ⇒ fall back to the static placeholder.
      }
    }
    // A newer open superseded us while reading INTENT.md — drop this stale render.
    if (!renderGuard.isCurrent(gen)) return;
    const STATIC_PLACEHOLDER = "_This plan is in progress. Use **Resume** above to continue it._";
    const intentMd = foldRemoteData(intentRead, {
      initial: () => STATIC_PLACEHOLDER,
      fetching: () => STATIC_PLACEHOLDER,
      zeroResults: () => STATIC_PLACEHOLDER,
      // A present-but-blank INTENT.md (success("") / whitespace) is treated as no intent.
      success: (text) => (text.trim() !== "" ? text : STATIC_PLACEHOLDER),
      error: () => STATIC_PLACEHOLDER,
    });
    readingPaneEl.classList.remove("raw");
    renderInto(readingPaneEl, intentMd, cwd ?? dirOf(path));
    // switching to a sentinel is a genuine plan change (openPath now reads the sentinel
    // scheme) — discard any draft owned by the previously-open real plan. See openPlan's plan-text
    // site for the full rationale.
    invalidatePopover(readingPaneEl);
    readerScrollEl?.scrollTo({ top: 0 });
    await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
    if (!renderGuard.isCurrent(gen)) return;
    rebuildTocFromPane();
  } else {
    const pane = readingPaneEl; // non-null past the guard at the top of openPlan (for the error arm)
    // The reading-pane content read modeled as a ScalarRemoteData<string>: a resolved read is
    // success(text) — an EMPTY plan is success(""), NEVER zeroResults — and a rejected read is
    // error(message). Only the local representation changes to RemoteData; the render-generation
    // gating below stays byte-for-byte (the post-read isCurrent gate still fences the write before it
    // can land in the pane). Do NOT fold freshness INTO the RemoteData — the seq/gen guard is the
    // supersession authority and is left untouched.
    let content: ScalarRemoteData<string>;
    try {
      content = success(await invoke<string>("read_plan_contents", { path }));
    } catch (e) {
      console.error("read_plan_contents failed", e);
      // String(e) (not e.message) preserves the EXACT pane text rendered today.
      content = failure(String(e));
    }
    // A newer open/reload superseded us while reading — drop this stale render. THIS is the freshness
    // gate the new RemoteData write must pass before it lands in the pane (it also fences the error-arm
    // write, exactly as the original catch's own isCurrent check did). Removing it lets a slow older
    // read clobber a newer render — see src/main.reading-pane-remote-data.test.ts.
    if (!renderGuard.isCurrent(gen)) return;
    // Fold the four reachable scalar states. success → the markdown to render; error → paint the
    // failure pane (a side effect) and yield null; initial/fetching are unreachable for a just-awaited
    // read and yield null (no render). md === null means "skip the success pipeline" — the trailing
    // affordance refresh still runs (matching the original error-path fallthrough).
    const md = matchScalar<string, string | null>(content, {
      initial: () => null,
      fetching: () => null,
      success: (text) => text,
      error: (message) => {
        pane.classList.add("raw");
        pane.textContent = `Could not read plan: ${message}`;
        // Read failed — clear the ToC so no stale entries point at headings that no
        // longer rendered. (Cleared, not "No headings": there is no valid ToC here.)
        tocListEl?.replaceChildren();
        return null;
      },
    });
    if (md !== null) {
      // render full-fidelity markdown into #reading-pane. New opens
      // start at the top.
      renderInto(readingPaneEl, md, dirOf(path));
      // the popover lives OUTSIDE #reading-pane, so it SURVIVES this innerHTML wipe. Now that
      // the fresh DOM is in place and openPath() (== getPlanPath) reflects this plan, invalidate it: a
      // genuine plan switch (draft.planPath !== openPath()) DISCARDS the stale draft; a same-plan
      // re-open PRESERVES it and re-anchors its range against these fresh nodes. MUST run AFTER
      // renderInto (re-anchor needs the new nodes) and AFTER the synchronous selection flip up top (so
      // a switch is seen as a path change). renderInto only runs for the current render (it sits inside
      // the post-read isCurrent guard), so a superseded open never reaches this call.
      // INVARIANT[popover-draft-discarded-on-plan-switch-preserved-on-reopen] (runtime-guard): invalidatePopover compares the draft's planPath against the just-set openPath() — a genuine switch discards the draft, a same-plan reopen re-anchors it.
      //   prevents: a cross-plan draft surviving a switch and re-anchoring against the wrong document
      invalidatePopover(readingPaneEl);
      readerScrollEl?.scrollTo({ top: 0 });
      // INVARIANT[render-generation-guard-cancels-superseded-settles] (runtime-guard): settle is handed `() => renderGuard.isCurrent(gen)`, so a superseded render's settle is cancelled the moment a newer render takes the generation.
      //   prevents: a late settle from a stale render mutating the pane after a newer plan opened
      await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
      // settle() is async; a newer render may have begun while it ran. Bail so a late
      // settle from a superseded render does not touch the pane.
      if (!renderGuard.isCurrent(gen)) return;
      // Rebuild the ToC INSIDE the guarded region (this render won) so a superseded
      // render can never clobber it with stale entries. Does not change the active tab.
      rebuildTocFromPane();
      // re-apply persisted highlights. loadCommentsFor is cached per-path (a
      // cache-miss is the only real IPC window). The post-await isCurrent re-check is MANDATORY:
      // it mirrors every other awaited mutation here, so a fast A→B switch can't let A's late
      // load resolve and applyComments mutate B's pane.
      const recs = await loadCommentsFor(readingPaneEl, path);
      if (!renderGuard.isCurrent(gen)) return;
      applyComments(readingPaneEl, recs);
      // Cold-read the authoritative count for the just-opened plan.
      void refreshCommentCount();
    }
  }

  // Persist the view: clears the unread state for this plan (backend stamps
  // viewed = max(now, mtime+1)). Belt-and-suspenders alongside the open-path fiat. Skipped for a
  // sentinel (mark_viewed would reject — no file).
  if (!sentinel) await markViewed(path);

  // openPath is now set + the plan rendered: re-derive BOTH affordances. The bar flips to
  // VIEWING (this plan is a pending review's file) / SUMMARY (a review pending elsewhere) / hidden, and
  // the resume banner re-evaluates the open plan's `.plan-tree/state.json` — but only when nothing
  // higher occupies the bar (precedence prototype > acceptance > review > resume). NOT guarded by
  // renderGuard — the affordances reflect pending-review state + openPath, not the rendered pane
  // content. refreshCommentCount (fired un-awaited above) re-refreshes the bar once the count lands.
  // refreshAffordances is fire-and-forget for the resume read and guards a fast A→B switch internally.
  refreshAffordances();

  // Reading-pane execution-model picker: visible only when this plan maps to a live node.
  renderModelBar();

  // Conversation-history reconstruction (silent populate): replay this plan's PAST conversation into
  // the CONVERSATION tab without switching tabs — the user stays on PLAN; the reconstruction is ready
  // when they click over. Fire-and-forget like refreshResumeBanner. A NO-OP whenever a live session
  // or an orchestration owns the conversation pane (guarded inside loadHistoryForPlan), so it can
  // never disturb an in-progress run; supersession of a fast A→B switch is guarded via historyGen.
  // SKIPPED for a sentinel: its `stem` is the tree_id (NOT a transcript-resolvable filename stem), so
  // loadPlanHistory would fire a full read_plan_transcript corpus scan that always misses and paints a
  // misleading empty Conversation tab. The live run (if any) owns that pane via the orchestrator.
  if (!sentinel) loadPlanHistory?.(stem);
}

// Live-reload the currently-open plan, preserving the reading position with an
// element/source-line anchor that survives async render height changes. We
// capture the anchored block BEFORE re-render, apply the delta once after the
// synchronous text lands, then re-apply after settle() so mermaid/image height
// shifts don't drift the viewport.
export async function reloadOpenPlan(): Promise<void> {
  const path = openPath();
  if (!readingPaneEl || !readerScrollEl || path === null) return;
  // A reviewed plan is now a REAL file, so a live edit to it reloads normally (Claude revising the
  // plan after a deny updates the file in place — the user sees the revision live).
  // A synthetic resume sentinel has no file to reload (read_plan_contents would reject). Its pane is
  // a static placeholder painted in openPlan; a live `.plan-tree/state.json` edit re-surfaces via the
  // banner, not a pane reload. Bail before the read so no spurious "reload failed" is logged.
  if (isResumeSentinel(path)) return;
  // Take a render generation BEFORE the read: a newer open/reload supersedes us and our
  // post-await pane mutations (renderInto + the two applyDelta calls) are skipped, so an
  // older reload can never clobber a newer one.
  const gen = renderGuard.begin();
  const anchor = captureAnchor(readerScrollEl);
  // The reload's content read modeled as a ScalarRemoteData<string>: success(text) on a resolved read
  // (an empty plan is success(""), never zeroResults), error(message) on a rejected one (logged in the
  // catch). Only the representation changes; the render-generation gating below stays byte-for-byte.
  let content: ScalarRemoteData<string>;
  try {
    content = success(await invoke<string>("read_plan_contents", { path }));
  } catch (e) {
    console.error("reload failed (plan may have been removed)", e);
    content = failure(String(e));
  }
  // Superseded while reading — drop this stale reload entirely (the freshness gate the new RemoteData
  // write must pass before it lands; a failed read leaves the pane untouched either way).
  if (!renderGuard.isCurrent(gen)) return;
  const md = matchScalar<string, string | null>(content, {
    initial: () => null,
    fetching: () => null,
    success: (text) => text,
    error: () => null, // the throw was already logged in the catch; a failed reload leaves the pane as-is
  });
  if (md === null) return;
  renderInto(readingPaneEl, md, dirOf(path));
  // a live reload keeps the SAME open plan (openPath unchanged), so this PRESERVES the
  // user's in-progress draft and re-anchors its range against the freshly-rendered nodes — the app
  // auto-reloads a plan WHILE it is being built, so hiding the draft on every reload would be a
  // regression. MUST run after renderInto (re-anchor needs the new DOM). See render/comments.ts.
  invalidatePopover(readingPaneEl);
  applyDelta(readerScrollEl, anchor);
  await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
  // settle() is async; bail so a superseded reload's second applyDelta never runs.
  if (!renderGuard.isCurrent(gen)) return;
  applyDelta(readerScrollEl, anchor);
  // Rebuild the ToC INSIDE the guarded region so a live edit that adds/removes a
  // heading updates the Contents tab in place. Never changes the active tab.
  rebuildTocFromPane();
  // on a live reload the cache for this path is invalidated and re-read from the
  // backend (loadCommentsFor re-invokes io.load), then highlights re-apply. The post-await
  // isCurrent re-check is MANDATORY (see openPlan) so a superseded reload never wraps
  // highlights into a newer plan's pane.
  const recs = await loadCommentsFor(readingPaneEl, path);
  if (!renderGuard.isCurrent(gen)) return;
  applyComments(readingPaneEl, recs);
  void refreshCommentCount();
}

// Filename stem from an absolute plan path (no `.md`). Reuses stemFromPath for the basename rule.
function stemFromBasename(absPath: string): Stem {
  return stemFromPath(asAbsPath(absPath));
}

// REFUSE-and-surface: a pending review whose REAL plan file cannot be opened (empty planFilePath, or
// openPlan threw — file missing / outside plans dir) is UN-ACTIONABLE. Faking a detached render here
// would leave openPath untouched, so currentReviewId() returns null → the bar falls to SUMMARY mode
// (Submit/Dismiss hidden; their handlers bail on the null guards) while the dead review is STILL
// counted ("N plans awaiting review") — a phantom that traps navigation but can never be acted on.
//
// An un-openable plan can never be reviewed, so we RELEASE the held producer with a DENY before
// dropping the review — leaving it held would hang the agent. The release is SOURCE-AWARE (delegated
// to resolveReview, which dispatches per source AND already drops the review + refreshes the bar):
//   • in-process — resolveReview denies via resolve_tool_permission(allow:false), freeing the SDK
//     canUseTool seam (mirrors the write_agent_plan-failure path in handleToolPermissionRequested,
//     which auto-denies the same way). There is NO terminal for an in-process review.
//   • external   — resolveReview denies via respond_to_review("deny"), freeing the terminal hook so
//     Claude stays in plan mode and can retry, instead of leaving it blocked until its ~570s timeout.
// resolveReview surfaces #hook-status only on failure; we set the source-appropriate refuse message
// AFTER it so our message wins on the success path, and we belt-and-suspenders the drop + refresh in
// case resolveReview short-circuited (e.g. the entry was already gone under the chained-event race).
async function refuseUnopenableReview(review: PendingReview): Promise<void> {
  console.error("plan review: the review's plan file could not be opened; refusing", review.reviewId);
  await resolveReview(review.reviewId, "deny", "Could not open the plan for review; aborting.");
  pendingReviews.delete(review.reviewId);
  // Surface removal can un-suppress the resume banner — re-derive both surfaces.
  refreshAffordances();
  setHookStatus(
    hookStatusEl,
    review.source === "in-process"
      ? "Couldn't open the plan for review — asked the agent to re-plan."
      : "Couldn't open the plan for review — released the hook so Claude can re-plan.",
    "error",
  );
  setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
}

// Open a pending review's REAL plan file through the NORMAL plan-open flow (Option A). Refresh the
// sidebar list FIRST so the just-written plan's `[data-path]` row exists, then openPlan(...) — which
// selects that row, persists/loads its comments on its real path, and live-reloads. The bar then
// derives VIEWING from openPath. If planFilePath is empty or the open fails (file missing / outside
// plans dir) the review is REFUSED (refuseUnopenableReview) rather than rendered as an unactionable
// phantom. `review` MUST already be tracked in pendingReviews (the caller adds it).
async function openReviewPlanFile(review: PendingReview): Promise<void> {
  if (!review.planFilePath) {
    await refuseUnopenableReview(review);
    return;
  }
  // Refresh the sidebar so the just-written plan row exists before we select it. (openPlan applies
  // .active by data-path; the row must be present at/after open for the selection invariant to hold.)
  await refreshList();
  try {
    await openPlan(asAbsPath(review.planFilePath), stemFromBasename(review.planFilePath));
  } catch (e) {
    console.error("plan review: openPlan of the real file failed", e);
    await refuseUnopenableReview(review);
    return;
  }
  refreshReviewBar();
}

// Max age (ms) before a pending review is considered STALE: its blocking hook has already timed
// out, so its request file describes a dead review whose Submit/Dismiss would be a silent no-op.
// Stale entries are filtered out of launch recovery.
const STALE_REVIEW_MS = 600_000;

// Pick the NEWEST pending review (max createdMs). Tie-break MUST favor the LATER-INSERTED review on
// equal createdMs: two reviews can arrive within the same millisecond (createdMs falls back to
// Date.now()), and `pendingReviews` is a Map iterated in INSERTION order, so the last-inserted entry
// is the genuinely most-recent arrival. `>=` picks the later-inserted entry, making this deterministic.
function newestPendingReview(): PendingReview | null {
  let newest: PendingReview | null = null;
  for (const r of pendingReviews.values()) {
    if (newest === null || r.createdMs >= newest.createdMs) newest = r;
  }
  return newest;
}

// Open a held gate's plan via the SAME flow onAwaitingApproval uses: flip to the Plan tab
// synchronously (before any await), refresh the list so the plan's row exists, open it (selecting the
// row + driving viewingGate), then re-assert the tab + bar. Shared by the gate observer and the
// "Resume newest" path so both re-open a gate identically.
// INVARIANT[openGatePlanFile-shared-by-both-gate-paths] (convention): the gate observer and the Resume path both re-open a held gate's plan through this one sequence.
//   prevents: the two gate-open paths diverging
async function openGatePlanFile(planPath: string): Promise<void> {
  switchToPlanTab();
  await refreshList();
  try {
    await openPlan(asAbsPath(planPath), stemFromBasename(planPath));
  } catch (e) {
    console.error("gate: openPlan of the pointed-at plan failed", e);
  }
  switchToPlanTab();
  refreshReviewBar();
}

// resume the NEWEST pending SURFACE (derived from pendingSurfaces(), so it agrees with the
// SUMMARY-mode count). A held orchestrator gate is the live, most-immediate surface: re-open its plan
// via the SAME open path onAwaitingApproval uses (switching the bar back to VIEWING). Otherwise resume
// the newest pending review's real plan file. No-op if nothing is pending. The hook/gate is untouched.
function resumeNewestReview(): void {
  const surfaces = pendingSurfaces();
  if (surfaces.length === 0) return;
  // INVARIANT[gate-preferred-over-newer-external-review] (precedence): a held orchestrator gate is found first among the pending surfaces, so Resume re-opens it regardless of a newer external review.
  //   prevents: a newer external review opening instead of the live held gate
  const gateSurface = surfaces.find((s) => s.kind === "orchestrator-gate");
  if (gateSurface && gateSurface.kind === "orchestrator-gate") {
    void openGatePlanFile(gateSurface.gate.planPath);
    return;
  }
  const newest = newestPendingReview();
  if (newest !== null) void openReviewPlanFile(newest);
}

// One serialized `plan-changed` handler body. Runs to completion before the next queued
// event begins (chained on `pending` in the listener) so refreshList/reloadOpenPlan from
// different events never interleave.
async function handlePlanChanged(changedPath: AbsPath): Promise<void> {
  // INVARIANT[sentinel-touches-no-file-io] (runtime-guard): a synthetic resume sentinel is guarded out of every file-backed IPC (set_open_plan / mark_viewed) in this handler.
  //   prevents: backend rejections / "reload failed" logs for a row with no real file
  // Keep the backend's notion of the open plan current (belt-and-suspenders; the open
  // plan is also held read by fiat backend-side). A synthetic resume sentinel has no real file —
  // set_open_plan would reject — so skip it (a sentinel's read-state is not tracked backend-side).
  const op = openPath();
  if (op !== null && !isResumeSentinel(op)) {
    try {
      await invoke("set_open_plan", { path: op });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // INVARIANT[open-plan-stamped-viewed-before-relist] (runtime-guard): when the open plan is the changed file, markViewed runs before refreshList / list_plans.
  //   prevents: the sidebar momentarily bolding the plan the user is actively watching
  // If the OPEN plan changed, stamp it viewed BEFORE re-listing so list_plans never
  // momentarily bolds it (in addition to the open-path fiat). A sentinel is never a real
  // `changedPath` (no file watched), so this branch never runs for one — guard regardless.
  if (op !== null && changedPath === op && !isResumeSentinel(op)) {
    await markViewed(op);
  }

  await refreshList();

  // INVARIANT[reload-target-re-read-after-relist] (runtime-guard): the reload target is re-read from openPath() AFTER refreshList, so a collapsed selection yields nothing to reload.
  //   prevents: a reload firing against a path the same refresh just collapsed
  // Re-read openPath AFTER refreshList: a `plan` selection whose file just vanished has collapsed to
  // `none` (resolveSelection), so there is nothing to reload.
  const opAfter = openPath();
  if (opAfter !== null && changedPath === opAfter) {
    await reloadOpenPlan();
  }
}

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
      annotate?.destroy();
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
    attachImages: (imgs) => conversationHandle?.attachImages(imgs),
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
  // Working-reference checkbox: classifies the prototype approval (sketch vs floor).
  prototypeWorkingRefEl = document.querySelector("#prototype-working-ref");
  prototypeWorkingRefLabelEl = document.querySelector("#prototype-working-ref-label");
  // Capture the external Submit button's descriptive label so an in-process relabel can be reverted
  // exactly (refreshReviewBar restores this for external reviews).
  if (reviewSubmitEl?.textContent) REVIEW_SUBMIT_EXTERNAL_LABEL = reviewSubmitEl.textContent;
  // Capture #review-approve's default label so PROTOTYPE mode's relabel reverts exactly.
  if (reviewApproveEl?.textContent) REVIEW_APPROVE_DEFAULT_LABEL = reviewApproveEl.textContent;
  hookStatusEl = document.querySelector("#hook-status");

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
    // held (snapshot.pendingApproval set), the flip is SUPPRESSED so streaming frames cannot steal
    // the tab from the Plan view the gate handler just opened. pendingClarify deliberately does NOT
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
  //   • onSnapshot — re-derive the bar after every transition (so it clears when pendingApproval
  //     becomes null after Approve).
  //   • onDone / onFatal — terminal: drop the snapshot and refresh (the bar hides).
  // This observer is a closure inside DOMContentLoaded that mutates the orchSnapshot singleton and the
  // bar DOM handles.
  getOrchestrator().subscribe({
    onSnapshot: (snap) => {
      orchSnapshot = snap;
      // Idle-waiting hint: the visual-prototype gate is TURN-COMPLETION signaled (the intent turn
      // ends with a `result` → session idle → the facade hides its working indicator), so while
      // pendingPrototype is held, tell the conversation facade to keep showing "Waiting for your
      // input…" in the idle state. Derived STRICTLY from the snapshot, so it self-clears:
      // approve/refine null pendingPrototype in the reducer and the very next snapshot turns it off.
      // Also keep the idle-waiting hint up while the forced acceptance gate is held (it is
      // turn-completion signaled like the prototype gate: the run is built and the session is idle,
      // so the facade must not read "done" while the user owes a verdict).
      conversationHandle?.setIdleWaitingHint(snap.pendingPrototype != null || snap.pendingAcceptance != null);
      // Live-run placeholder: the FIRST snapshot of each run (keyed by treeId) mints a
      // placeholder sidebar row — the run has no real row until its plan file lands.
      if (
        isOrchestrationActive() &&
        snap.treeId &&
        !snap.done &&
        runPlaceholder?.treeId !== snap.treeId
      ) {
        runPlaceholder = { treeId: snap.treeId, label: "New plan — drafting…" };
        // Make the placeholder the ACTIVE selection ONLY when nothing real is open. It must NOT clobber
        // a plan/sentinel the user is viewing: the in-process review demo aligns the selection to the
        // gate plan (__setOpenPathForMock) BEFORE this fires, and that selection drives the bar's
        // viewingGate — folding placeholder over it would break VIEWING. When a real plan IS open the
        // row still renders (runPlaceholder above) and goes `.active` via standsInForOpenGatePlan once
        // the held gate's plan is the open one (the FIX-2 stand-in path).
        if (selection.k === "none") selection = { k: "placeholder", treeId: snap.treeId };
        applyFilterAndRender();
        lastBadgeSig = badgeSignature(snap.root); // the render above already painted the fresh badges
      }
      // BADGE LIVE-UPDATE: the sidebar badge is off the default re-render path — a normal
      // EXECUTION_MODEL_SET snapshot mints no placeholder — so re-render the sidebar exactly when a
      // live node's displayed model / override source changed vs the last render. Guarded by the
      // signature so an unrelated snapshot does not re-render the whole sidebar.
      const sig = badgeSignature(snap.root);
      if (sig !== lastBadgeSig) {
        lastBadgeSig = sig;
        applyFilterAndRender();
      }
      // Keep the reading-pane picker in lockstep with the live snapshot (override flips the `.on`
      // segment + recommendation/override state).
      renderModelBar();
      // The conversation-header chip tracks the ACTIVE node's live model (phase transitions +
      // overrides) independently of which plan is open.
      renderModelChip();
      // Re-derive both affordances on every snapshot transition (the resume banner stays suppressed
      // while the run owns the seam — detectResumable null — so this is a no-op for it until onDone).
      refreshAffordances();
    },
    onAwaitingApproval: (gate) => {
      // UNIFIED GATE: decomposition (root included) and leaf gates arrive through the SAME
      // observer hook carrying the SAME ApprovalGate2 shape — no master sentinel, no side-channel
      // path capture. Open the gate's plan file via the NORMAL plan flow; viewingGate() matches the
      // open plan against snapshot.pendingApproval.planPath.
      //
      // ORDER MATTERS: flip to the Plan tab SYNCHRONOUSLY FIRST — before any await —
      // so the user sees the plan view the instant the gate arrives. While the awaits below run,
      // stream frames keep firing onActivity; suppressConversationFlip (keyed on pendingApproval,
      // already set in the snapshot by the time this observer hook fires) keeps them from stealing
      // the tab back. The tab is re-asserted after the awaits as a belt-and-suspenders.
      // openGatePlanFile flips to the Plan tab SYNCHRONOUSLY (before its first await), refreshes the
      // sidebar so the just-written plan's [data-path] row exists, opens it (selecting the row /
      // driving viewingGate), then re-asserts the tab + bar. The placeholder deliberately stays
      // SELECTED through the refresh: openPlan sets selection=plan(gate) synchronously, so the folded
      // placeholderSelected goes false and the gate row carries `.active` — or, if its row still lags,
      // the placeholder keeps standing in via standsInForOpenGatePlan. Shared verbatim with the
      // "Resume newest" path (resumeNewestReview), so a gate re-opens identically either way.
      void (async () => {
        diag(`gate: onAwaitingApproval enter kind=${gate.kind} planPath=${gate.planPath}`);
        await openGatePlanFile(gate.planPath);
        diag("gate: onAwaitingApproval exit (Plan tab asserted)");
      })();
    },
    onPrototypeReview: (gate) => {
      // Visual-prototype gate: flip to the Plan tab and render the preview DETACHED
      // into the reading pane (openPath untouched — the next openPlan replaces it), then derive
      // the bar's PROTOTYPE mode. The gate itself is NOT stashed here: the bar derives it from
      // orchSnapshot.pendingPrototype (activePrototypeGate), so it self-clears when a later
      // snapshot nulls pendingPrototype — this hook only owns the one-shot view flip + render.
      diag(`prototype: review gate kind=${gate.kind} round=${gate.round}`);
      switchToPlanTab();
      void renderPrototypePreview(gate);
      refreshReviewBar();
    },
    onAcceptanceReview: (gate) => {
      // The forced acceptance gate arrived: the run is built and the user must record a
      // verdict against the frozen baseline. The driver has already opened the baseline. Flip to the
      // Plan tab and derive the bar's ACCEPTANCE mode. Like the prototype gate, the gate is NOT
      // stashed here — the bar derives it from orchSnapshot.pendingAcceptance (activeAcceptanceGate),
      // so it self-clears when a later snapshot nulls pendingAcceptance (approve/diverge).
      diag(`acceptance: review gate cwd=${gate.cwd} openTarget=${gate.openTarget}`);
      switchToPlanTab();
      refreshReviewBar();
    },
    onDone: () => {
      orchSnapshot = null;
      // The run is over — no gate can be blocking on the user; drop the idle-waiting hint.
      conversationHandle?.setIdleWaitingHint(false);
      // Run finished: the placeholder's run is over (its real rows exist by now or never will).
      runPlaceholder = null;
      // If the placeholder was the active selection, fall back to the empty pane (a real plan/sentinel
      // the user opened mid-run is left untouched — selection only collapses from the placeholder).
      if (selection.k === "placeholder") selection = { k: "none" };
      lastBadgeSig = null; // the tree is gone — the next run re-initializes the signature
      applyFilterAndRender();
      // The picker is a live-tree concept — the run ended, so hide it.
      renderModelBar();
      // The run ended — the header chip has no active session to report; hide it.
      renderModelChip();
      // The run ended: re-derive BOTH affordances. The open plan may now be RESUMABLE (the run was
      // suppressing detectResumable via isOrchestrationActive) — refreshAffordances re-evaluates the
      // resume banner WITHOUT reopening the plan.
      refreshAffordances();
    },
    onFatal: () => {
      orchSnapshot = null;
      // Fatal teardown: no gate survives it — drop the idle-waiting hint (same as onDone).
      conversationHandle?.setIdleWaitingHint(false);
      // Fatal teardown: same placeholder clear as onDone.
      runPlaceholder = null;
      if (selection.k === "placeholder") selection = { k: "none" };
      lastBadgeSig = null;
      applyFilterAndRender();
      renderModelBar();
      renderModelChip();
      refreshAffordances();
    },
  });

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
              console.error("orchestrator gate: requestChanges failed", e);
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
        actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.
        refreshReviewBar();
        void (async () => {
          try {
            try {
              await getOrchestrator().refinePrototype(feedback);
            } catch (e) {
              console.error("prototype gate: refinePrototype failed", e);
              return;
            }
            // Dispatch succeeded — echo the user's verbatim feedback as a bubble, THEN clear the
            // textarea. (On the failure path above we returned without echoing or clearing.)
            echoUserMessage?.(feedback);
            if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
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
              console.error("acceptance gate: divergeAcceptance failed", e);
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
            console.error("orchestrator gate: approve failed", e);
          } finally {
            actionInFlight = "none";
          }
        })();
        return;
      }
      // PROTOTYPE mode: approve the held visual prototype — always enabled ("Approve
      // visual"; "Proceed as-is" from round 3). approvePrototype() composes + writes INTENT.md and
      // continues into recon; the next snapshot (pendingPrototype nulled) reverts the bar. Flip to
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
        actionInFlight = "approve"; // lock BEFORE the first await; reset in finally on EVERY exit.
        void (async () => {
          try {
            if (feedback !== "") {
              await getOrchestrator().refinePrototype(feedback, { autoApprove: true });
              // Dispatch succeeded — echo the verbatim feedback as a bubble, THEN clear the textarea
              // (mirrors the Request-changes success-only ordering; on the failure path below we
              // returned without echoing or clearing).
              echoUserMessage?.(feedback);
              if (prototypeFeedbackEl) prototypeFeedbackEl.value = "";
              refreshReviewBar();
            } else {
              await getOrchestrator().approvePrototype({ asWorkingReference });
              // Reset the checkbox so a later prototype gate (a fresh run) opens unchecked.
              if (prototypeWorkingRefEl) prototypeWorkingRefEl.checked = false;
            }
            switchToConversationTab();
          } catch (e) {
            console.error("prototype gate: apply-and-approve failed", e);
          } finally {
            actionInFlight = "none";
          }
        })();
        return;
      }
      // ACCEPTANCE mode: the Approve button is "Accept (meets baseline)" → approveAcceptance().
      // The build clears the baseline floor; the deferred finalize runs (notifyDone) and the next
      // snapshot (pendingAcceptance nulled) reverts the bar. The verdict resolves the gate by an
      // explicit action — no held tool to clear.
      const acceptGate = activeAcceptanceGate();
      if (acceptGate) {
        actionInFlight = "approve"; // lock BEFORE the first await; reset in finally on EVERY exit.
        void (async () => {
          try {
            await getOrchestrator().approveAcceptance();
            switchToConversationTab();
          } catch (e) {
            console.error("acceptance gate: approve failed", e);
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

    // ---- #prototype-preview (PROTOTYPE mode, kind "html" only): render in-app --------
    prototypePreviewEl?.addEventListener("click", () => {
      const gate = activePrototypeGate();
      if (!gate || gate.kind !== "html") return;
      void openPrototypePreview(gate);
    });

    // ---- #review-refine (ACCEPTANCE mode only): re-plan the picked sub-plan -----------
    // The THIRD acceptance action. Reads the picked target from #review-refine-target and routes it
    // into refineAcceptance(parsePathKey(target)) — the driver resets that sub-plan + its
    // right-siblings and re-runs them (the acceptance gate re-arms on re-completion). Flip to the
    // Conversation tab so the re-run streams in place; the next snapshot (pendingAcceptance nulled)
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
      homePath = h.endsWith("/") ? h.slice(0, -1) : h;
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

  // A new review request arrived (a new blocking hook). ALWAYS track it in pendingReviews (so it is
  // resumable and counted), then decide whether to YANK the pane to it:
  //   • If NO review is currently being viewed (currentReviewId() === null — the user is browsing a
  //     non-reviewed plan or nothing), focus the window and OPEN THE REAL plan file via the normal
  //     flow (selecting its sidebar row). Falls back to a detached planText render if that fails.
  //   • If a review is ALREADY being viewed, do NOT yank — just refresh the bar (the count rises;
  //     the user can finish the current one then Resume the rest).
  async function handleReviewRequested(payload: ReviewRequested): Promise<void> {
    // The event payload may not carry createdMs — stamp arrival time as a stable fallback so newest
    // resolution still works.
    const createdMs = (payload as { created_ms?: number }).created_ms ?? Date.now();
    const review: PendingReview = {
      reviewId: payload.review_id,
      planFilePath: payload.plan_file_path,
      planText: payload.plan_text,
      createdMs,
      source: "external",
    };
    pendingReviews.set(payload.review_id, review);

    if (currentReviewId() === null) {
      try {
        await invoke("focus_main_window");
      } catch (e) {
        console.error("focus_main_window failed", e);
      }
      // Open the REAL plan file through the normal flow (selects the sidebar row). openReviewPlanFile
      // refreshes the list first and falls back to a detached render if the open fails.
      await openReviewPlanFile(review);
      return;
    }
    // A review is already being viewed — do not yank. The bar's count goes up via summary/viewing.
    refreshReviewBar();
  }

  // A pending request was cancelled (hook gave up / timed out / removed its request). Drop it from
  // pendingReviews. The open plan stays open. Removing this surface can un-suppress the resume banner
  // (precedence: a pending review outranks resume), so re-derive BOTH surfaces — without this, an
  // out-of-band cancel of the LAST suppressing review would clear the bar but leave a resumable open
  // plan's Resume button stuck hidden until re-open.
  function handleReviewCancelled(payload: ReviewCancelled): void {
    pendingReviews.delete(payload.review_id);
    refreshAffordances();
  }

  void listen<ReviewRequested>("plan-review-requested", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, () => handleReviewRequested(payload));
  });
  void listen<ReviewCancelled>("plan-review-cancelled", (event) => {
    const payload = event.payload;
    reviewPending = chainHandler(reviewPending, async () => handleReviewCancelled(payload));
  });

  // ---- in-process plan-review intercept (the Agent SDK canUseTool seam) ----------
  // The SDK emits `tool-permission-requested` when the in-app session wants to use a tool. This app
  // is a PLAN REVIEWER: it intercepts ExitPlanMode (the plan emission), materializes the plan as a
  // REAL file, registers an in-process pending review, and OPENS it through the normal plan flow on
  // the Plan tab — then HOLDS. The held request is NEVER resolved here: the only path to
  // resolve_tool_permission(allow) is the user clicking #review-approve. This hold is identical for
  // subagent plans (agent_id != null) — agentId is captured for diagnostics, never branched on.
  //
  // For any OTHER tool reaching the seam, AUTO-ALLOW so the seam never hangs (liveness) AND the session
  // is not flooded with "request blocked" errors during plan mode. Returning allow here does NOT defeat
  // plan mode: per the installed Agent SDK, plan mode enforces read-only at the CLI level regardless of
  // canUseTool, and the ONLY path that switches to acceptEdits is the post-approval
  // set_agent_permission_mode("acceptEdits") in resolveReview (the #review-approve click). This handler
  // writes NO plan and registers NO review for non-ExitPlanMode tools.
  //
  // Serialized on the SAME reviewPending chain as the external review events so a held ExitPlanMode and
  // an external review/cancel can't interleave their async open/refresh.
  async function handleToolPermissionRequested(payload: ToolPermissionRequested): Promise<void> {
    // Seam ownership: when a multiplan orchestration is active, IT is the sole resolver
    // of the interactive ExitPlanMode seam (it holds/redrafts/approves each sub-plan's plan via its
    // own ledger). The legacy single-shot review path below must NOT also write the plan / register a
    // pendingReview, or the seam would be double-owned. Early-return — no behavior change when no
    // orchestration is active.
    //
    // SUBSUMPTION: the composer now ALWAYS starts a run through getOrchestrator().start()
    // (src/conversation/index.ts), so EVERY composer-initiated plan mode session has an active
    // orchestration — the degenerate single-sub-plan ("single" sizer outcome) collapses the legacy
    // single-shot review into the orchestration's own per-sub gate. As a result the in-process
    // pendingReview minting below is unreachable from the composer flow: this early-return fires first.
    // It is retained ONLY as defensive in-process handling for a future bare-session entry point (a
    // session started WITHOUT an orchestration); it must stay gated behind this guard so two in-process
    // review entry points can NEVER coexist. External file-IPC reviews (the ExitPlanMode hook from other
    // Claude Code sessions) are untouched — they ride list_pending_reviews / respond_to_review, not this
    // seam.
    if (isOrchestrationActive()) return;

    if (payload.tool !== "ExitPlanMode") {
      // DEAD BRANCH (defensive no-op): the sidecar now AUTO-ALLOWS every non-ExitPlanMode tool
      // synchronously in-process (sidecar/index.ts canUseTool) and never emits a
      // tool-permission-requested event for them — eliminating the per-tool frontend round-trip
      // (and its "Stream closed" race) entirely. So this branch should never fire. If it ever does
      // (an older sidecar), log it and do nothing: there is no pending entry to resolve here, and
      // re-resolving a non-existent id would only log "unknown permission id" on the sidecar.
      console.warn(
        "tool-permission-requested for a non-ExitPlanMode tool — ignored (sidecar auto-allows these):",
        payload.tool,
      );
      return;
    }

    // ExitPlanMode: materialize the plan markdown as a REAL file under ~/.claude/plans/, then open it
    // via the normal plan flow. input is { plan: <markdown> } (no path) per the frozen contract.
    const planMarkdown =
      (payload.input as { plan?: unknown } | null | undefined)?.plan;
    const planText = typeof planMarkdown === "string" ? planMarkdown : "";

    // The plan-save read modeled as a ScalarRemoteData<string>: success(path) on resolve — an empty
    // path is still success("") (NOT zeroResults: a scalar write has no empty state), so the
    // un-openable-path liveness branch downstream is preserved — and error(String(e)) on reject. Only
    // the local representation changes to RemoteData; the success/failure BEHAVIOR is folded unchanged.
    let writeResult: ScalarRemoteData<string>;
    try {
      // Backend write_agent_plan returns the absolute path it wrote (frontmatter-tagged, atomic,
      // containment-guarded). tree_id / nn are left undefined for now (the backend seeds a fresh
      // tree_id); re-plan versioning is settled with the backend during live smoke.
      writeResult = success(await invoke<string>("write_agent_plan", { plan: planText }));
    } catch (e) {
      console.error("write_agent_plan failed", e);
      writeResult = failure(String(e));
    }
    // Fold the four reachable scalar states. success → the written path (drives the post-write flow
    // below); error → run the AUTO-DENY liveness path (a side effect) and yield null. initial/fetching
    // are unreachable for a just-awaited write and yield null. A null fold result means "save failed —
    // stop here" (the error arm already released the seam + surfaced the status).
    const writtenPath = await matchScalar<string, Promise<string | null>>(writeResult, {
      initial: () => Promise.resolve(null),
      fetching: () => Promise.resolve(null),
      success: (path) => Promise.resolve(path),
      error: async (message) => {
        // Without a real file we cannot open + review it. Faking a pending review here (empty
        // planFilePath) would hang the seam: currentReviewId() returns null for it, so the bar falls
        // into summary mode, #review-approve stays hidden, and both the approve + submit handlers bail
        // on the null guards — the held canUseTool promise would never resolve. Instead AUTO-DENY so
        // the agent gets feedback and can retry/report, then release without registering any review.
        try {
          await invoke("resolve_tool_permission", {
            id: payload.id,
            allow: false,
            message: "Could not save the plan for review; aborting.",
          });
        } catch (e2) {
          console.error("resolve_tool_permission (write_agent_plan fallback) failed", e2);
        }
        setHookStatus(hookStatusEl, `Could not save the plan for review: ${message}`, "error");
        setTimeout(() => setHookStatus(hookStatusEl, ""), HOOK_STATUS_MS);
        return null;
      },
    });
    if (writtenPath === null) return;

    // Register the in-process pending review keyed by the SDK toolUseId (= payload.id). The hold IS
    // this registration — resolve_tool_permission is NEVER called here.
    const review: PendingReview = {
      reviewId: payload.id,
      planFilePath: writtenPath,
      planText,
      createdMs: Date.now(),
      source: "in-process",
      toolUseId: payload.id,
      agentId: payload.agent_id,
    };
    pendingReviews.set(payload.id, review);

    // If a review is already being viewed, don't yank focus (mirror handleReviewRequested): just
    // refresh the bar (the new plan still appears as a sidebar row via the watcher / refreshList).
    if (currentReviewId() !== null) {
      refreshReviewBar();
      return;
    }

    // Open the REAL plan file through the normal flow (selects its sidebar row, loads/persists comments
    // on its real path, live-reloads), then OWN the tab: flip to Plan + focus the window.
    await openReviewPlanFile(review);
    switchToPlanTab();
    try {
      await invoke("focus_main_window");
    } catch (e) {
      console.error("focus_main_window failed", e);
    }
    refreshReviewBar();
  }

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
        runPlaceholder,
        isOrchestrationActive(),
        orchSnapshot?.treeId ?? null,
      )
    ) {
      runPlaceholder = null;
      // Drop the folded placeholder selection too (only if it WAS the placeholder — never clobber a
      // real plan/sentinel the user opened mid-run).
      if (selection.k === "placeholder") selection = { k: "none" };
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
