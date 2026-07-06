// The approval-gate observer FACTORY. `main` subscribes the returned object to the orchestrator; its
// hooks drive the reading-pane tab, sidebar, model bar, and review bar off each transition. Imports
// ONLY TYPES (erased by tsc) and takes runtime deps through `deps`, to avoid a conversation ↔
// app-state/render runtime cycle.

import type { PlanTreeSnapshot2, PrototypeGate, TreeNode } from "./plan-tree";
import type { OrchestratorObserver } from "./orchestrator";
import type { ConversationHandle } from ".";
import type { Selection } from "../app-state";

// State, DOM-bound callbacks, and cross-domain entry points supplied by `main`. Getters/setters read
// and write main's single-source-of-truth `let`s (orchSnapshot, runPlaceholder, selection) — no copy here.
export interface GateObserverDeps {
  setOrchSnapshot: (snap: PlanTreeSnapshot2 | null) => void;
  getConversationHandle: () => ConversationHandle | null;
  isOrchestrationActive: () => boolean;
  getRunPlaceholder: () => { treeId: string; label: string } | null;
  setRunPlaceholder: (next: { treeId: string; label: string } | null) => void;
  getSelection: () => Selection;
  setSelection: (next: Selection) => void;
  clearStagedGateCaptures: () => void;
  applyFilterAndRender: () => void;
  badgeSignature: (root: TreeNode) => string;
  renderModelBar: () => void;
  renderModelChip: () => void;
  refreshAffordances: () => void;
  refreshReviewBar: (countOverride?: number) => void;
  openGatePlanFile: (planPath: string) => Promise<void>;
  switchToPlanTab: () => void;
  renderPrototypePreview: (gate: PrototypeGate) => Promise<void>;
  openPrototypePreview: (gate: PrototypeGate) => Promise<void>;
  diag: (msg: string) => void;
}

