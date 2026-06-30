// Multiplan orchestration — frozen public interfaces (leaf): Mandate, OrchestratorObserver,
// OrchestratorHandle.
//
// Relocated VERBATIM from the former single-file orchestrator.ts. No logic changed; only the
// one-level relative-import path shifts forced by moving into the orchestrator/ subdirectory.
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


// The structured mandate a child node carries out of its parent's decomposition. A bare string no
// longer compiles as a mandate: the section BODY (the scope paragraphs under the `### Sub-Plan NN:`
// header) and the decomposition PREAMBLE (shared context above the first header) travel WITH the
// title, so a node prompt can never silently degrade to title-only (the lost-mandate bug).
export interface Mandate {
  title: string;
  sectionBody: string;
  masterPreamble: string;
}

// ---- observer + handle (frozen public surface) ----------------------------------------------

// The observer the renderer/main.ts subscribes to. Every hook is optional so a partial observer
// compiles. These are fired by the matching notify* effects + onSnapshot after every transition.
export interface OrchestratorObserver {
  // Fired after EVERY transition with the fresh snapshot (so the UI can re-render).
  onSnapshot?(snap: PlanTreeSnapshot2): void;
  // A node is awaiting the user's approval — the UNIFIED gate (decomposition AND leaf; the root
  // decomposition gate included — the gen-1 nn:-1 sentinel is gone).
  onAwaitingApproval?(gate: ApprovalGate2): void;
  // A held AskUserQuestion is awaiting the user's answers.
  onClarify?(clarify: ClarifyGate): void;
  // A visual prototype is awaiting the user's review (the root prototype gate). Fired by the
  // notifyPrototypeReview effect; resolved via approvePrototype()/refinePrototype() — by TURN
  // COMPLETION, not a held tool, so there is nothing to purge on cancel.
  onPrototypeReview?(gate: PrototypeGate): void;
  // PHASE 5 — the forced acceptance gate is awaiting the user's verdict against the frozen baseline.
  // Fired by the notifyAcceptanceReview effect (the driver has already opened the baseline). The run
  // is built but NOT done — notifyDone is withheld until approveAcceptance()/divergeAcceptance().
  // `gate` is the driver-AUGMENTED AcceptanceGate (cwd/openTarget/runCommand filled in). Like the
  // prototype gate, resolution is by an explicit user action, not a held tool — nothing to purge.
  onAcceptanceReview?(gate: AcceptanceGate): void;
  // A node's summary was written. `summaryPath` is the written FILE's real path (write-minted
  // brand) — never the summary text.
  onSummaryWritten?(path: NodePath, summaryPath: PlanTreeFilePath): void;
  // The whole tree finished (terminal). `snap` is the final snapshot.
  onDone?(snap: PlanTreeSnapshot2): void;
  // A fatal error occurred (terminal). The driver tears down after dispatching this.
  onFatal?(message: string): void;
  // PHASE 4 — QUOTA AUTO-RESUME SURFACE (NON-terminal). The run hit a usage/rate-limit quota wall
  // and PAUSED (it is NOT torn down — `active` stays true). The orchestrator has scheduled a
  // wall-clock-aware timer to `resetAt` and will auto-resume the interrupted turn when it fires.
  //   - `resetAt` is epoch-MILLISECONDS (when the quota refreshes).
  //   - `remaining` is the auto-resume budget left AFTER this pause (always > 0 when paused — at 0
  //     the reducer routes to onQuotaExhausted instead).
  //   - `source` is the detection carrier (rate-limit event vs. thrown error).
  // Phase 5 binds this to the countdown banner; Phase 8 to a desktop notification.
  onQuotaPaused?(info: { resetAt: number; remaining: number; source: string }): void;
  // PHASE 4 — the run hit a quota wall but the auto-resume budget is SPENT (remaining 0, or no
  // budget was ever granted — fail-closed). NO timer is scheduled; the only affordance is Cancel.
  // The run stays paused/active (not torn down) so the user can read the next reset time.
  onQuotaExhausted?(info: { resetAt: number; source: string }): void;
  // PHASE 4 — the quota refreshed and the interrupted turn was auto-resumed (the in-memory pause is
  // cleared; the run is live again). Fired after the resume prompt is re-issued. Phase 5 clears the
  // banner on this; Phase 8 fires a "resumed" notification.
  onQuotaResumed?(): void;
}

