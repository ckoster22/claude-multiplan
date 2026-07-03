// Multiplan orchestration — frozen public interfaces (leaf): Mandate, OrchestratorObserver,
// OrchestratorHandle.
// NOTE: `../types` here is the EXISTING src/conversation/types.ts (AgentStream / AskUserQuestion* /
// ToolPermissionRequested) — distinct from this orchestrator-leaf `types.ts`.

import type {
  PlanTreeSnapshot2,
  ApprovalGate2,
  ClarifyGate,
  PrototypeGate,
  AcceptanceGate,
  NodePath,
  PlanTreeFilePath,
  RecursiveLedger,
  PlanTreeEvent2,
} from "../plan-tree";
import type { AgentStream, AskUserQuestionAnswers, ToolPermissionRequested } from "../types";
import type { AttachedImage } from "../images";
import type { ModelOptions } from "../../model-picker";


// The structured mandate a child node carries out of its parent's decomposition. The section BODY
// (scope under the `### Sub-Plan NN:` header) and decomposition PREAMBLE (shared context above the
// first header) travel WITH the title, so a node prompt can never silently degrade to title-only.
export interface Mandate {
  title: string;
  sectionBody: string;
  masterPreamble: string;
}

// The observer the renderer/main.ts subscribes to. Every hook is optional so a partial observer
// compiles. These are fired by the matching notify* effects + onSnapshot after every transition.
export interface OrchestratorObserver {
  // Fired after EVERY transition with the fresh snapshot (so the UI can re-render).
  onSnapshot?(snap: PlanTreeSnapshot2): void;
  // A node is awaiting the user's approval — the UNIFIED gate (decomposition AND leaf; the root
  // decomposition gate included).
  onAwaitingApproval?(gate: ApprovalGate2): void;
  // A held AskUserQuestion is awaiting the user's answers.
  onClarify?(clarify: ClarifyGate): void;
  // A visual prototype is awaiting the user's review (the root prototype gate). Fired by the
  // notifyPrototypeReview effect; resolved via approvePrototype()/refinePrototype() — by TURN
  // COMPLETION, not a held tool, so there is nothing to purge on cancel.
  onPrototypeReview?(gate: PrototypeGate): void;
  // The forced acceptance gate is awaiting the user's verdict against the frozen baseline.
  // Fired by notifyAcceptanceReview (the driver has already opened the baseline). The run is built but
  // NOT done — notifyDone is withheld until approveAcceptance()/divergeAcceptance(). `gate` is the
  // driver-AUGMENTED AcceptanceGate (cwd/openTarget/runCommand filled in). Resolved by an explicit
  // user action, not a held tool — nothing to purge.
  onAcceptanceReview?(gate: AcceptanceGate): void;
  // A node's summary was written. `summaryPath` is the written FILE's real path (write-minted
  // brand) — never the summary text.
  onSummaryWritten?(path: NodePath, summaryPath: PlanTreeFilePath): void;
  // The whole tree finished (terminal). `snap` is the final snapshot.
  onDone?(snap: PlanTreeSnapshot2): void;
  // A fatal error occurred (terminal). The driver tears down after dispatching this.
  onFatal?(message: string): void;
  // QUOTA AUTO-RESUME SURFACE (NON-terminal). The run hit a quota wall and PAUSED (NOT torn
  // down — `active` stays true); a wall-clock-aware timer to `resetAt` will auto-resume the turn.
  //   - `resetAt` is epoch-MILLISECONDS (when the quota refreshes).
  //   - `remaining` is the auto-resume budget left AFTER this pause (always > 0 when paused — at 0
  //     the reducer routes to onQuotaExhausted instead).
  //   - `source` is the detection carrier (rate-limit event vs. thrown error).
  onQuotaPaused?(info: { resetAt: number; remaining: number; source: string }): void;
  // The run hit a quota wall but the auto-resume budget is SPENT (remaining 0, or no
  // budget was ever granted — fail-closed). NO timer is scheduled; the only affordance is Cancel.
  // The run stays paused/active (not torn down) so the user can read the next reset time.
  onQuotaExhausted?(info: { resetAt: number; source: string }): void;
  // The quota refreshed and the interrupted turn was auto-resumed (the in-memory pause is
  // cleared; the run is live again). Fired after the resume prompt is re-issued.
  onQuotaResumed?(): void;
}

