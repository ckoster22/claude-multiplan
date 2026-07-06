// Shared UI-state spine (selection, pending reviews, live-run placeholder, gate accessors, staged
// prototype captures). Domain controllers mutate it without importing `./main`, so imports stay
// one-directional. Three non-pure helpers read main-resident sources (orchSnapshot, conversationHandle,
// the `#prototype-attachments` handle) through getter closures injected once via `initAppState`.

import {
  isOrchestrationActive,
  type ApprovalGate2,
  type PrototypeGate,
  type AcceptanceGate,
  type PlanTreeSnapshot2,
} from "./conversation/orchestrator";
import { prototypeGateActive, acceptanceGateActive } from "./prototype";
import { renderAttachmentChips } from "./conversation/attachments";
import type { AttachedImage } from "./conversation/images";
import { asAbsPath, type AbsPath, type PlanRecord } from "./types";
import type { ConversationHandle } from "./conversation";

// Injected once by `main` via `initAppState`; defaults are null/empty-yielding so a test that never
// calls initAppState stays well-defined.
let getOrchSnapshot: () => PlanTreeSnapshot2 | null = () => null;
let getConversationHandle: () => ConversationHandle | null = () => null;
let getPrototypeAttachmentsEl: () => HTMLElement | null = () => null;
let getRecords: () => PlanRecord[] = () => [];
let getFilterQuery: () => string = () => "";
let getPlanListEl: () => HTMLElement | null = () => null;
let getPlanCountEl: () => HTMLElement | null = () => null;
let getModelBarEl: () => HTMLElement | null = () => null;
let getConvModelChipEl: () => HTMLElement | null = () => null;
let getResumeBannerEl: () => HTMLElement | null = () => null;
let getResumeBannerMsgEl: () => HTMLElement | null = () => null;
let getResumePlanBtnEl: () => HTMLElement | null = () => null;
let getResumeConfirmRowEl: () => HTMLElement | null = () => null;
let getResumeHazardEl: () => HTMLElement | null = () => null;
let getToastEl: () => HTMLElement | null = () => null;

export interface AppStateDeps {
  orchSnapshot: () => PlanTreeSnapshot2 | null;
  conversationHandle: () => ConversationHandle | null;
  prototypeAttachmentsEl: () => HTMLElement | null;
  records: () => PlanRecord[];
  filterQuery: () => string;
  planListEl: () => HTMLElement | null;
  planCountEl: () => HTMLElement | null;
  modelBarEl: () => HTMLElement | null;
  convModelChipEl: () => HTMLElement | null;
  resumeBannerEl: () => HTMLElement | null;
  resumeBannerMsgEl: () => HTMLElement | null;
  resumePlanBtnEl: () => HTMLElement | null;
  resumeConfirmRowEl: () => HTMLElement | null;
  resumeHazardEl: () => HTMLElement | null;
  toastEl: () => HTMLElement | null;
}

export function initAppState(deps: AppStateDeps): void {
  getOrchSnapshot = deps.orchSnapshot;
  getConversationHandle = deps.conversationHandle;
  getPrototypeAttachmentsEl = deps.prototypeAttachmentsEl;
  getRecords = deps.records;
  getFilterQuery = deps.filterQuery;
  getPlanListEl = deps.planListEl;
  getPlanCountEl = deps.planCountEl;
  getModelBarEl = deps.modelBarEl;
  getConvModelChipEl = deps.convModelChipEl;
  getResumeBannerEl = deps.resumeBannerEl;
  getResumeBannerMsgEl = deps.resumeBannerMsgEl;
  getResumePlanBtnEl = deps.resumePlanBtnEl;
  getResumeConfirmRowEl = deps.resumeConfirmRowEl;
  getResumeHazardEl = deps.resumeHazardEl;
  getToastEl = deps.toastEl;
}

