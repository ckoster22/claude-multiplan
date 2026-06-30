// Multiplan plan-tree package — LEAF: the event + effect discriminated unions (types only).
//
// The path-based event union the reducer consumes and the effect union it decides (the driver
// executes). PURE declarations; depends only on `ids` and `model` (and the external AskUserQuestion
// shapes).

import type { AskUserQuestionItem, AskUserQuestionAnswers } from "../types";
import type { Nn, NodePath, PlanTreeFilePath } from "./ids";
import type { SizerOutcome, PrototypeGate, ApprovalGate2, AcceptanceGate } from "./model";

// ---- gen-2 events (path-based discriminated union) ---------------------------------------------
//
// PHASE-1 DEPTH-1 SCOPE: events carry full NodePaths, but this phase only handles the root ([])
// and depth-1 children ([nn]); any deeper path throws LOUDLY ("not yet supported" — PHASE 4
// unlocks depth > 1 with the per-node sizer). The gen-1 nn-addressed events map 1:1:
//   RECON_DONE/SUB_RECON_DONE → NODE_RECON_DONE; MASTER_DRAFTED → DECOMPOSITION_DRAFTED;
//   SUBPLANS_PARSED → CHILDREN_PARSED; MASTER_APPROVED → DECOMPOSITION_APPROVED;
//   SUB_DRAFTED → NODE_DRAFTED; APPROVE/REQUEST_CHANGES/EXEC_DONE/SUMMARY_WRITTEN keep their
//   names path-addressed; the master REQUEST_CHANGES (gen-1 driver-side only, no reducer event)
//   becomes the first-class DECOMPOSITION_CHANGES_REQUESTED.
//
// DRIVER-WRITE BOUNDARY (cutover seam): gen-2 events carry NO plan/recon TEXT. The driver
// physically writes the artifact FIRST and dispatches the event with the write's real returned
// paths — generalizing the gen-1 SUMMARY_WRITTEN precedent (and matching what the gen-1 driver
// ALREADY does for sub plans: it calls writeAgentPlan itself and no-ops the reducer's effect via
// wrotePlanForNn). Consequently Effect2 has NO writeAgentPlan kind, and NODE_RECON_DONE emits no
// recon.md write (the driver writes recon.md itself before dispatching — cutover seam).
export type PlanTreeEvent2 =
  | { type: "START"; treeId: string; request: string; nowMs: number }
  | { type: "INTENT_CLARIFIED"; intent: string }
  // THE VISUAL-PROTOTYPE GATE (root-only, no path — like INTENT_CLARIFIED these address the root's
  // genesis window). PROTOTYPE_READY opens the gate (clarifying-intent → prototype-review);
  // PROTOTYPE_APPROVED resolves it forward (→ recon, writing INTENT.md exactly as INTENT_CLARIFIED
  // does — INTENT_CLARIFIED remains the unchanged no-prototype fallback); PROTOTYPE_REFINED loops
  // back (→ clarifying-intent) for another prototype round with the user's feedback (the feedback
  // text is DRIVER-side prompt material, never stored on the ledger — same boundary as the
  // parent-review note).
  | { type: "PROTOTYPE_READY"; gate: PrototypeGate }
  // PROTOTYPE_APPROVED resolves the gate forward (→ recon, writing INTENT.md). `asWorkingReference`
  // classifies the approval: false (DEFAULT — "just a sketch") leaves the ledger untouched beyond
  // the recon hop (today's behavior); true ("working reference") additionally records the frozen
  // baseline (`baseline_`). baseline_ is recorded ONLY when the freeze succeeded (a presence record
  // must match disk): the DRIVER sets this flag true only AFTER it has frozen `.plan-tree/prototype/`
  // into `.plan-tree/baseline/` without throwing — a freeze failure dispatches false (recon still
  // proceeds, but no baseline is claimed). `frozenMs` rides the event (the reducer never reads a clock
  // — START's `nowMs` precedent) and is stored only when `asWorkingReference` is true.
  | { type: "PROTOTYPE_APPROVED"; intentContents: string; asWorkingReference: boolean; frozenMs: number }
  | { type: "PROTOTYPE_REFINED"; feedback: string }
  | { type: "NODE_RECON_DONE"; path: NodePath }
  | { type: "SIZER_DONE"; path: NodePath; outcome: SizerOutcome }
  | { type: "DECOMPOSITION_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  // INV-3 — THE RESUME PHASE-ONLY RE-ARM (no path beyond the addressed node). On resume the disk-probe
  // gate branch re-presents a decomposition gate from a node still at `open/decomposing` (the
  // transient DECOMPOSITION_DRAFTED event died with the killed process), while the DRIVER sets
  // pendingApproval + fires onAwaitingApproval DIRECTLY (effect-free — there is no DRAFTED event to
  // replay). This event advances ONLY the node phase `open/decomposing` → `open/awaiting-decomposition-
  // approval` so a subsequent Approve's DECOMPOSITION_APPROVED guard is satisfied. It emits NO effects
  // (no persist, no notify) — re-dispatching DECOMPOSITION_DRAFTED would double-fire the gate (the
  // driver already presented it). Legal ONLY from `open/decomposing` (the resumed gate shape); any
  // other phase throws LOUDLY.
  | { type: "GATE_RE_PRESENTED"; path: NodePath }
  | { type: "CHILDREN_PARSED"; path: NodePath; children: ReadonlyArray<{ nn: Nn; title: string }> }
  | { type: "DECOMPOSITION_APPROVED"; path: NodePath }
  | { type: "DECOMPOSITION_CHANGES_REQUESTED"; path: NodePath; feedback: string }
  | { type: "NODE_DRAFTED"; path: NodePath; planPath: string; plansDirPath: string; toolUseId: string }
  | { type: "APPROVE"; path: NodePath }
  | { type: "REQUEST_CHANGES"; path: NodePath; feedback: string }
  | { type: "EXEC_DONE"; path: NodePath }
  // The DRIVER physically writes summaryName2(path) and dispatches this with the write's real
  // returned path — the reducer only RECORDS it (no write effect), exactly as in gen 1.
  | { type: "SUMMARY_WRITTEN"; path: NodePath; summaryText: string; summaryPath: PlanTreeFilePath }
  // PHASE 5 — the parent-review turn ended (ADJUST note or NONE). `path` addresses the REVIEWING
  // parent (the active node during the review window). `note` rides the event for traceability
  // only: the reducer never stores it (the note is DRIVER-side state, never persisted — same
  // boundary as summaries/mandates). reviewing → running-children + next pending child → recon.
  | { type: "PARENT_REVIEW_DONE"; path: NodePath; note: string | null }
  // PHASE 5 — THE FORCED ACCEPTANCE GATE RESOLUTIONS (root-only, no path — they address the root's
  // completion window, like the prototype gate addresses the genesis window). Both perform the
  // ORIGINAL finalize the gate deferred (root running-children acceptance window → summarized +
  // notifyDone) and clear pendingAcceptance. Legal ONLY while the gate is open (the root resting in
  // its acceptance window with pendingAcceptance set); dispatched anywhere else throws LOUDLY.
  //   - ACCEPTANCE_APPROVED: the built result clears the baseline floor. Records acceptance_ =
  //     {verdict:"approved", decided_ms}.
  //   - ACCEPTANCE_DIVERGED: the user accepted a result below the floor and recorded WHY. Records
  //     acceptance_ = {verdict:"diverged", reason, decided_ms} — `reason` is a serializable field
  //     round-tripped through toLedger2/rehydrate. `decidedMs` rides the event (the reducer never
  //     reads a clock — START's nowMs precedent).
  | { type: "ACCEPTANCE_APPROVED"; decidedMs: number }
  | { type: "ACCEPTANCE_DIVERGED"; reason: string; decidedMs: number }
  // PHASE 6 — THE FORCED-ACCEPTANCE REFINE (re-plan) BRANCH. A THIRD acceptance-gate action, beside
  // approve and accept-divergence: re-plan a chosen sub-plan as a first-class operation. `target`
  // addresses the node to re-plan (a non-empty path — the root [] is illegal: the root writes no
  // plan/summary and re-planning the whole tree is "start a new plan", not a refine). The reset is
  // the ENTIRE STORY — there is deliberately NO "stale summary" flag: RESET the target node AND every
  // RIGHT-SIBLING at the target's level back to a fresh re-execution shape (target → open/recon
  // active, right-siblings → open/pending), preserving the LEFT-siblings as summarized. The result is
  // a coherent `summarized* active pending*` per-level partition assertCoherent2 already permits, so
  // the normal executing→summary→advanceAfterSummary flow re-runs the reset nodes and OVERWRITES
  // their summaries; on the root's re-completion (baseline_ still present, acceptance_ still absent)
  // the Phase-5 acceptance gate RE-ARMS automatically. Clears pendingAcceptance (we are executing
  // again) and records NO verdict. Legal ONLY while the acceptance gate is open (the root resting in
  // its acceptance window with pendingAcceptance set); dispatched anywhere else throws LOUDLY.
  | { type: "ACCEPTANCE_REFINED"; target: NodePath }
  | { type: "CLARIFY_REQUESTED"; toolUseId: string; questions: AskUserQuestionItem[] }
  | { type: "CLARIFY_ANSWERED"; toolUseId: string; answers: AskUserQuestionAnswers }
  // SESSION-CAPTURE ARC (resume support): the SDK session_id arrived on the system_init frame. This
  // is NOT a node transition — it stamps the run-level sdk_session_id onto the ledger and SELF-
  // PERSISTS so a killed run leaves a resumable id on disk (the id is never carried by a later node
  // transition). Idempotent: a re-dispatched same id is a no-op (no change, no persist effect).
  | { type: "SESSION_INITIALIZED"; sessionId: string }
  // QUOTA AUTO-RESUME ARC (usage-limit pause/resume). These are RUN-LEVEL events (no path — they
  // address the run's auto-resume budget, like SESSION_INITIALIZED addresses the run's session id),
  // and like every gen-2 event the reducer reads NO clock: every timestamp rides its event.
  //   - QUOTA_BUDGET_SET: dispatched at START from the composer's quota-resume choice. Sets
  //     auto_resume_ = { budget, remaining: budget } — the run's auto-resume allotment. NOT dispatched
  //     on the resume() path (a resumed run has no fresh choice — it keeps its persisted budget, or
  //     fails closed at 0 if none was set).
  //   - QUOTA_PAUSED: a usage-limit quota_exceeded frame arrived; the run is paused until `resetAt`
  //     (epoch ms — the provider's reset time, ridden on the event). `source` names the limit that
  //     tripped (display/audit only). The reducer DECIDES whether this pause can auto-resume:
  //     remaining > 0 ⇒ notifyQuotaPaused (a countdown to auto-resume); remaining === 0 (or no budget)
  //     ⇒ notifyQuotaExhausted (no auto-resume left).
  //   - QUOTA_RESUMED: the orchestrator's auto-resume timer fired (or the user resumed manually);
  //     decrement remaining by one (down to the floor 0). `nowMs` rides the event (no clock read).
  //   - QUOTA_EXHAUSTED: a terminal exhaust signal (the run cannot auto-resume further). Emits
  //     notifyQuotaExhausted; the budget is left as-is (already 0 in the auto-resume flow).
  | { type: "QUOTA_BUDGET_SET"; budget: number }
  | { type: "QUOTA_PAUSED"; resetAt: number; source: string }
  | { type: "QUOTA_RESUMED"; nowMs: number }
  | { type: "QUOTA_EXHAUSTED"; resetAt: number; source: string }
  | { type: "FATAL"; message: string };

// ---- gen-2 effects (the reducer DECIDES; the driver EXECUTES) ----------------------------------
//
// Same effect KINDS and per-event ordering as gen 1 at depth 1, with two deliberate deltas (both
// driver-cutover seams, documented on PlanTreeEvent2 above):
//   - NO writeAgentPlan kind (the driver writes plans before dispatching DRAFTED events);
//   - NODE_RECON_DONE emits no writePlanTreeFile (recon.md becomes a driver write);
//   - notifyAwaitingApproval now fires for DECOMPOSITION_DRAFTED too (gate unification: the gen-1
//     driver surfaced the master gate itself via the nn:-1 sentinel — the reducer owns it now).
export type Effect2 =
  // Persist the ledger (toLedger2) to .plan-tree/state.json.
  | { kind: "persist" }
  // Archive every current entry of <cwd>/.plan-tree/ (START only, BEFORE persist).
  | { kind: "resetPlanTreeDir" }
  // Write an auxiliary plan-tree file (gen 2 emits this for INTENT.md only — see the seam note).
  | { kind: "writePlanTreeFile"; name: string; contents: string }
  // PHASE 6 — Delete an auxiliary plan-tree file (the refine branch's per-reset-node cleanup). Emitted
  // by ACCEPTANCE_REFINED for each reset node's `NN-plan.md` and `NN-summary.md`, so the re-executed
  // sub-plans overwrite a clean slate (a stale summary cannot survive a re-plan). The driver's delete
  // is the SAME containment-guarded allow-list as writePlanTreeFile (deletePlanTreeFile reuses
  // guarded_plan_tree_path), and absent ⇒ graceful no-op (a leaf node never wrote `NN-plan.md`).
  | { kind: "deletePlanTreeFile"; name: string }
  // Resolve a held canUseTool permission (ExitPlanMode / AskUserQuestion).
  | { kind: "resolvePermission"; id: string; allow: boolean; message?: string }
  // Surface that a node (decomposition OR leaf — unified) is awaiting the user's approval.
  | { kind: "notifyAwaitingApproval"; gate: ApprovalGate2 }
  // Surface that a visual prototype is awaiting the user's review (the root prototype gate).
  | { kind: "notifyPrototypeReview"; gate: PrototypeGate }
  // PHASE 5 — Surface the forced acceptance gate: the run is complete EXCEPT the user must record a
  // verdict against the frozen baseline (Approve / Accept divergence). The driver opens the baseline
  // (open_baseline) and surfaces the Approve/Diverge actions; notifyDone is WITHHELD until one of
  // ACCEPTANCE_APPROVED/DIVERGED resolves the gate.
  | { kind: "notifyAcceptanceReview"; gate: AcceptanceGate }
  // Surface that a node's summary was written (path-branded — never the summary text).
  | { kind: "notifySummaryWritten"; path: NodePath; summaryPath: PlanTreeFilePath }
  // Surface that the whole tree is done.
  | { kind: "notifyDone" }
  // QUOTA AUTO-RESUME — surface that the run is PAUSED on a usage limit and WILL auto-resume. The
  // driver starts a countdown to `resetAt` and arms the auto-resume timer; `remaining` is the
  // post-pause auto-resume count it may display ("N auto-resumes left"); `source` names the limit.
  | { kind: "notifyQuotaPaused"; resetAt: number; remaining: number; source: string }
  // QUOTA AUTO-RESUME — surface that the run is PAUSED with NO auto-resume left (budget exhausted, or
  // never set — the fail-closed default). The driver surfaces a paused-until-`resetAt` state but does
  // NOT auto-resume; only a manual user action continues the run. `source` names the limit.
  | { kind: "notifyQuotaExhausted"; resetAt: number; source: string }
  // Surface a fatal error.
  | { kind: "notifyFatal"; message: string };