// The frozen handle main.ts / the renderer hold to drive the orchestration.
export interface OrchestratorHandle {
  // Begin a run for `request` rooted at `cwd`. Idempotent-guarded: a second call while active is a
  // no-op returning false (so the composer doesn't close on a dead start); a real start returns true,
  // stores `cwd` for .plan-tree/ writes, opens the SDK session, and sends the first (intent) prompt.
  start(args: { cwd: string; request: string; images?: AttachedImage[] }): Promise<boolean>;
  // RESUME: continue a non-terminal plan-tree from disk WITHOUT reset. Mirrors start() but
  // skips START/resetPlanTreeDir — seeds `state` from the ledger (rehydrateState2), reloads
  // non-serialized driver state (summaries/mandates) from disk, opens the SDK session in the DERIVED
  // policy resuming the prior transcript (resumeSessionId: ledger.sdk_session_id), then either
  // re-presents the held gate from disk or re-sends the current step's prompt. Idempotent-guarded;
  // returns false on a no-op-while-active OR when the active phase is not resumable (guard anyway).
  resume(args: { cwd: string; ledger: RecursiveLedger }): Promise<boolean>;
  // The current read-only snapshot (throws if never started).
  snapshot(): PlanTreeSnapshot2;
  // Approve the HELD gate addressed by its pathKey string (the UNIFIED approve surface — routes by
  // gate.kind: a decomposition approval arms the resuming hold + interrupts; a leaf approval
  // resolves + arms exec and NEVER interrupts). Throws loudly if the key parses to a path no held
  // gate matches.
  approve(pathKeyStr: string): Promise<void>;
  // Request changes to the HELD gate addressed by its pathKey string (denies with feedback; the
  // deny resumes the held turn to re-draft in place — NOTHING is sent inline).
  requestChanges(pathKeyStr: string, feedback: string): Promise<void>;
  // Answer a held AskUserQuestion (resolves it with the user's selections).
  answerClarify(toolUseId: string, answers: AskUserQuestionAnswers): Promise<void>;
  // USER MODEL OVERRIDE: set the execution model for the node at `path` (the reading-pane picker's
  // segment click). A thin pass-through to EXECUTION_MODEL_SET — the reducer stamps model_source
  // "override" (re-triage never clobbers it) and re-derives inherited-auto models for open descendants.
  setExecutionModel(path: NodePath, options: ModelOptions): Promise<void>;
  // Approve the held visual prototype: composes + writes INTENT.md (prose + the embeddable-visual
  // block) via PROTOTYPE_APPROVED, then continues into recon like INTENT_CLARIFIED. Throws when no
  // prototype gate is pending.
  //
  // WORKING-REFERENCE: { asWorkingReference: true } marks the prototype a FLOOR on the
  // outcome dimensions (not a match-target); the driver freezes .plan-tree/prototype/ →
  // .plan-tree/baseline/ and records the baseline. Default (omitted/false) freezes nothing.
  approvePrototype(opts?: { asWorkingReference?: boolean }): Promise<void>;
  // Send the held prototype back for another round with the user's feedback: dispatches
  // PROTOTYPE_REFINED (root loops to clarifying-intent), re-arms the intent turn, sends the refine
  // prompt. Session is idle — no interrupt. Throws when no prototype gate is pending.
  //
  // COMBINED apply-and-approve: { autoApprove: true } (user typed feedback AND clicked approve) loops
  // one round applying the feedback but arms an internal latch so the revised prototype auto-resolves
  // the gate forward to recon without another review round. Driver-owned — never model-controlled.
  refinePrototype(feedback: string, opts?: { autoApprove?: boolean }): Promise<void>;
  // RESOLVE THE FORCED ACCEPTANCE GATE (baseline-bearing runs only). Both perform the
  // deferred finalize (root → summarized + notifyDone) and clear the gate; the verdict is recorded on
  // the ledger (acceptance_). Throw loudly when no acceptance gate is pending.
  //   - approveAcceptance(): the built result clears the baseline floor.
  //   - divergeAcceptance(reason): the user accepts a result below the floor and records WHY (the
  //     reason is persisted as the audit trail).
  approveAcceptance(): Promise<void>;
  divergeAcceptance(reason: string): Promise<void>;
  // RE-PLAN (refine) a chosen sub-plan from the forced acceptance gate (the THIRD gate
  // action, beside approve and accept-divergence). `target` is the sub-plan to re-plan (a direct root
  // child today). RESETS the target node AND its right-siblings to a fresh re-execution shape
  // (recon→draft→exec→summary), deletes their stale on-disk NN-plan.md/NN-summary.md, clears the gate,
  // records NO verdict. The re-run overwrites the reset summaries; on re-completion the acceptance gate
  // re-arms automatically. Throws when no acceptance gate is pending.
  refineAcceptance(target: NodePath): Promise<void>;
  // Feed a live agent-stream frame to the turn-completion sequencer (see the Sequencing rule).
  ingestStream(frame: AgentStream): Promise<void>;
  // Feed a live tool-permission-requested frame (ExitPlanMode / AskUserQuestion) to the driver.
  ingestPermission(req: ToolPermissionRequested): Promise<void>;
  // Cancel the run: cancel the turn + end the session + purge any held interactive permission. The
  // on-disk ledger is left intact.
  cancel(): Promise<void>;
  // Subscribe an observer; returns an unsubscribe fn.
  subscribe(obs: OrchestratorObserver): () => void;
  // Tear down: unsubscribe all observers + cancel. Idempotent.
  teardown(): Promise<void>;
  // True between start and a terminal done/cancel/fatal.
  orchestrationActive(): boolean;
  // INTERNAL READ-ONLY PROBE (not part of the public UI contract): true iff the sequencer holds the
  // `{tag:"resuming"}` arm — the orchestrator deliberately interrupted the in-flight
  // post-decomposition-approval turn and awaits its aborted `result`. index.ts's result tagger
  // consults this (via isOrchestratorResuming()) AT INGEST to mark that result a deliberate interrupt,
  // not a genuine failure.
  resuming(): boolean;
  // SYNCHRONOUS QUOTA-PAUSE PROBE (mirrors resuming()): true between a quota_exceeded
  // pause and its auto-resume (or cancel/exhaust-then-cancel). Synchronously correct from the INSTANT
  // markQuotaPausePending() fires (before the microtask-deferred QUOTA_PAUSED installs the pause) until
  // the pause resolves. BOTH agent-exit listeners (index.ts AND main.ts) consult it to land "paused" on
  // a same-tick exit rather than tearing the session down / purging held reviews. Read-only.
  quotaPaused(): boolean;
  // SYNCHRONOUS pause-pending latch. The agent-stream listener calls this the instant a
  // quota_exceeded frame is seen, BEFORE the microtask-deferred QUOTA_PAUSED dispatch — making
  // quotaPaused() synchronously true so a same-tick agent-exit is classified a PAUSE by both listeners.
  // Subsumed once the pause installs; cleared when it resolves (resume/cancel/teardown/terminal). Idempotent.
  markQuotaPausePending(): void;
  // PRIOR-SESSION EXIT SIGNAL. index.ts / main.ts own the `agent-exit` listener and forward
  // it here. While a quota pause is armed, this records that the prior (paused) sidecar session exited
  // — the precondition for re-opening a session (the Rust one-session-per-launch guard rejects a
  // second `start` until the prior child is reaped). If the resume timer already fired and was waiting
  // on this exit, it kicks the deferred resume. No-op when no pause is armed. Idempotent.
  notifyAgentExit(): void;
  // INTERNAL FUNNEL (not part of the public UI contract): feed a reducer event directly. The handle
  // methods call this; the live agent-stream listener (later sub-plan) will too, and tests script a
  // run through it. Exposed so events with no public method (NODE_RECON_DONE, SIZER_DONE, …) are
  // drivable.
  dispatch(event: PlanTreeEvent2): Promise<void>;
}
