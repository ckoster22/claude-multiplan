// Multiplan plan-tree package — LEAF: the event + effect discriminated unions (types only).
//
// The path-based event union the reducer consumes and the effect union it decides (the driver
// executes). PURE declarations; depends only on `ids` and `model` (and the external AskUserQuestion
// shapes).

import type { AskUserQuestionItem, AskUserQuestionAnswers } from "../types";
import type { ModelOptions } from "../../model-picker";
import type { Nn, NodePath, PlanTreeFilePath } from "./ids";
import type { SizerOutcome, PrototypeGate, ApprovalGate2, AcceptanceGate } from "./model";

// Events carry full NodePaths.
//
// DRIVER-WRITE BOUNDARY: events carry NO plan/recon TEXT. The driver writes the artifact FIRST and
// dispatches the event with the write's real returned paths. Consequently Effect2 has NO
// writeAgentPlan kind, and NODE_RECON_DONE emits no recon.md write (the driver writes recon.md itself
// before dispatching).
export type PlanTreeEvent2 =
  | { type: "START"; treeId: string; request: string; nowMs: number }
  | { type: "INTENT_CLARIFIED"; intent: string }
  // THE VISUAL-PROTOTYPE GATE (root-only, no path — addresses the root's genesis window).
  // PROTOTYPE_READY opens the gate (clarifying-intent → prototype-review); PROTOTYPE_APPROVED
  // resolves it forward (→ recon, writing INTENT.md like the no-prototype INTENT_CLARIFIED fallback);
  // PROTOTYPE_REFINED loops back (→ clarifying-intent) for another round. The feedback text is
  // DRIVER-side prompt material, never stored on the ledger.
  | { type: "PROTOTYPE_READY"; gate: PrototypeGate }
  // PROTOTYPE_APPROVED resolves the gate forward (→ recon, writing INTENT.md). `asWorkingReference`
  // classifies the approval: false (DEFAULT — "just a sketch") leaves the ledger untouched beyond the
  // recon hop; true ("working reference") additionally records the frozen baseline (`baseline_`). The
  // DRIVER sets the flag true ONLY after freezing `.plan-tree/prototype/` into `.plan-tree/baseline/`
  // without throwing (a presence record must match disk) — a freeze failure dispatches false (recon
  // proceeds, no baseline claimed). `frozenMs` rides the event (the reducer never reads a clock) and
  // is stored only when `asWorkingReference` is true.
  | { type: "PROTOTYPE_APPROVED"; intentContents: string; asWorkingReference: boolean; frozenMs: number }
  | { type: "PROTOTYPE_REFINED"; feedback: string }
  | { type: "NODE_RECON_DONE"; path: NodePath }
  | { type: "SIZER_DONE"; path: NodePath; outcome: SizerOutcome }
  | { type: "DECOMPOSITION_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  // THE RESUME PHASE-ONLY RE-ARM. On resume the disk-probe branch re-presents a decomposition
  // gate from a node still at `open/decomposing` (the transient DECOMPOSITION_DRAFTED died with the
  // killed process) while the DRIVER sets pendingApproval + fires onAwaitingApproval directly. This
  // event advances ONLY `open/decomposing` → `open/awaiting-decomposition-approval` so a subsequent
  // DECOMPOSITION_APPROVED guard is satisfied. Emits NO effects — re-dispatching DECOMPOSITION_DRAFTED
  // would double-fire the already-presented gate. Legal ONLY from `open/decomposing`; else throws.
  | { type: "GATE_RE_PRESENTED"; path: NodePath }
  | { type: "CHILDREN_PARSED"; path: NodePath; children: ReadonlyArray<{ nn: Nn; title: string }> }
  | { type: "DECOMPOSITION_APPROVED"; path: NodePath }
  | { type: "DECOMPOSITION_CHANGES_REQUESTED"; path: NodePath; feedback: string }
  | { type: "NODE_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  | { type: "APPROVE"; path: NodePath }
  | { type: "REQUEST_CHANGES"; path: NodePath; feedback: string }
  | { type: "EXEC_DONE"; path: NodePath }
  // The DRIVER physically writes summaryName2(path) and dispatches this with the write's real
  // returned path — the reducer only RECORDS it (no write effect).
  | { type: "SUMMARY_WRITTEN"; path: NodePath; summaryText: string; summaryPath: PlanTreeFilePath }
  // the parent-review turn ended (ADJUST note or NONE). `path` addresses the REVIEWING
  // parent. `note` rides the event for traceability only — the reducer never stores it (DRIVER-side
  // state). reviewing → running-children + next pending child → recon.
  | { type: "PARENT_REVIEW_DONE"; path: NodePath; note: string | null }
  // THE FORCED ACCEPTANCE GATE RESOLUTIONS (root-only, no path). Both perform the finalize
  // the gate deferred (root acceptance window → summarized + notifyDone) and clear pendingAcceptance.
  // Legal ONLY while the gate is open (root in its acceptance window, pendingAcceptance set); else
  // throws.
  //   - ACCEPTANCE_APPROVED: the result clears the baseline floor. Records acceptance_ =
  //     {verdict:"approved", decided_ms}.
  //   - ACCEPTANCE_DIVERGED: the user accepted a result below the floor and recorded WHY. Records
  //     acceptance_ = {verdict:"diverged", reason, decided_ms} — `reason` round-trips through
  //     toLedger2/rehydrate. `decidedMs` rides the event (the reducer never reads a clock).
  | { type: "ACCEPTANCE_APPROVED"; decidedMs: number }
  | { type: "ACCEPTANCE_DIVERGED"; reason: string; decidedMs: number }
  // THE FORCED-ACCEPTANCE REFINE (re-plan) BRANCH. A THIRD acceptance-gate action beside
  // approve and accept-divergence: re-plan a chosen sub-plan. `target` is the node to re-plan (a
  // non-empty path — the root [] is illegal: re-planning the whole tree is "start a new plan"). NO
  // "stale summary" flag exists — the reset IS the mechanism: reset the target AND every RIGHT-SIBLING
  // at its level to a fresh re-execution shape (target → open/recon, right-siblings → open/pending),
  // preserving LEFT-siblings as summarized. The result is a coherent `summarized* active pending*`
  // partition, so the normal flow re-runs the reset nodes and OVERWRITES their summaries; on root
  // re-completion (baseline_ present, acceptance_ absent) the gate RE-ARMS. Clears
  // pendingAcceptance, records NO verdict. Legal ONLY while the gate is open; else throws.
  | { type: "ACCEPTANCE_REFINED"; target: NodePath }
  // USER MODEL OVERRIDE (03's picker dispatches this). Stamps the target node's execution_model +
  // model_source:"override" so re-triage never clobbers it, then re-derives inherited-auto models for
  // still-`open` descendants. May address ANY node (not just the active one) — the picker can
  // pre-set a not-yet-active node's model. Emits persist.
  | { type: "EXECUTION_MODEL_SET"; path: NodePath; options: ModelOptions }
  | { type: "CLARIFY_REQUESTED"; toolUseId: string; questions: AskUserQuestionItem[] }
  | { type: "CLARIFY_ANSWERED"; toolUseId: string; answers: AskUserQuestionAnswers }
  // SESSION-CAPTURE ARC (resume support): the SDK session_id arrived on the system_init frame. NOT a
  // node transition — stamps run-level sdk_session_id and SELF-PERSISTS so a killed run leaves a
  // resumable id on disk. Idempotent: a re-dispatched same id is a no-op (no change, no persist).
  | { type: "SESSION_INITIALIZED"; sessionId: string }
  // QUOTA AUTO-RESUME ARC (usage-limit pause/resume). RUN-LEVEL events (no path — they address the
  // run's auto-resume budget); like every gen-2 event the reducer reads NO clock (timestamps ride).
  //   - QUOTA_BUDGET_SET: dispatched at START from the composer's quota-resume choice. Sets
  //     auto_resume_ = { budget, remaining: budget }. NOT dispatched on resume() (a resumed run keeps
  //     its persisted budget, or fails closed at 0).
  //   - QUOTA_PAUSED: a quota_exceeded frame arrived; the run is paused until `resetAt` (epoch ms).
  //     `source` names the tripped limit (display/audit). The reducer DECIDES: remaining > 0 ⇒
  //     notifyQuotaPaused (countdown to auto-resume); remaining === 0 (or no budget) ⇒
  //     notifyQuotaExhausted.
  //   - QUOTA_RESUMED: the auto-resume timer fired (or manual resume); decrement remaining (floor 0).
  //     `nowMs` rides the event.
  //   - QUOTA_EXHAUSTED: terminal exhaust signal. Emits notifyQuotaExhausted; budget left as-is
  //     (already 0 in the auto-resume flow).
  | { type: "QUOTA_BUDGET_SET"; budget: number }
  | { type: "QUOTA_PAUSED"; resetAt: number; source: string }
  | { type: "QUOTA_RESUMED"; nowMs: number }
  | { type: "QUOTA_EXHAUSTED"; resetAt: number; source: string }
  | { type: "FATAL"; message: string };

// The effect union the reducer emits. Deliberate shape (documented on PlanTreeEvent2 above):
//   - NO writeAgentPlan kind (the driver writes plans before dispatching DRAFTED events);
//   - NODE_RECON_DONE emits no writePlanTreeFile (recon.md is a driver write);
//   - notifyAwaitingApproval fires for DECOMPOSITION_DRAFTED too (the reducer owns the unified
//     decomposition gate).
export type Effect2 =
  // Persist the ledger (toLedger2) to .plan-tree/state.json.
  | { kind: "persist" }
  // Archive every current entry of <cwd>/.plan-tree/ (START only, BEFORE persist).
  | { kind: "resetPlanTreeDir" }
  // Write an auxiliary plan-tree file (gen 2 emits this for INTENT.md only — see the seam note).
  | { kind: "writePlanTreeFile"; name: string; contents: string }
  // Delete an auxiliary plan-tree file (the refine branch's per-reset-node cleanup). Emitted
  // by ACCEPTANCE_REFINED for each reset node's `NN-plan.md`/`NN-summary.md` so re-executed sub-plans
  // overwrite a clean slate. The driver's delete is containment-guarded (reuses guarded_plan_tree_path,
  // like writePlanTreeFile); absent ⇒ graceful no-op.
  | { kind: "deletePlanTreeFile"; name: string }
  // Resolve a held canUseTool permission (ExitPlanMode / AskUserQuestion).
  | { kind: "resolvePermission"; id: string; allow: boolean; message?: string }
  // Surface that a node (decomposition OR leaf — unified) is awaiting the user's approval.
  | { kind: "notifyAwaitingApproval"; gate: ApprovalGate2 }
  // Surface that a visual prototype is awaiting the user's review (the root prototype gate).
  | { kind: "notifyPrototypeReview"; gate: PrototypeGate }
  // Surface the forced acceptance gate: the run is complete EXCEPT the user must record a
  // verdict against the frozen baseline. The driver opens the baseline (open_baseline) and surfaces
  // Approve/Diverge; notifyDone is WITHHELD until ACCEPTANCE_APPROVED/DIVERGED resolves the gate.
  | { kind: "notifyAcceptanceReview"; gate: AcceptanceGate }
  // Surface that a node's summary was written (path-branded — never the summary text).
  | { kind: "notifySummaryWritten"; path: NodePath; summaryPath: PlanTreeFilePath }
  // Surface that the whole tree is done.
  | { kind: "notifyDone" }
  // QUOTA AUTO-RESUME — the run is PAUSED on a usage limit and WILL auto-resume. The driver counts
  // down to `resetAt` and arms the auto-resume timer; `remaining` is the post-pause count it may
  // display ("N auto-resumes left"); `source` names the limit.
  | { kind: "notifyQuotaPaused"; resetAt: number; remaining: number; source: string }
  // QUOTA AUTO-RESUME — the run is PAUSED with NO auto-resume left (budget exhausted or never set —
  // the fail-closed default). The driver surfaces a paused-until-`resetAt` state but does NOT
  // auto-resume; only manual action continues the run. `source` names the limit.
  | { kind: "notifyQuotaExhausted"; resetAt: number; source: string }
  // Surface a fatal error.
  | { kind: "notifyFatal"; message: string };