export function createGateObserver(deps: GateObserverDeps): OrchestratorObserver {
  // Observer-private badge guard (only these hooks touch it), so it lives as a factory-local, not a main `let`.
  let lastBadgeSig: string | null = null;

  return {
    onSnapshot: (snap) => {
      deps.setOrchSnapshot(snap);
      // Idle-waiting hint: the visual-prototype gate is TURN-COMPLETION signaled (the intent turn
      // ends with a `result` → session idle → the facade hides its working indicator), so while
      // pendingPrototype is held, tell the conversation facade to keep showing "Waiting for your
      // input…" in the idle state. Derived STRICTLY from the snapshot, so it self-clears:
      // approve/refine null pendingPrototype in the reducer and the very next snapshot turns it off.
      // Also keep the idle-waiting hint up while the forced acceptance gate is held (it is
      // turn-completion signaled like the prototype gate: the run is built and the session is idle,
      // so the facade must not read "done" while the user owes a verdict).
      deps.getConversationHandle()?.setIdleWaitingHint(snap.pendingPrototype != null || snap.pendingAcceptance != null);
      // Live-run placeholder: the FIRST snapshot of each run (keyed by treeId) mints a
      // placeholder sidebar row — the run has no real row until its plan file lands.
      if (
        deps.isOrchestrationActive() &&
        snap.treeId &&
        !snap.done &&
        deps.getRunPlaceholder()?.treeId !== snap.treeId
      ) {
        // A NEW run is beginning (fresh treeId). Discard any captures a prior run left staged: a bare
        // cancel() ends a run without firing onDone/onFatal, so otherwise they'd surface on the next
        // run's prototype gate. Fires once per run (later same-treeId snapshots skip this block).
        deps.clearStagedGateCaptures();
        deps.setRunPlaceholder({ treeId: snap.treeId, label: "New plan — drafting…" });
        // Make the placeholder the ACTIVE selection ONLY when nothing real is open. It must NOT clobber
        // a plan/sentinel the user is viewing: the in-process review demo aligns the selection to the
        // gate plan (__setOpenPathForMock) BEFORE this fires, and that selection drives the bar's
        // viewingGate — folding placeholder over it would break VIEWING. When a real plan IS open the
        // row still renders (runPlaceholder above) and goes `.active` via standsInForOpenGatePlan once
        // the held gate's plan is the open one (the FIX-2 stand-in path).
        if (deps.getSelection().k === "none") deps.setSelection({ k: "placeholder", treeId: snap.treeId });
        deps.applyFilterAndRender();
        lastBadgeSig = deps.badgeSignature(snap.root); // the render above already painted the fresh badges
      }
      // BADGE LIVE-UPDATE: the sidebar badge is off the default re-render path — a normal
      // EXECUTION_MODEL_SET snapshot mints no placeholder — so re-render the sidebar exactly when a
      // live node's displayed model / override source changed vs the last render. Guarded by the
      // signature so an unrelated snapshot does not re-render the whole sidebar.
      const sig = deps.badgeSignature(snap.root);
      if (sig !== lastBadgeSig) {
        lastBadgeSig = sig;
        deps.applyFilterAndRender();
      }
      // Keep the reading-pane picker in lockstep with the live snapshot (override flips the `.on`
      // segment + recommendation/override state).
      deps.renderModelBar();
      // The conversation-header chip tracks the ACTIVE node's live model (phase transitions +
      // overrides) independently of which plan is open.
      deps.renderModelChip();
      // Re-derive both affordances on every snapshot transition (the resume banner stays suppressed
      // while the run owns the seam — detectResumable null — so this is a no-op for it until onDone).
      deps.refreshAffordances();
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
        deps.diag(`gate: onAwaitingApproval enter kind=${gate.kind} planPath=${gate.planPath}`);
        await deps.openGatePlanFile(gate.planPath);
        deps.diag("gate: onAwaitingApproval exit (Plan tab asserted)");
      })();
    },
    onPrototypeReview: (gate) => {
      // Visual-prototype gate: flip to the Plan tab and render the preview DETACHED
      // into the reading pane (openPath untouched — the next openPlan replaces it), then derive
      // the bar's PROTOTYPE mode. The gate itself is NOT stashed here: the bar derives it from
      // orchSnapshot.pendingPrototype (activePrototypeGate), so it self-clears when a later
      // snapshot nulls pendingPrototype — this hook only owns the one-shot view flip + render.
      deps.diag(`prototype: review gate kind=${gate.kind} round=${gate.round}`);
      deps.switchToPlanTab();
      void deps.renderPrototypePreview(gate);
      deps.refreshReviewBar();
      // An HTML gate is viewable in-app, so auto-open the preview modal (self-guarding: a second call
      // while open no-ops). The #prototype-preview button stays as a manual re-open. Don't auto-annotate.
      if (gate.kind === "html") void deps.openPrototypePreview(gate);
    },
    onAcceptanceReview: (gate) => {
      // The forced acceptance gate arrived: the run is built and the user must record a
      // verdict against the frozen baseline. The driver has already opened the baseline. Flip to the
      // Plan tab and derive the bar's ACCEPTANCE mode. Like the prototype gate, the gate is NOT
      // stashed here — the bar derives it from orchSnapshot.pendingAcceptance (activeAcceptanceGate),
      // so it self-clears when a later snapshot nulls pendingAcceptance (approve/diverge).
      deps.diag(`acceptance: review gate cwd=${gate.cwd} openTarget=${gate.openTarget}`);
      deps.switchToPlanTab();
      deps.refreshReviewBar();
    },
    onDone: () => {
      deps.setOrchSnapshot(null);
      deps.getConversationHandle()?.setIdleWaitingHint(false);
      // The gate is gone — discard any captures still staged on it (never leak into the next run).
      deps.clearStagedGateCaptures();
      deps.setRunPlaceholder(null);
      // If the placeholder was the active selection, fall back to the empty pane (a real plan/sentinel
      // the user opened mid-run is left untouched — selection only collapses from the placeholder).
      if (deps.getSelection().k === "placeholder") deps.setSelection({ k: "none" });
      lastBadgeSig = null; // the tree is gone — the next run re-initializes the signature
      deps.applyFilterAndRender();
      deps.renderModelBar();
      deps.renderModelChip();
      // The run ended: re-derive BOTH affordances. The open plan may now be RESUMABLE (the run was
      // suppressing detectResumable via isOrchestrationActive) — refreshAffordances re-evaluates the
      // resume banner WITHOUT reopening the plan.
      deps.refreshAffordances();
    },
    onFatal: () => {
      deps.setOrchSnapshot(null);
      deps.getConversationHandle()?.setIdleWaitingHint(false);
      // The gate is gone — discard any captures still staged on it (never leak into the next run).
      deps.clearStagedGateCaptures();
      deps.setRunPlaceholder(null);
      if (deps.getSelection().k === "placeholder") deps.setSelection({ k: "none" });
      lastBadgeSig = null;
      deps.applyFilterAndRender();
      deps.renderModelBar();
      deps.renderModelChip();
      deps.refreshAffordances();
    },
  };
}