export function currentRecords(): PlanRecord[] {
  return getRecords();
}
export function orchSnapshot(): PlanTreeSnapshot2 | null {
  return getOrchSnapshot();
}
export function filterQuery(): string {
  return getFilterQuery();
}
export function planListEl(): HTMLElement | null {
  return getPlanListEl();
}
export function planCountEl(): HTMLElement | null {
  return getPlanCountEl();
}
export function modelBarEl(): HTMLElement | null {
  return getModelBarEl();
}
export function convModelChipEl(): HTMLElement | null {
  return getConvModelChipEl();
}
export function resumeBannerEl(): HTMLElement | null {
  return getResumeBannerEl();
}
export function resumeBannerMsgEl(): HTMLElement | null {
  return getResumeBannerMsgEl();
}
export function resumePlanBtnEl(): HTMLElement | null {
  return getResumePlanBtnEl();
}
export function resumeConfirmRowEl(): HTMLElement | null {
  return getResumeConfirmRowEl();
}
export function resumeHazardEl(): HTMLElement | null {
  return getResumeHazardEl();
}
export function toastEl(): HTMLElement | null {
  return getToastEl();
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
export type Selection =
  | { k: "none" }
  | { k: "plan"; path: AbsPath }
  | { k: "sentinel"; treeId: string; cwd: string | null }
  | { k: "placeholder"; treeId: string };

// Owned via get/set — ESM cannot reassign an imported binding, so `main` mutates through setSelection.
let selection: Selection = { k: "none" };

export function getSelection(): Selection {
  return selection;
}

export function setSelection(next: Selection): void {
  selection = next;
}

// DERIVED from `selection` — null for `none`/`placeholder`; sentinel maps to its scheme path.
// The ONE reader the rest of the module consults; nobody assigns it (it is a function, not an lvalue).
// INVARIANT[openpath-is-derived-never-assigned] (type-level): openPath is a pure function over `selection` (no backing field) — recomputed each call, never a stored lvalue writers can set.
//   prevents: a stored openPath desyncing from the active selection
export function openPath(): AbsPath | null {
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

// ---- Synthetic "resume" sidebar rows ------------------------------------------------
//
// `list_plans` synthesizes a `PlanRecord` for a mid-decompose plan-tree that has NO real plan `.md`
// file yet, so the tree is still visible + its resume banner reachable (synthetic resume sidebar
// rows). The row carries a SENTINEL `absolute_path` of the
// form `plan-tree-resume://<tree_id>` — there is NO file behind it. Anything that would `invoke`
// `read_plan_contents` / `set_open_plan` / `mark_viewed` against the path MUST guard on this
// predicate first (the Rust commands reject a sentinel — canonicalize fails on the scheme string).
export const RESUME_SENTINEL_SCHEME = "plan-tree-resume://";

// ---- Plan Review (ExitPlanMode hook) — the reviewed plan is a REAL file under ~/.claude/plans/ ----
// Opens it through the normal plan-open flow (sidebar selected, comments persist, live-reload works).
// "Viewing a review" is derived: openPath === pendingReview.planFilePath. Browsing away drops to
// SUMMARY mode — a pending review never traps navigation.
//
//   pendingReviews — keyed by reviewId. Holds planFilePath (what we open) + planText (fallback).
export interface PendingReview {
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
export const pendingReviews = new Map<string, PendingReview>();

// The reviewId whose planFilePath === the currently-open plan, or null (the single derivation of
// "viewing a review"). On ties, the last-iterated (newest-inserted) wins.
export function currentReviewId(): string | null {
  const op = openPath();
  if (op === null) return null;
  let match: string | null = null;
  for (const r of pendingReviews.values()) {
    if (r.planFilePath === op) match = r.reviewId;
  }
  return match;
}

// ---- Live-run placeholder sidebar row -----------------------------------------------
// A running orchestration has no sidebar row until list_plans picks up the plan file. `runPlaceholder`
// (treeId + label) is rendered as a `.plan.placeholder` row when no real record has its treeId.
// ORTHOGONAL to `selection`: the row can be visible while a DIFFERENT plan is selected.
// The placeholder's SELECTED state is folded into `selection` (k === "placeholder") rather than a
// parallel boolean; `placeholderSelected()` reads it.
let runPlaceholder: { treeId: string; label: string } | null = null;

export function getRunPlaceholder(): { treeId: string; label: string } | null {
  return runPlaceholder;
}

export function setRunPlaceholder(next: { treeId: string; label: string } | null): void {
  runPlaceholder = next;
}

// The held ApprovalGate2 the user is currently viewing (null otherwise). One derivation covers
// decomposition AND leaf gates. Routing by gate.kind happens inside the orchestrator, not here.
export function viewingGate(): ApprovalGate2 | null {
  if (!isOrchestrationActive()) return null;
  const gate = getOrchSnapshot()?.pendingApproval ?? null;
  if (!gate) return null;
  return openPath() === asAbsPath(gate.planPath) ? gate : null;
}

// The held PrototypeGate driving the bar's PROTOTYPE mode, or null. Derived strictly from the
// orchestrator snapshot (self-clears when pendingPrototype is nulled). Precedence: pendingApproval
// outranks this; this outranks pendingReviews.
export function activePrototypeGate(): PrototypeGate | null {
  return prototypeGateActive(getOrchSnapshot(), isOrchestrationActive());
}

// The held AcceptanceGate driving the bar's ACCEPTANCE mode, or null. Derived strictly from the
// orchestrator snapshot (self-clears when pendingAcceptance is nulled). Precedence: pendingApproval
// and pendingPrototype both outrank it.
export function activeAcceptanceGate(): AcceptanceGate | null {
  return acceptanceGateActive(getOrchSnapshot(), isOrchestrationActive());
}

// ---- PendingSurface[]: the unified set of "things awaiting the user" -------------------------
// One typed surface each, so the SUMMARY count and the Resume target derive from the same source:
//   • external / in-process — tracked pendingReviews (held hooks / canUseTool seams).
//   • orchestrator-gate     — the live run's held ApprovalGate2 (NOT in pendingReviews).
//   • prototype / acceptance — the live run's held visual/forced-acceptance gates.
export type PendingSurface =
  | { kind: "external" | "in-process"; review: PendingReview }
  | { kind: "orchestrator-gate"; gate: ApprovalGate2 }
  | { kind: "prototype"; gate: PrototypeGate }
  | { kind: "acceptance"; gate: AcceptanceGate };

// Source of the currently-viewed review. Reads from the same matched review currentReviewId()
// resolved; defaults to "external" when nothing is viewed. Returns "in-process" when viewing the
// orchestrator approval gate (which is not tracked in pendingReviews).
export function currentReviewSource(): "external" | "in-process" {
  if (viewingGate() !== null) return "in-process";
  const id = currentReviewId();
  if (id === null) return "external";
  return pendingReviews.get(id)?.source ?? "external";
}

// ---- Staged prototype-gate captures --------------------------------------------------
// Captures flushed when the prototype-preview modal closes are staged on the held prototype gate (not
// the composer tray) so they ride the next gate send; gate feedback is otherwise text-only. Cleared on
// a successful send (a failed send keeps them for retry) or when the run ends.
let stagedGateCaptures: AttachedImage[] = [];

// A copy of the currently-staged captures — the snapshot a gate-send handler takes before its async
// gap so a mid-flight edit can't change what rides the send (the sent slice is later spliced out via
// removeStagedGateCaptures).
export function stagedGateCapturesSnapshot(): AttachedImage[] {
  return stagedGateCaptures.slice();
}

// Route captures flushed on modal close: stage them on the held prototype gate (the normal case) so
// they ride the gate send. With no gate active they only exist defensively, so fall back to the
// composer tray rather than dropping them.
export function stageOrAttachCaptures(imgs: AttachedImage[]): void {
  if (activePrototypeGate() !== null) {
    stagedGateCaptures.push(...imgs);
    renderStagedGateChips();
  } else {
    getConversationHandle()?.attachImages(imgs);
  }
}

// Render the staged captures as removable chips (PROTOTYPE mode only), reusing the composer tray's
// chip markup (renderAttachmentChips) so the two strips read identically.
export function renderStagedGateChips(): void {
  const el = getPrototypeAttachmentsEl();
  if (!el) return;
  const active = activePrototypeGate() !== null;
  el.classList.toggle("hidden", !active || stagedGateCaptures.length === 0);
  if (!active) {
    el.replaceChildren();
    return;
  }
  renderAttachmentChips(el, stagedGateCaptures, (idx) => {
    stagedGateCaptures.splice(idx, 1);
    renderStagedGateChips();
  });
}

// Remove exactly the captures that were SENT (identity match on the handler's snapshot), leaving any
// capture staged mid-flight untouched. Splicing the sent slice rather than clearing wholesale keeps a
// capture staged between the snapshot and its resolution from being dropped unsent.
export function removeStagedGateCaptures(sent: readonly AttachedImage[]): void {
  if (sent.length === 0) return;
  const sentRefs = new Set(sent);
  stagedGateCaptures = stagedGateCaptures.filter((c) => !sentRefs.has(c));
  renderStagedGateChips();
}

// Drop every staged capture and re-render (hides the strip). Called on run end/teardown (the gate is
// gone) — never on a per-send success (that splices only the sent slice).
export function clearStagedGateCaptures(): void {
  stagedGateCaptures = [];
  renderStagedGateChips();
}

// Non-rendering staged-capture reset, used only by the test-reset seam so a reset never fires the
// `#prototype-attachments` DOM mutation `renderStagedGateChips()` would (the live path uses
// clearStagedGateCaptures instead).
export function resetStagedGateCaptures(): void {
  stagedGateCaptures = [];
}