// The frozen handle main.ts / the renderer hold to drive the orchestration.
export interface OrchestratorHandle {
  // Begin a run for `request` rooted at `cwd`. Idempotent-guarded: a second call while active is a
  // no-op. Stores `cwd` for all subsequent .plan-tree/ writes. Returns true when a run was really
  // started, false when this was the idempotent no-op (so the composer can avoid closing on a dead
  // start). On a real start it opens the SDK session and sends the first (intent) prompt.
  start(args: { cwd: string; request: string; images?: AttachedImage[] }): Promise<boolean>;
  // RESUME (Phase 3): continue a non-terminal plan-tree from disk WITHOUT reset. Mirrors start() but
  // does NOT dispatch START and does NOT call resetPlanTreeDir — it seeds `state` from the ledger
  // (rehydrateState2), reloads non-serialized driver state (summaries/mandates) from the on-disk
  // .plan-tree/ artifacts, opens the SDK session in the DERIVED policy resuming the prior transcript
  // (resumeSessionId: ledger.sdk_session_id), and either re-presents the held approval gate purely
  // from disk or re-sends the current step's prompt. Idempotent-guarded like start(): a call while a
  // run is active returns false. Returns false (no run started) when the ledger's active phase is not
  // resumable (the frontend should not offer Resume for those, but guard anyway).
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
  // Approve the held visual prototype: composes + writes INTENT.md (prose + the embeddable-visual
  // block) via PROTOTYPE_APPROVED, then continues into recon exactly like INTENT_CLARIFIED's
  // continuation. Throws loudly when no prototype gate is pending.
  //
  // WORKING-REFERENCE classification (Phase 3): pass { asWorkingReference: true } when the user
  // marked the prototype a "working reference" (a FLOOR on the outcome dimensions, never a match-
  // target) rather than the default "just a sketch". On true the driver freezes
  // .plan-tree/prototype/ → .plan-tree/baseline/ and records the frozen baseline on the ledger; the
  // default (omitted/false) is byte-identical to the prior behavior (nothing is frozen).
  approvePrototype(opts?: { asWorkingReference?: boolean }): Promise<void>;
  // Send the held prototype back for another round with the user's feedback: dispatches
  // PROTOTYPE_REFINED (root loops to clarifying-intent), re-arms the intent turn, and sends the
  // refine prompt. The session is idle (the intent turn already ended) — no interrupt. Throws
  // loudly when no prototype gate is pending.
  //
  // COMBINED apply-and-approve: pass { autoApprove: true } when the user typed feedback AND clicked
  // approve. The driver loops the prototype back for one round (applying the feedback) but arms an
  // internal latch so the revised prototype block auto-resolves the gate forward to recon WITHOUT
  // surfacing another review round. The flag is driver-owned — never model/agent-controlled.
  refinePrototype(feedback: string, opts?: { autoApprove?: boolean }): Promise<void>;
  // PHASE 5 — RESOLVE THE FORCED ACCEPTANCE GATE (baseline-bearing runs only). Both perform the
  // deferred finalize (root → summarized + notifyDone) and clear the gate; the verdict is recorded on
  // the ledger (acceptance_). Throw loudly when no acceptance gate is pending.
  //   - approveAcceptance(): the built result clears the baseline floor.
  //   - divergeAcceptance(reason): the user accepts a result below the floor and records WHY (the
  //     reason is persisted as the audit trail).
  approveAcceptance(): Promise<void>;
  divergeAcceptance(reason: string): Promise<void>;
  // PHASE 6 — RE-PLAN (refine) a chosen sub-plan from the forced acceptance gate (the THIRD gate
  // action, beside approve and accept-divergence). `target` is the sub-plan to re-plan (a direct root
  // child today — the top-level sub-plans the gate surfaces). RESETS the target node AND its
  // right-siblings to a fresh re-execution shape (the target re-runs recon→draft→exec→summary and its
  // right-siblings re-run after it), deletes their stale on-disk NN-plan.md/NN-summary.md, clears the
  // gate, and records NO verdict. The re-run OVERWRITES the reset nodes' summaries; on the tree's
  // re-completion the acceptance gate RE-ARMS automatically. Throws loudly when no acceptance gate is
  // pending.
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
  // INTERNAL READ-ONLY PROBE (not part of the public UI contract): true iff the sequencer currently
  // holds the `{tag:"resuming"}` arm — i.e. the orchestrator deliberately interrupted the in-flight
  // post-decomposition-approval turn and is waiting on its aborted `result`. index.ts's result
  // tagger consults this (via isOrchestratorResuming()) AT INGEST to mark that aborted result as a
  // deliberate interrupt rather than a genuine failure.
  resuming(): boolean;
  // PHASE 4 / DA-I5 — SYNCHRONOUS QUOTA-PAUSE PROBE (mirrors resuming()): true between a
  // quota_exceeded pause and its auto-resume (or cancel/exhaust-then-cancel). It is synchronously
  // correct: it returns true from the INSTANT markQuotaPausePending() is called (the agent-stream
  // listener calls it the moment a quota_exceeded frame is seen), through the microtask-deferred
  // QUOTA_PAUSED dispatch that installs the established pause, until the pause resolves. BOTH
  // agent-exit listeners (index.ts AND main.ts) consult it to land "paused" on a same-tick exit
  // rather than tearing the session down / purging held reviews. Read-only.
  quotaPaused(): boolean;
  // DA-I5 — SYNCHRONOUS pause-pending latch. The agent-stream listener calls this the instant a
  // quota_exceeded frame is seen, BEFORE the fire-and-forget ingestStream schedules the
  // (microtask-deferred) QUOTA_PAUSED dispatch. It makes quotaPaused() synchronously true so a
  // same-tick agent-exit is classified as a PAUSE by both listeners. Subsumed once the established
  // pause installs; cleared when the pause resolves (resume/cancel/teardown/terminal). Idempotent.
  markQuotaPausePending(): void;
  // PHASE 4 — PRIOR-SESSION EXIT SIGNAL. The orchestrator does NOT subscribe to the `agent-exit`
  // Tauri event (index.ts / main.ts own that listener); they forward it here. While a quota pause is
  // armed, this records that the prior (paused) sidecar session has actually exited — the precondition
  // for re-opening a session (the Rust one-session-per-launch guard rejects a second `start` until the
  // prior child is reaped). If the resume timer already fired and was WAITING on this exit, receiving
  // it kicks the deferred resume. A no-op when no pause is armed. Idempotent. (Phase 6 wires the call
  // site; the auto-resume path tolerates it never arriving in tests via the same guard.)
  notifyAgentExit(): void;
  // INTERNAL FUNNEL (not part of the public UI contract): feed a reducer event directly. The handle
  // methods call this; the live agent-stream listener (later sub-plan) will too, and tests script a
  // run through it. Exposed so events with no public method (NODE_RECON_DONE, SIZER_DONE, …) are
  // drivable.
  dispatch(event: PlanTreeEvent2): Promise<void>;
}
