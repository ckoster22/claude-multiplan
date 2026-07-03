// Multiplan orchestration domain — the IMPURE driver.
//
// The impure counterpart of plan-tree.ts (the PURE reducer): the reducer DECIDES side effects
// (returns an Effect2[]); THIS driver EXECUTES them against an injected dependency interface
// (OrchestratorDeps), persists the ledger to .plan-tree/state.json after every transition, fires
// observer hooks, and exposes the frozen OrchestratorHandle.
//
// Recursive representation: every node is addressed by its NodePath (root []), every gate is the
// unified ApprovalGate2 — approve(pathKey)/requestChanges(pathKey) route by gate.kind.
//
// Testability: every Tauri command the effects need is wrapped in OrchestratorDeps. `defaultDeps()`
// binds them to real `invoke(...)`; tests inject fakes so the driver is unit-tested with NO real
// Tauri, NO listen, NO DOM.
//
// Seam ownership: while an orchestration is active, IT is the sole resolver of interactive tools
// (ExitPlanMode / AskUserQuestion). A MODULE-LEVEL registry lets legacy handlers (main.ts, index.ts)
// consult isOrchestrationActive() WITHOUT holding the handle — they early-return when an orchestration
// owns the seam. This module must NOT import main.ts / index.ts (no cycle).

import { diag } from "../diag";
import {
  reduce2,
  toLedger2,
  toSnapshot2,
  parseSizerDecision,
  parseNn,
  PlanValidationError,
  pathKey,
  parsePathKey,
  summaryName2,
  planName2,
  inRollupWindow,
  isRootCollapseChild,
  writePolicyFor2,
  nodeAtPath,
  activePathOf,
  treeIsDone,
  rehydrateState2,
  resumeScopeForRoot,
  activePhaseLabel,
  type ResumePlan,
  type ResumeScope,
  type TreeNode,
  type NodePath,
  type PathKey,
  type PlanTreeFilePath,
  type PlanTreeState2,
  type PlanTreeEvent2,
  type PlanTreeSnapshot2,
  type ApprovalGate2,
  type WritePolicy,
  type Effect2,
  type PrototypeGate,
  type AcceptanceGate,
} from "../plan-tree";
import { phaseModel } from "../plan-tree/triage";
import type { ModelOptions } from "../../model-picker";
import type {
  AgentStream,
  AskUserQuestionAnswers,
  AskUserQuestionInput,
  AskUserQuestionItem,
  ToolPermissionRequested,
} from "../types";
import {
  intentPrompt,
  refinePrototypePrompt,
  parsePrototypeBlock,
  composeIntentMd,
  reconPrompt,
  sizerPrompt,
  masterDraftPrompt,
  subReconPrompt,
  subDraftPrompt,
  summaryPrompt,
  resumedLeafApprovalPrompt,
  resumedLeafContinuePrompt,
  resumedLeafChangesPrompt,
  resumedDecompositionChangesPrompt,
  quotaResumeWrap,
  nestedDecompositionDraftPrompt,
  rollupSummaryPrompt,
  parentReviewPrompt,
  parseParentReview,
  parseSubPlanHeaders,
  QUOTA_RESUME_GENERIC,
  type ParsedMasterPlan,
} from "./prompts";
import { defaultDeps, type OrchestratorDeps } from "./deps";
import type { OrchestratorHandle, OrchestratorObserver, Mandate } from "./types";


// Exhaustiveness sentinel: reached only if a discriminated-union case is missing from a switch.
// Because every case `return`s, a missing branch leaves the discriminant non-`never` at this call —
// a compile-time error — and, defensively at runtime, throws.
function assertNever(x: never): never {
  throw new Error(`unreachable discriminant: ${String(x)}`);
}

// The EFFECTIVE model a node's live turn runs with: an explicit user override (model_source
// "override") pins the node's stamped execution_model; otherwise the domain-aware phaseModel for the
// node's current (stage, phase). Both the session-open boundaries (E1) and the per-turn model seam
// (E3) resolve through THIS single helper so the opened model and the asserted model can never drift.
function effectiveModel(node: TreeNode): ModelOptions {
  return node.model_source === "override" && node.execution_model
    ? node.execution_model
    : phaseModel(node).options;
}

// Legacy handlers (main.ts, index.ts) don't hold the handle but must know whether an orchestration
// owns the interactive-tool seam. An active orchestrator registers ITSELF here on start, deregisters
// on any terminal (done/cancel/fatal). At most ONE active orchestration at a time (the app is
// single-session); a second while one is active is prevented by the per-handle idempotency guard.

let activeOrchestrator: OrchestratorHandle | null = null;

// Consult the guard WITHOUT holding the handle. main.ts / index.ts import this to decide whether to
// early-return (the orchestrator owns the seam) in their tool-permission handlers.
export function isOrchestrationActive(): boolean {
  return activeOrchestrator !== null;
}

// True iff the ACTIVE orchestration's sequencer holds the `resuming` arm (a deliberate
// post-decomposition-approval interrupt is in flight). Null-safe. index.ts consults this AT INGEST to
// tag the interrupted turn's error `result` on the stored frame — the tag MUST be persisted there,
// because the orchestrator de-arms `resuming` the moment it consumes that result (reading it live at
// derive/render time would lose the verdict on every rebuild).
export function isOrchestratorResuming(): boolean {
  return activeOrchestrator !== null && activeOrchestrator.resuming();
}

// Construct an orchestrator. `deps` defaults to the real Tauri-bound deps; tests inject fakes.
export function createOrchestrator(deps: OrchestratorDeps = defaultDeps()): OrchestratorHandle {
  // The current in-memory state (null until start). Every transition replaces it via dispatch().
  // LIFECYCLE field (NOT a per-run transient — kept outside RunState; reset separately by START).
  let state: PlanTreeState2 | null = null;
  // Whether this orchestration is active (true between start and terminal). LIFECYCLE field.
  let active = false;
  // Observers the renderer/main.ts subscribe to (fired by the notify* effects + onSnapshot). LIFECYCLE.
  const observers = new Set<OrchestratorObserver>();
  let torn = false;

  // THE SEQUENCER, in one discriminated union. `awaiting` is the step whose turn-completion `result`
  // the driver waits on; it CARRIES that step's own assistant-text buffer (and captured path, where
  // per-node). Three illegal states a split step-flag + shared text-buffer pair could represent are
  // UNREPRESENTABLE by construction:
  //   • swallow: a `result` while `{tag:"idle"}` is dropped (no armed step to advance);
  //   • double-advance: each branch reads ITS OWN buffer/path and re-arms exactly one successor;
  //   • buffer-merge: assistant_text appends to the CURRENT variant's buffer only, never a shared
  //     one, so one step's chatter can never leak into the next step's capture.
  // The ingest queue serializes frames so these invariants hold even under concurrent delivery.
  //
  // every per-node variant carries the node's NodePath. `recon` UNIFIES the gen-1 root
  // recon (path []) and sub-recon (path [nn]) variants — the consume branch routes on path.length.
  // INVARIANT[awaiting-exactly-one-armed-step] (type-level): at most one sequencer step is armed — `run.awaiting` is exactly one tagged variant; a result while idle is swallowed.
  //   prevents: a boundary result consumed by the wrong step; two steps armed at once
  type Awaiting =
    | { tag: "idle" } // a `result` here is SWALLOWED by construction
    | { tag: "intent"; buffer: string }
    | { tag: "recon"; path: NodePath; buffer: string }
    | { tag: "sizer"; path: NodePath; buffer: string }
    | { tag: "exec"; path: NodePath; buffer: string } // buffer is unread by design
    | { tag: "summary"; path: NodePath; buffer: string }
    // THE PARENT-REVIEW TURN: armed after a non-final child's SUMMARY_WRITTEN moved the
    // parent to `reviewing`. The buffer captures the review's ADJUST/NONE text; `reviewedChild` is the
    // just-summarized child (its summary rode the prompt). Consumed by the parent-review branch:
    // PARENT_REVIEW_DONE + the next child's recon INLINE (the review result IS the boundary — nothing
    // in flight, no resuming arm).
    | { tag: "parent-review"; parentPath: NodePath; reviewedChild: NodePath; buffer: string }
    // RESUMING: a turn is still in flight after a DECOMPOSITION approval-resolve (the SDK resumes the
    // SAME turn on allow, with its canned "start coding" injection). The next step — the recon turn
    // for `nextPath` — is DEFERRED until that turn's `result` arrives (the `resuming` branch); sending
    // it inline would queue it INTO the in-flight turn (the no-gate incident: a whole sub-plan in one
    // merged turn). The resumed turn must NOT finish voluntarily either — told "start coding", it
    // free-runs (the phase-1 incident: background agents, no result for minutes, watchdog FATAL) — so
    // approve()'s decomposition branch interrupts it right after arming this hold; the aborted `result`
    // is the boundary that fires the deferred send. The tag itself disambiguates: a `result` here can
    // ONLY mean "the resumed turn ended". No buffer — resume-turn chatter is dropped by design.
    | { tag: "resuming"; nextPath: NodePath };

  // The driver holds ONE handle across runs (the singleton). A per-run transient left populated bleeds
  // run A's context into run B (a stale summary/mandate/held-permission id). Bundling ALL of them here
  // means a fresh run allocates a fresh RunState and EVERY transient resets TOGETHER — the
  // cross-run-leak class is unrepresentable (you cannot reset `summaries` yet forget `mandates`). The
  // LIFECYCLE fields (state/active/observers/torn) stay OUT (not per-run data that bleeds; `state` is
  // reset by START), as do quotaWakeOff (a managed resource handle) + ingestSeen (a per-HANDLE
  // counter). Allocated fresh in start()/resume(); deliberately NOT nulled at markTerminal — cancel()
  // reads run.heldPermissionId AFTER markTerminal, and the next start()/resume() replaces it wholesale.

  // The in-memory quota pause (transient, never persisted — only the auto-resume BUDGET rides the
  // ledger). Non-null between a quota_exceeded pause and its resume/cancel. Fields: resetAt = epoch-ms
  // the quota refreshes (timer target + wall-clock re-check anchor); remaining = auto-resume budget
  // left (always > 0 when not exhausted); source = detection carrier (observer/banner); awaitingVariant
  // = the in-flight turn captured AT PAUSE, re-armed verbatim on resume; exhausted = budget spent (no
  // timer, Cancel-only surface); priorExited = has the paused sidecar's agent-exit been observed (the
  // respawn precondition — the Rust one-session guard); backstopAttempts = bounded !priorExited defers.
  interface QuotaPause {
    resetAt: number;
    remaining: number;
    source: string;
    awaitingVariant: Awaiting;
    exhausted: boolean;
    priorExited: boolean;
    backstopAttempts: number;
  }

  // INVARIANT[runstate-all-or-nothing-reset] (type-level): every per-run transient lives in this one bundle; freshRunState's `: RunState` return forces every field initialized, and start()/resume() replace it wholesale, so all transients reset together.
  //   prevents: run A's context (stale summary/mandate/held-permission) bleeding into run B
  interface RunState {
    // The cwd for all .plan-tree/ writes (captured at start) + the original request (threaded into
    // draft prompts).
    cwd: string;
    request: string;
    // The current armed sequencer step + its own buffer (idle = no armed step). See the Awaiting header.
    awaiting: Awaiting;
    // pathKey -> the completed node's summary text (threaded forward into later sibling prompts). Keyed
    // by the branded PathKey so a bare string cannot address it.
    summaries: Map<PathKey, string>;
    // pathKey -> the node's structured Mandate, rebuilt at every decomposition ExitPlanMode parse (so
    // re-drafts replace stale sections). Empty in the degenerate single path — mandateFor falls back to
    // a title-only Mandate from the tree.
    mandates: Map<PathKey, Mandate>;
    // toolUseId -> the AskUserQuestion's questions (retained for the CLARIFY_ANSWERED updatedInput
    // reshape; the reducer nulls pendingClarify before the effect runs, so state can't supply them).
    clarifyQuestions: Map<string, AskUserQuestionItem[]>;
    // The confirmed intent (the intent-clarifier's final message), threaded into recon + decomposition-
    // draft. null when no/empty intent was confirmed (those prompts stay byte-identical pre-feature).
    confirmedIntent: string | null;
    // VISUAL-PROTOTYPE state: the prose intent captured alongside a held prototype (composeIntentMd's
    // first arg at approvePrototype), and the DRIVER-OWNED refine-round counter (counts COMPLETED refine
    // requests; the gate is minted round prototypeRound+1, so the UI loop-escape threshold can't be gamed).
    pendingIntentText: string | null;
    prototypeRound: number;
    // COMBINED apply-and-approve latch (driver-owned, NEVER model-controlled): the revised prototype
    // block auto-resolves the gate forward instead of surfacing another review round.
    autoApproveNext: boolean;
    // The SDK session_id captured off system_init (parallel to the ledger's self-persisted copy) — held
    // so the id is never lost even if the SESSION_INITIALIZED dispatch is a no-op.
    sdkSessionId: string | null;
    // The id of any currently-held interactive permission (ExitPlanMode/AskUserQuestion) so cancel() can
    // purge it (deny) rather than strand the sidecar's held resolver.
    heldPermissionId: string | null;
    // RESUME — the resumed-gate flag: a re-presented gate's toolUseId is a synthetic `resumed:` sentinel,
    // NOT a live id; approve()/requestChanges() read this to take the resumed continuation-prompt path.
    resumedGate: boolean;
    // the single pending adjustment note from the most recent parent review (parentKey scopes
    // it: only children of THAT parent ever see it). At most one can be pending by construction.
    // INVARIANT[at-most-one-adjust-note] (type-level): at most one parent-review adjustment note is pending (single nullable field), scoped to its issuing parent's children via parentKey.
    //   prevents: a second pending note coexisting / leaking into another level's prompts
    adjustNote: { parentKey: PathKey; note: string } | null;
    // DERIVED WRITE POLICY cache: the last permission mode the driver knows the session is in (null =
    // unknown, forcing a re-assert). Mode is a PURE function of the ledger; this only avoids redundant setMode.
    assertedPolicy: WritePolicy | null;
    // DERIVED MODEL cache: the last model the driver knows the live session is on (null = unknown,
    // forcing a re-assert). The model is a PURE function of the active node's (stage, phase) + override
    // (effectiveModel); this only avoids redundant setModel.
    assertedModel: string | null;
    // TURN WATCHDOG handle (one shared slot — one turn in flight): armed alongside every resuming hold
    // AND every summary/parent-review/intent turn; a missing result drives a LOUD terminal FATAL.
    turnWatchdog: unknown;
    // QUOTA AUTO-RESUME: the in-memory pause, the live resume-timer handle, the synchronous pause-pending
    // flag (the shared quotaPaused() probe), and the capture-bridge read by the notify* effect handlers.
    quotaPause: QuotaPause | null;
    quotaPausePending: boolean;
    quotaTimer: unknown;
    pendingQuotaCapture: Awaiting | null;
  }

  // Allocate a fresh per-run transient bundle. Defaults match the pre-bundle initial values
  // (assertedPolicy "plan"; start() overrides it to "prototype", resume() to the derived policy).
  function freshRunState(cwd: string, request: string): RunState {
    return {
      cwd,
      request,
      awaiting: { tag: "idle" },
      summaries: new Map(),
      mandates: new Map(),
      clarifyQuestions: new Map(),
      confirmedIntent: null,
      pendingIntentText: null,
      prototypeRound: 0,
      autoApproveNext: false,
      sdkSessionId: null,
      heldPermissionId: null,
      resumedGate: false,
      adjustNote: null,
      assertedPolicy: "plan",
      assertedModel: null,
      turnWatchdog: null,
      quotaPause: null,
      quotaPausePending: false,
      quotaTimer: null,
      pendingQuotaCapture: null,
    };
  }

  // The current run's transient bundle. Allocated fresh at construction; REPLACED wholesale in
  // start()/resume() so a fresh run can never inherit a prior run's transients.
  let run: RunState = freshRunState("", "");
  // The unsubscribe fn for the wake seam (document.visibilitychange), wired once at start/resume and
  // torn down with the run. Null when no wake subscription is live. NOT a RunState transient — a
  // managed resource handle (installWakeSeam tears down the prior subscription on re-install).
  let quotaWakeOff: (() => void) | null = null;
  // TEST-ONLY OBSERVABILITY: how many ingest-impl thunks the queue DEQUEUED and INVOKED (each bumps it
  // at its top, BEFORE the terminal guard). Lets the error-isolation test prove a throw in one frame
  // did NOT poison the queue — the next frame's thunk still ran. NOT part of the frozen UI contract.
  let ingestSeen = 0;

  // PER-LEVEL summary threading: the summaries of `parentPath`'s DIRECT children only, in
  // pathKey order (fixed-width zero-padded segments, so lexicographic == per-segment numeric). A
  // nested level threads ONLY its own siblings: 02.02 sees 02.01's summary but never 01's; a later
  // ROOT sibling sees 02's ROLL-UP summary, never the grandchildren's. Keyed by full PathKey —
  // roll-up summaries land under the parent's own key via the same summaries.set the leaves use.
  const priorSummaries = (parentPath: NodePath): string[] => {
    const parentKey = pathKey(parentPath);
    const prefix = parentKey === "" ? "" : `${parentKey}.`;
    return [...run.summaries.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("."))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, text]) => text);
  };

  // The parent path of a node (the level its sibling summaries thread at). Root has no parent —
  // callers never ask (the root threads no sibling summaries).
  const parentPathOf = (path: NodePath): NodePath => path.slice(0, -1);

  // the pending adjustment note FOR a node's prompts: non-null only when a note is
  // pending AND `path` is a child of the parent that issued it (the parentKey scope guard — a
  // stale note can never leak into another level's prompts). Root prompts never carry one.
  const adjustNoteFor = (path: NodePath): string | null => {
    if (!run.adjustNote || path.length === 0) return null;
    return run.adjustNote.parentKey === pathKey(parentPathOf(path)) ? run.adjustNote.note : null;
  };

  // the adjust-note CLEAR POINT (see the adjustNote lifecycle note): called when a
  // child's DRAFTED event lands. By then BOTH prompt injections (the child's recon and draft
  // prompts) have been sent, so the note has fully served its one-sibling scope.
  const clearAdjustNoteOnDraft = (path: NodePath): void => {
    if (run.adjustNote && path.length > 0 && run.adjustNote.parentKey === pathKey(parentPathOf(path))) {
      run.adjustNote = null;
    }
  };

  // The structured Mandate for a node — its `### Sub-Plan NN:` section (title + body) plus the
  // decomposition preamble, captured at the decomposition ExitPlanMode parse. Falls back to a
  // title-only Mandate read from the tree node itself (the degenerate single path, where no
  // decomposition plan exists).
  const mandateFor = (path: NodePath): Mandate => {
    const parsed = run.mandates.get(pathKey(path));
    if (parsed) return parsed;
    const node = state ? nodeAtPath(state.root, path) : null;
    return {
      title: node ? node.title : `Sub-plan ${pathKey(path)}`,
      sectionBody: "",
      masterPreamble: "",
    };
  };

  // The path of the currently-active node (or null when nothing is in flight).
  const activePath = (): NodePath | null => (state ? activePathOf(state.root) : null);

  // The ONLY PlanTreeFilePath mint in the codebase: wrap the plan-tree write command and brand the
  // absolute path it RETURNS. No exported cast helper exists, so a path-typed slot (SUMMARY_WRITTEN
  // / onSummaryWritten) can only ever be fed by a real completed write — never prose.
  const writePlanTreeFileMinted = async (
    name: string,
    contents: string,
  ): Promise<PlanTreeFilePath> =>
    (await deps.writePlanTreeFile(run.cwd, name, contents)) as PlanTreeFilePath;

  // The injected clock (defaults to Date.now): stamps updated_ms at the single persist path.
  const nowFn = deps.now ?? ((): number => Date.now());

  const emitSnapshot = (snap: PlanTreeSnapshot2): void => {
    for (const o of observers) o.onSnapshot?.(snap);
  };

  // Mark this orchestration terminal: flip `active` false and deregister from the module registry.
  // Idempotent. Called on notifyDone / cancel / notifyFatal. `reason` tags the dev terminal with WHICH
  // terminal cause deactivated the orchestrator (and whether one fired BEFORE the recon result).
  const markTerminal = (reason: string): void => {
    // Log every call (even idempotent repeats) with whether this is the active->terminal transition.
    diag(`markTerminal() called via ${reason} (wasActive=${active})`);
    active = false;
    // A pending turn watchdog (resuming/summary/parent-review) must not outlive the run (a late
    // fire against a NEW hold would be a false fatal; the !active guard also covers it, defense in
    // depth).
    clearTurnWatchdog();
    // a paused quota timer must never fire into a dead run (a late fire would call
    // startSession on a torn-down session). Clear the in-memory pause + its timer at every terminal
    // (mirror clearTurnWatchdog). The wake subscription is torn down here too so a visibilitychange
    // after teardown cannot re-enter fireResume. (Both are idempotent no-ops when no pause is armed.)
    clearQuotaPause();
    if (quotaWakeOff) {
      quotaWakeOff();
      quotaWakeOff = null;
    }
    // Tear down the combined apply-and-approve latch with the session: a flag left set across a
    // terminal could auto-resolve a future run's first gate. (Reset alongside prototypeRound in
    // start()/resume() too; this covers cancel()/FATAL/Stop where those resets don't run.)
    run.autoApproveNext = false;
    if (activeOrchestrator === handle) activeOrchestrator = null;
  };

  // End the live SDK session as cancel() does: cancel the in-flight turn then end the session, so
  // index.ts receives an `agent-exit` and resets its controls. Idempotent at the call-site via the
  // callers' `wasActive` guard. Shared by cancel() and notifyFatal so a plain markTerminal() can never
  // leave the session live while isOrchestrationActive()===false (a Stop-routing desync).
  const endSdkSession = async (): Promise<void> => {
    try {
      await deps.cancelRun();
    } catch (err) {
      console.error("cancel_agent_run failed", err);
    }
    try {
      await deps.endSession();
    } catch (err) {
      console.error("end_agent_session failed", err);
    }
  };

  // The shared PROTOTYPE-APPROVE arc. Precondition: the root is in prototype-review holding `gate`.
  // Composes INTENT.md (prose + the embeddable-visual block) and resolves the gate forward (the
  // reducer writes INTENT.md and moves prototype-review → recon; the dispatch seam re-derives the
  // policy and asserts setMode("plan") BEFORE the recon send — the INTENT_CLARIFIED continuation's
  // ordering). Called by approvePrototype() and the intent-ingestion auto-approve branch. The session
  // is IDLE at both call sites, so the recon prompt opens a fresh turn — no resuming hold, no interrupt.
  const resolveApprove = async (gate: PrototypeGate, asWorkingReference = false): Promise<void> => {
    const intentContents = composeIntentMd(run.pendingIntentText ?? "", gate, run.cwd);
    // when the user marked the prototype a working reference,
    // freeze .plan-tree/prototype/ → .plan-tree/baseline/ BEFORE dispatching, so the on-disk copy
    // exists when the reducer records baseline_ + persists. Best-effort for the RECON HOP — a failure
    // is logged but does NOT block recon. But baseline_ is a PRESENCE record that must match disk:
    // `froze` is true iff BOTH ensureBaselineDir and freezeBaseline resolved (either dep undefined ⇒
    // false, no baseline claimed). The dispatch carries `froze` (not the raw user flag) so the reducer
    // never records a baseline absent from disk. The default sketch path (false) skips this — byte-identical.
    let froze = false;
    if (asWorkingReference) {
      try {
        if (deps.ensureBaselineDir && deps.freezeBaseline) {
          await deps.ensureBaselineDir(run.cwd);
          await deps.freezeBaseline(run.cwd);
          froze = true;
          diag("resolveApprove: working reference — froze .plan-tree/prototype/ → .plan-tree/baseline/");
        } else {
          diag("resolveApprove: working-reference freeze skipped (deps absent) — no baseline recorded");
        }
      } catch (err) {
        console.error("freeze_baseline failed (non-fatal)", err);
        diag(`resolveApprove: working-reference freeze failed (non-fatal): ${String(err)} — no baseline recorded`);
      }
    }
    await dispatch({ type: "PROTOTYPE_APPROVED", intentContents, asWorkingReference: froze, frozenMs: nowFn() });
    run.pendingIntentText = null;
    // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
    run.awaiting = { tag: "recon", path: [], buffer: "" };
    diag("resolveApprove: INTENT.md written, armed recon, sending reconPrompt");
    await deps.sendMessage(reconPrompt(run.request, run.confirmedIntent));
  };

  // Execute a single effect against the injected deps. Persist writes the schema-2 ledger to
  // state.json; the notify* effects fan out to observers; resolvePermission also clears the
  // held-permission id. EXHAUSTIVE over Effect2 (assertNever). NOTE: Effect2 has NO writeAgentPlan
  // kind — the driver writes every plans-dir copy ITSELF in ingestPermission (the single authoritative
  // write; the gen-1 wrotePlanForNn one-shot guard is gone — no reducer effect left to no-op).
  const runEffect = async (eff: Effect2): Promise<void> => {
    switch (eff.kind) {
      case "persist": {
        if (!state) return;
        // THE SINGLE updated_ms STAMP: every ledger write carries the write's own fresh injected-now()
        // time (the reducer never touches updated_ms — its old self-max froze the field at created_ms).
        // NOTE: it is a LAST-MODIFIED stamp, not an ordering sequence — two persists in the same ms
        // carry equal stamps (non-decreasing, not strictly increasing).
        state = { ...state, updated_ms: nowFn() };
        await deps.writePlanTreeFile(run.cwd, "state.json", JSON.stringify(toLedger2(state)));
        return;
      }
      case "writePlanTreeFile": {
        await deps.writePlanTreeFile(run.cwd, eff.name, eff.contents);
        return;
      }
      case "deletePlanTreeFile": {
        // the refine branch's per-reset-node cleanup. Containment-guarded + allow-list-
        // validated Rust-side, so a name that is not an NN-plan.md / NN-summary.md / control file is
        // rejected before any unlink. Best-effort: a delete failure is logged but never throws — the
        // re-run still OVERWRITES the file, so a stale copy cannot survive even if the pre-delete missed.
        if (!deps.deletePlanTreeFile) {
          diag(`deletePlanTreeFile skipped (dep absent): ${eff.name}`);
          return;
        }
        try {
          await deps.deletePlanTreeFile(run.cwd, eff.name);
        } catch (err) {
          console.error(`delete_plan_tree_file failed (non-fatal): ${eff.name}`, err);
          diag(`deletePlanTreeFile failed (non-fatal): ${eff.name}: ${String(err)}`);
        }
        return;
      }
      case "resetPlanTreeDir": {
        // START reconciliation: sweep stale prior-run files into .plan-tree/.archive/ BEFORE the
        // genesis persist lands (effect ordering is the reducer's responsibility).
        await deps.resetPlanTreeDir(run.cwd);
        return;
      }
      case "resolvePermission": {
        // RESUMED-GATE SHORT-CIRCUIT: a synthetic `resumed:` id addresses a permission the
        // sidecar NO LONGER HOLDS (the live resolver died with the prior process). The resumed-gate
        // approve/requestChanges branches send an explicit continuation prompt instead of resolving
        // the gate — so when the reducer still emits a resolvePermission for the gate's id, drop it
        // rather than call a dead resolver. The allow-side policy invalidation + held-id clear are
        // preserved. Real ids never carry this prefix, so the NON-resumed path is untouched.
        // INVARIANT[at-most-one-pending-gate] (runtime-guard): a re-presented disk gate carries a synthetic `resumed:` id (the live resolver died with the prior process); this short-circuit drops its resolvePermission rather than calling the dead sidecar resolver.
        //   prevents: resolving a dead synthetic id against the sidecar
        if (eff.id.startsWith("resumed:")) {
          if (run.heldPermissionId === eff.id) run.heldPermissionId = null;
          if (eff.allow) run.assertedPolicy = null;
          return;
        }
        // CLARIFY_ANSWERED reshape: the reducer can only carry the answers (it nulls pendingClarify
        // before this effect runs). For a known clarify id, rebuild the SDK's expected
        // updatedInput:{questions, answers} from the driver-retained questions + the answers parsed
        // from the reducer's JSON message, and DROP the raw message.
        if (run.clarifyQuestions.has(eff.id)) {
          const questions = run.clarifyQuestions.get(eff.id)!;
          let answers: AskUserQuestionAnswers = {};
          if (eff.message) {
            try {
              const parsed = JSON.parse(eff.message) as { answers?: AskUserQuestionAnswers };
              answers = parsed.answers ?? {};
            } catch {
              answers = {};
            }
          }
          await deps.resolvePermission({
            id: eff.id,
            allow: eff.allow,
            updatedInput: { questions, answers },
          });
          run.clarifyQuestions.delete(eff.id);
          if (run.heldPermissionId === eff.id) run.heldPermissionId = null;
          return;
        }
        await deps.resolvePermission({ id: eff.id, allow: eff.allow, message: eff.message });
        // The held resolver is now resolved — no longer needs purging on cancel.
        if (run.heldPermissionId === eff.id) run.heldPermissionId = null;
        // A non-clarify allow resolution is an ExitPlanMode approval: the SDK exits plan mode
        // out-of-band, so the session mode is now UNKNOWN — the dispatch seam re-asserts the
        // derived policy right after this effect loop.
        if (eff.allow) run.assertedPolicy = null;
        return;
      }
      case "notifyAwaitingApproval": {
        // Remember the held ExitPlanMode id so cancel() can purge it. The UNIFIED gate: this fires
        // for decomposition gates (root included) AND leaf gates alike.
        run.heldPermissionId = eff.gate.toolUseId;
        for (const o of observers) o.onAwaitingApproval?.(eff.gate);
        return;
      }
      case "notifyPrototypeReview": {
        // Surface the held visual-prototype gate to the observers (the UI's review pane). NOTE:
        // unlike notifyAwaitingApproval there is NO heldPermissionId to remember — the gate is
        // signaled by TURN COMPLETION (the intent turn's result), not a held tool resolver, so
        // cancel() has nothing to purge for it.
        for (const o of observers) o.onPrototypeReview?.(eff.gate);
        return;
      }
      case "notifyAcceptanceReview": {
        // THE FORCED ACCEPTANCE GATE. The reducer parked the root in its acceptance window
        // (no notifyDone yet) and emitted this with a gate whose display fields it could not know
        // (cwd/openTarget/runCommand — driver concerns). AUGMENT the gate with the run's cwd + baseline
        // open target, then (a) PATCH it back into state.pendingAcceptance so the next emitted snapshot
        // carries it (the UI binds to the snapshot — self-clearing, like pendingPrototype), (b) fan it
        // to observers, and (c) best-effort OPEN the baseline. Like the prototype gate there is no
        // heldPermissionId — it resolves by an explicit user action, so cancel purges nothing.
        const openTarget = eff.gate.openTarget ?? "index.html";
        const augmented: AcceptanceGate = {
          ...eff.gate,
          cwd: run.cwd,
          openTarget,
          runCommand: eff.gate.runCommand,
        };
        if (state && state.pendingAcceptance) {
          state = { ...state, pendingAcceptance: augmented };
        }
        for (const o of observers) o.onAcceptanceReview?.(augmented);
        if (deps.openBaseline && openTarget !== null) {
          try {
            await deps.openBaseline(run.cwd, openTarget);
            diag(`notifyAcceptanceReview: opened baseline "${openTarget}"`);
          } catch (err) {
            console.error("open_baseline failed (non-fatal)", err);
            diag(`notifyAcceptanceReview: open_baseline failed (non-fatal): ${String(err)}`);
          }
        }
        return;
      }
      case "notifySummaryWritten": {
        for (const o of observers) o.onSummaryWritten?.(eff.path, eff.summaryPath);
        return;
      }
      case "notifyDone": {
        // NATURAL COMPLETION is terminal — and like cancel()/notifyFatal it must END the SDK session,
        // not merely flip `active` false. Leaving the session alive starves index.ts of the
        // `agent-exit` that drives applySessionState("none"): the controller stays stuck at "idle", so
        // "+ New plan" stays disabled and Send's none-branch resume seam never engages. Ending it emits
        // agent-exit → none, re-enabling New-plan and arming resume-on-Send. The resume target
        // (lastCwd/lastSessionId) is RETAINED across the end so a follow-up Send reopens the SAME
        // conversation. wasActive-guarded so a repeated notifyDone never re-ends (mirrors notifyFatal).
        const wasActive = active;
        markTerminal("notifyDone");
        if (wasActive) await endSdkSession();
        const snap = state ? toSnapshot2(state) : null;
        if (snap) for (const o of observers) o.onDone?.(snap);
        return;
      }
      case "notifyFatal": {
        // FATAL is terminal — and like cancel() it must END the SDK session, not merely flip `active`
        // false. A plain markTerminal() left the session (and its full conversation context, possibly
        // in a widened mode) ALIVE while isOrchestrationActive()===false — the Stop-routing desync
        // endSdkSession exists to prevent, where a later "new plan" bled context from the surviving
        // session. wasActive-guarded so a repeated FATAL never re-ends.
        const wasActive = active;
        markTerminal(`notifyFatal: ${eff.message}`);
        if (wasActive) await endSdkSession();
        for (const o of observers) o.onFatal?.(eff.message);
        return;
      }
      case "notifyQuotaPaused": {
        // the run paused with auto-resume budget remaining. Install the in-memory pause
        // capturing the in-flight turn (bridged via pendingQuotaCapture; idle if absent), then schedule
        // the wall-clock-aware resume timer. The observer/banner consumes onQuotaPaused.
        run.quotaPause = {
          resetAt: eff.resetAt,
          remaining: eff.remaining,
          source: eff.source,
          awaitingVariant: run.pendingQuotaCapture ?? { tag: "idle" },
          exhausted: false,
          priorExited: false,
          backstopAttempts: 0,
        };
        scheduleQuotaTimer();
        for (const o of observers) o.onQuotaPaused?.({ resetAt: eff.resetAt, remaining: eff.remaining, source: eff.source });
        return;
      }
      case "notifyQuotaExhausted": {
        // the run hit a quota wall but the auto-resume budget is spent (fail-closed at 0).
        // Install the pause as EXHAUSTED (no timer scheduled — Cancel is the only affordance) so the
        // synchronous quotaPaused() probe still reads true (the session stays "paused", not torn down)
        // and the wall-clock reset time is retained for the banner. Surface via onQuotaExhausted.
        run.quotaPause = {
          resetAt: eff.resetAt,
          remaining: 0,
          source: eff.source,
          awaitingVariant: run.pendingQuotaCapture ?? { tag: "idle" },
          exhausted: true,
          priorExited: false,
          backstopAttempts: 0,
        };
        clearQuotaTimer();
        for (const o of observers) o.onQuotaExhausted?.({ resetAt: eff.resetAt, source: eff.source });
        return;
      }
    }
    assertNever(eff);
  };

  // THE SINGLE FUNNEL. Every event flows through here: reduce2 -> apply new state -> run effects in
  // order -> emit the fresh snapshot. Effects run sequentially so persist-ordering is deterministic.
  // `opts.suppressNotifyPrototypeReview` drops ONLY the `notifyPrototypeReview` view effect for this
  // one transition — used by the combined apply-and-approve arc, where PROTOTYPE_READY is a purely
  // internal clarifying-intent → prototype-review hop (making the following PROTOTYPE_APPROVED legal).
  // State + the `persist` effect still run; only the user-facing review surface is suppressed.
  const dispatch = async (
    event: PlanTreeEvent2,
    opts?: { suppressNotifyPrototypeReview?: boolean },
  ): Promise<void> => {
    // START is the genesis event: it ignores prior state, so feed reduce2 a throwaway base if none.
    const base: PlanTreeState2 =
      state ??
      ({
        schema: 2,
        tree_id: "",
        created_ms: 0,
        updated_ms: 0,
        root: {
          nn: parseNn(1),
          title: "",
          redraftCount: 0,
          lastFeedback: null,
          state: { stage: "open", phase: "clarifying-intent" },
        },
        pendingApproval: null,
        pendingClarify: null,
        pendingAcceptance: null,
        parsedChildren: null,
      } as PlanTreeState2);
    const { state: next, effects } = reduce2(base, event);
    state = next;
    for (const eff of effects) {
      // SILENT auto-approve hop: skip the prototype-review VIEW notification (state + persist still
      // run). See the dispatch opts doc above.
      if (opts?.suppressNotifyPrototypeReview && eff.kind === "notifyPrototypeReview") continue;
      await runEffect(eff);
    }
    // DERIVED WRITE POLICY (the single mode seam): permission mode is a PURE function of the tree
    // (writePolicyFor2), asserted here after EVERY transition — never imperatively at scattered call
    // sites. When the derived policy differs from the last KNOWN session mode (null = unknown, e.g.
    // right after an ExitPlanMode approval flipped the SDK out of plan mode), correct it. This runs
    // BEFORE any subsequent sendMessage, so a planning turn can never start in a stale writable mode
    // (the post-decomposition-approval incident). Skipped once terminal — the session must not be poked.
    // INVARIANT[asserted-policy-is-a-pure-ledger-cache] (runtime-guard): session permission mode is a pure function of the ledger (writePolicyFor2); run.assertedPolicy is only a cache, re-asserted when it differs (null after an ExitPlanMode allow makes the live mode unknown).
    //   prevents: the session running in a stale write policy after an out-of-band plan-mode exit
    if (active) {
      const policy = writePolicyFor2(next.root);
      if (policy !== run.assertedPolicy) {
        await deps.setMode(policy);
        run.assertedPolicy = policy;
      }
      // DERIVED MODEL: asserted AFTER setMode to match the startSession open order (setMode then
      // setModel; both are idempotent caches). The live session's model
      // tracks the ACTIVE node's pipeline DOMAIN via effectiveModel (override-aware): Sonnet recon →
      // Opus sizing/decompose/draft → the leaf's scale-tiered coding model at leaf-execute. Re-asserted
      // whenever the effective model differs from the cache. When there is no active node (the
      // acceptance/terminal window ⇒ activePathOf null) the session stays on its last model — skip.
      // INVARIANT[asserted-model-is-a-pure-ledger-cache] (runtime-guard): the live session model is a pure function of the active node's (stage, phase) + override (effectiveModel); run.assertedModel is only a cache, re-asserted when it differs.
      //   prevents: a phase running on the wrong (stale) model after the active node advanced
      const ap = activePathOf(next.root);
      const activeNode = ap ? nodeAtPath(next.root, ap) : null;
      if (activeNode) {
        const m = effectiveModel(activeNode).model;
        if (m !== run.assertedModel) {
          await deps.setModel(m);
          run.assertedModel = m;
        }
      }
    }
    emitSnapshot(toSnapshot2(next));
  };

  const requireState = (): PlanTreeState2 => {
    if (!state) throw new Error("orchestrator not started");
    return state;
  };

  // does the ROOT ledger carry a frozen working-reference baseline? When true, the
  // master-draft prompt gains the OUTCOME-bar acceptance criterion (R4) and every sub-plan
  // draft/summary prompt gains the behavioral-envelope-test mandate (R5). When false all prompts stay
  // BYTE-IDENTICAL pre-Phase-4. baseline_ lives on the ROOT ledger only, so read it off `state`.
  const hasBaseline = (): boolean => Boolean(state?.baseline_);

  // How long a `{tag:"resuming"}` hold may sit without the in-flight turn's `result` before the
  // watchdog declares the run stuck. The hold is interrupt-bounded (the decomposition-approve branch
  // fires deps.interrupt right after arming, yielding the aborted result within seconds), so this is a
  // BACKSTOP against a lost/failed interrupt — short enough to fail loud, generous for a slow tool-abort.
  const RESUME_RESULT_TIMEOUT_MS = 30_000;

  // bound the fireResume "!priorExited" defer so a lost agent-
  // exit cannot hang a quota-paused run forever. The PRIMARY proceed path is notifyAgentExit() (the
  // listener forwards it the instant the prior sidecar exits). When the resume timer fires but the
  // exit has not landed, fireResume defers AND arms a backstop timer re-entering fireResume after
  // QUOTA_PRIOR_EXIT_BACKSTOP_MS. After QUOTA_PRIOR_EXIT_BACKSTOP_MAX arms the resume PROCEEDS anyway:
  // the Rust one-session-per-launch guard rejects + surfaces a fatal if the child is genuinely still
  // alive — better than a silent forever-hang. Testable via the same scheduleTimer seam.
  const QUOTA_PRIOR_EXIT_BACKSTOP_MS = 5_000;
  const QUOTA_PRIOR_EXIT_BACKSTOP_MAX = 6;

  // THE GENERALIZED TURN TIMEOUT for the `summary` and `parent-review`
  // awaiting variants (ONE constant for both). These are REAL generation turns, not interrupt-bounded
  // boundary waits, so the window is wider than RESUME_RESULT_TIMEOUT_MS — but still finite and LOUD:
  // their prompts forbid tools, yet that is prompt-only (the sidecar backstop auto-allows Task/
  // read-Bash), so an errant tool call could otherwise stall the turn silently forever.
  const TURN_RESULT_TIMEOUT_MS = 120_000;

  // THE INTENT-TURN TIMEOUT. The intent turn previously had NO watchdog
  // (a turn that never produced a result hung the run silently at clarifying-intent). Now that it can
  // BUILD prototypes (write artifacts, take screenshots) it is the longest planning turn, so it gets
  // the loud-FATAL treatment with a WIDER window than TURN_RESULT_TIMEOUT_MS (distinct ms so
  // timer-counting test pins tell the kinds apart). The window measures SILENCE, not total duration:
  // every stream frame proving the turn is alive RE-ARMS it (the liveness reset in ingestStreamImpl),
  // so a long prototype build that streams never trips it — only 300s of dead air does. PAUSED while
  // an AskUserQuestion is held inside the turn, re-armed when the clarify resolves (see the
  // AskUserQuestion ingest branch + answerClarify).
  const INTENT_RESULT_TIMEOUT_MS = 300_000;

  // Bind the injectable timer seam (tests inject fakes so they never sleep; the live app uses the
  // global timers via defaultDeps).
  const scheduleTimer =
    deps.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancelTimer =
    deps.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));

  // INVARIANT[one-turn-watchdog-slot] (runtime-guard): exactly one turn is in flight, so one shared watchdog handle (run.turnWatchdog); every arm site clears the prior first (clearTurnWatchdog).
  //   prevents: two live watchdog timers firing competing FATALs
  const clearTurnWatchdog = (): void => {
    if (run.turnWatchdog !== null) {
      cancelTimer(run.turnWatchdog);
      run.turnWatchdog = null;
    }
  };

  // arm the generalized turn watchdog for an awaited `summary` or
  // `parent-review` turn. No result within TURN_RESULT_TIMEOUT_MS ⇒ the loud-FATAL path (serialized
  // through enqueueIngest, like the resuming watchdog). The fire guard re-checks BOTH the tag and the
  // armed path so a fired-but-not-yet-run callback racing a fresh arm of the same tag can't FATAL the
  // wrong turn.
  const armTurnWatchdog = (label: "summary" | "parent-review" | "intent", forPath: NodePath): void => {
    clearTurnWatchdog();
    const armedKey = pathKey(forPath);
    const timeoutMs = label === "intent" ? INTENT_RESULT_TIMEOUT_MS : TURN_RESULT_TIMEOUT_MS;
    diag(`armTurnWatchdog: ${label} turn at "${armedKey}"; watchdog ${timeoutMs}ms`);
    run.turnWatchdog = scheduleTimer(() => {
      run.turnWatchdog = null;
      void enqueueIngest(async () => {
        if (!active || run.awaiting.tag !== label) return; // the result won the race (or terminal)
        const armed =
          run.awaiting.tag === "summary"
            ? run.awaiting.path
            : run.awaiting.tag === "parent-review"
              ? run.awaiting.parentPath
              : []; // the intent turn is the ROOT's genesis turn (no per-node path)
        if (pathKey(armed) !== armedKey) return; // a different turn of the same tag is in flight
        run.awaiting = { tag: "idle" };
        await dispatch({
          type: "FATAL",
          message:
            `turn watchdog: no turn result arrived within ${timeoutMs}ms for the ` +
            `${label} turn at "${armedKey}" — the turn is stuck`,
        });
      });
    }, timeoutMs);
  };

  // Arm the RESUMING hold: the next step (recon for `nextPath`) is DEFERRED until the in-flight
  // resumed turn's `result` arrives — sending it now would merge it into that turn (the no-gate
  // incident). The caller (approve()'s decomposition branch, the ONLY armer) interrupts the resumed
  // turn right after this returns, so the boundary result arrives within seconds; the watchdog backstops
  // a missing result into a loud terminal FATAL. The fire path runs through enqueueIngest (serialized
  // with live frames, inheriting the queue's error isolation).
  const armResuming = (nextPath: NodePath): void => {
    clearTurnWatchdog();
    run.awaiting = { tag: "resuming", nextPath };
    diag(
      `armResuming: deferred recon for "${pathKey(nextPath)}"; watchdog ${RESUME_RESULT_TIMEOUT_MS}ms`,
    );
    run.turnWatchdog = scheduleTimer(() => {
      run.turnWatchdog = null;
      void enqueueIngest(async () => {
        // The result won the race (or the run already concluded) — no fatal.
        if (!active || run.awaiting.tag !== "resuming") return;
        const stuckPath = run.awaiting.nextPath;
        run.awaiting = { tag: "idle" };
        await dispatch({
          type: "FATAL",
          message:
            `resume watchdog: no turn result arrived within ${RESUME_RESULT_TIMEOUT_MS}ms after ` +
            `decomposition approval (the interrupt boundary result is missing) — the deferred recon ` +
            `for sub-plan ${pathKey(stuckPath)} was never sent`,
        });
      });
    }, RESUME_RESULT_TIMEOUT_MS);
  };

  // the resume-context prompt re-issued when the quota refreshes. Builds the COMPLETE,
  // self-contained original turn prompt for the captured variant (the same closure context a
  // never-interrupted turn would have) and wraps it with QUOTA_RESUME_NOTE (re-emission contract: the
  // discarded partial means re-emit the whole artifact fresh, never continue the fragment). The pure
  // module-level builders are reused verbatim so the resumed turn's instructions are byte-identical —
  // only the note differs. idle/resuming fall back to QUOTA_RESUME_GENERIC.
  const quotaResumePrompt = (awaitingVariant: Awaiting, path: NodePath): string => {
    switch (awaitingVariant.tag) {
      case "intent":
        // The intent turn re-confirms the user's intent (visual clarifier). confirmedIntent is not
        // yet captured (the turn that produces it was interrupted), so re-issue the original ask.
        return quotaResumeWrap(intentPrompt(run.request));
      case "recon":
        // Root recon (path []) threads confirmedIntent; a sub-recon threads the node's mandate +
        // prior sibling summaries + any parent adjust note — exactly like the live/resume sends.
        return quotaResumeWrap(
          path.length === 0
            ? reconPrompt(run.request, run.confirmedIntent)
            : subReconPrompt(path, mandateFor(path), priorSummaries(parentPathOf(path)), adjustNoteFor(path)),
        );
      case "sizer":
        return quotaResumeWrap(sizerPrompt());
      case "exec":
        // The exec turn implements an already-approved plan; partial edits may already be on disk, so
        // the faithful complete re-issue is the AUDIT-AND-CONTINUE prompt (inspect the tree, finish the
        // remaining steps) keyed to this node's plan file — NOT a from-scratch restart.
        return quotaResumeWrap(resumedLeafContinuePrompt(planName2(path)));
      case "summary":
        return quotaResumeWrap(summaryPrompt(path, hasBaseline()));
      case "parent-review": {
        // Re-emit the parent's NO-TOOLS review turn: the reviewed child's summary + the FROZEN
        // remaining sibling mandates + the ADJUST/NONE protocol, as the live/resume send. The captured
        // variant carries both paths; remaining-sibling discovery (the still-PENDING children) reads
        // the live tree, already in-memory at resume time.
        const reviewedChild = awaitingVariant.reviewedChild;
        const parentPath = awaitingVariant.parentPath;
        const childSummary = run.summaries.get(pathKey(reviewedChild)) ?? "";
        const parentNode = state ? nodeAtPath(state.root, parentPath) : null;
        const remaining =
          parentNode && parentNode.state.stage === "split"
            ? parentNode.state.children
                .filter((c) => c.state.stage === "open" && c.state.phase === "pending")
                .map((c) => {
                  const sibPath: NodePath = [...parentPath, c.nn];
                  return { path: sibPath, mandate: mandateFor(sibPath) };
                })
            : [];
        return quotaResumeWrap(parentReviewPrompt(reviewedChild, childSummary, remaining));
      }
      case "idle":
      case "resuming":
      default:
        return QUOTA_RESUME_GENERIC;
    }
  };

  const clearQuotaTimer = (): void => {
    if (run.quotaTimer !== null) {
      cancelTimer(run.quotaTimer);
      run.quotaTimer = null;
    }
  };

  // Clear the entire in-memory pause (timer + state + the synchronous pending flag). Called on
  // resume (fireResume → QUOTA_RESUMED), cancel/teardown, and every terminal (markTerminal) — a
  // paused timer must never fire into a dead/resumed run, AND the synchronous pause-pending flag
  // must not survive the pause's resolution (else a later genuine exit would mis-classify as paused).
  const clearQuotaPause = (): void => {
    clearQuotaTimer();
    run.quotaPause = null;
    run.quotaPausePending = false;
  };

  // Schedule (or RE-schedule) the resume timer for the currently-armed pause. The delay is computed
  // from the WALL CLOCK at schedule time (max(0, resetAt - now)) so a re-schedule after an early
  // fire targets the true remaining delta. No-op when no (non-exhausted) pause is armed.
  const scheduleQuotaTimer = (): void => {
    if (!run.quotaPause || run.quotaPause.exhausted) return;
    // BELT-AND-SUSPENDERS (degraded-reset): never schedule a resume to a non-positive/non-finite
    // resetAt — that is the sentinel a degraded result-carrier quota carries, and a timer to epoch 0
    // would fire immediately back into the wall. The reducer already routes these to exhausted (no
    // timer); this is defense in depth in case a degraded pause is ever installed non-exhausted.
    if (!(run.quotaPause.resetAt > 0)) return;
    clearQuotaTimer();
    const delay = Math.max(0, run.quotaPause.resetAt - nowFn());
    diag(`scheduleQuotaTimer: resetAt=${run.quotaPause.resetAt} delay=${delay}ms remaining=${run.quotaPause.remaining}`);
    run.quotaTimer = scheduleTimer(() => {
      run.quotaTimer = null;
      void enqueueIngest(() => fireResume());
    }, delay);
  };

  // THE WALL-CLOCK-AWARE AUTO-RESUME. Runs serialized through enqueueIngest so it cannot interleave
  // with a live frame. Guards, in order:
  //   1. terminal / no-pause / exhausted → drop (a late timer into a dead or already-resumed run);
  //   2. budget remaining must be > 0 (defense in depth — exhausted pauses arm no timer);
  //   3. WALL-CLOCK re-check: if the timer fired EARLY (coalesced, or the page was occluded and the
  //      timer delivered short), now() < resetAt ⇒ NEVER resume early — re-schedule and return;
  //   4. PRIOR-EXIT guard: the prior (paused) sidecar must have exited (notifyAgentExit seen) before
  //      re-`startSession` — else the Rust one-session-per-launch guard rejects the respawn. When not
  //      yet seen, DEFER (priorExited false); notifyAgentExit() re-enters fireResume once it lands.
  //      (The sidecar gracefulExit(0)s right after quota_exceeded, so the exit reliably follows.)
  const fireResume = async (): Promise<void> => {
    if (!active || !run.quotaPause || run.quotaPause.exhausted) return;
    if (run.quotaPause.remaining <= 0) return;
    // BELT-AND-SUSPENDERS (degraded-reset): a non-positive/non-finite resetAt is the undeterminable
    // sentinel — treat as exhausted, never resume (a resume to epoch 0 lands straight back in the wall).
    if (!(run.quotaPause.resetAt > 0)) return;
    const nowMs = nowFn();
    if (nowMs < run.quotaPause.resetAt) {
      diag(`fireResume: early (now=${nowMs} < resetAt=${run.quotaPause.resetAt}) — re-scheduling`);
      scheduleQuotaTimer();
      return;
    }
    if (!run.quotaPause.priorExited) {
      // The prior sidecar has not exited yet. notifyAgentExit() is the PRIMARY path that proceeds this
      // resume the instant the exit lands. But a lost exit must not hang the run forever — arm a
      // BOUNDED backstop timer that re-enters fireResume. After the bounded arms, PROCEED anyway (fall
      // through): the Rust one-session guard rejects + surfaces a fatal if the child is still alive.
      if (run.quotaPause.backstopAttempts < QUOTA_PRIOR_EXIT_BACKSTOP_MAX) {
        run.quotaPause.backstopAttempts++;
        diag(
          `fireResume: prior session has not exited yet — deferring (backstop ${run.quotaPause.backstopAttempts}/${QUOTA_PRIOR_EXIT_BACKSTOP_MAX}); notifyAgentExit() or backstop will re-check`,
        );
        // Reuse the (now-fired, null) quotaTimer slot so clearQuotaPause/cancel/teardown clears it.
        clearQuotaTimer();
        run.quotaTimer = scheduleTimer(() => {
          run.quotaTimer = null;
          void enqueueIngest(() => fireResume());
        }, QUOTA_PRIOR_EXIT_BACKSTOP_MS);
        return;
      }
      diag(
        `fireResume: prior session STILL not exited after ${QUOTA_PRIOR_EXIT_BACKSTOP_MAX} backstop attempts — proceeding anyway (Rust one-session guard will reject + surface if the child is still alive)`,
      );
      // Fall through to the respawn — do NOT defer again.
    }
    const pause = run.quotaPause;
    // Re-open the session resuming the prior transcript — the SAME shape resume() uses. Resolving the
    // session id off `state` (the ledger's self-persisted sdk_session_id); a missing id ⇒ a fresh
    // session (the sidecar's expired-transcript fallback emits resume_fallback, tolerated below).
    const resumeSessionId = state?.sdk_session_id;
    const policy = state ? writePolicyFor2(state.root) : "plan";
    diag(`fireResume: resuming session (policy=${policy}, resumeSessionId=${resumeSessionId ?? "none"})`);
    // Clear the in-memory pause + timer BEFORE the awaitable respawn so a wake/exit racing this
    // resume cannot re-enter fireResume and double-start. The QUOTA_RESUMED dispatch (decrementing
    // the budget) lands after the prompt is re-issued.
    clearQuotaPause();
    // ARM-BEFORE-SEND: re-arm the captured awaiting variant so the resumed turn's `result` advances
    // the SAME sequencer step the wall interrupted (start() discipline). A captured `idle`/`resuming`
    // re-arms idle (nothing to advance; the generic continue prompt nudges the conversation forward).
    //
    // BUFFER-CONTRACT: RESET `buffer: ""` on the re-arm — matching EVERY other re-arm site
    // (fireResume was the lone exception). The interrupted turn's partial buffer is DISCARDED, so the
    // post-resume capture holds ONLY the fresh, complete re-emission (quotaResumePrompt instructs a
    // full re-emit). Carrying the stale partial would corrupt the downstream artifact (recon.md /
    // INTENT.md / summary).
    run.awaiting =
      pause.awaitingVariant.tag === "resuming" || pause.awaitingVariant.tag === "idle"
        ? { tag: "idle" }
        : { ...pause.awaitingVariant, buffer: "" };
    // RE-ARM THE TURN WATCHDOG for the watched generation tags. The resumed turn is a REAL generation
    // turn again, so a silently-stuck one must drive to a loud terminal FATAL as a never-paused turn
    // would — fireResume previously re-armed `awaiting` but NOT its watchdog, so a resumed summary /
    // parent-review / intent turn with no result hung the run forever. The watch path is computed PER
    // TAG, NOT from the generic capturedPath below: capturedPath resolves to [] for a parent-review
    // variant (it carries `parentPath`, not `path`), and armTurnWatchdog's fire guard compares against
    // awaiting.parentPath — so a root-keyed arm is INERT for a non-root parent-review. Map: summary →
    // .path, parent-review → .parentPath, intent → []. The other captured tags (recon/sizer/exec) carry
    // NO watchdog at their live arming sites by design, so the resume re-arms none for them either.
    // INVARIANT[watchdog-rearmed-per-tag-on-resume] (runtime-guard): on quota resume the watchdog is re-armed per awaited tag (summary→path, parent-review→parentPath, intent→[]).
    //   prevents: a silently-stuck resumed turn hanging the run with no terminal
    const rearmed = pause.awaitingVariant;
    if (rearmed.tag === "summary") armTurnWatchdog("summary", rearmed.path);
    else if (rearmed.tag === "parent-review") armTurnWatchdog("parent-review", rearmed.parentPath);
    else if (rearmed.tag === "intent") armTurnWatchdog("intent", []);
    const capturedPath =
      "path" in pause.awaitingVariant
        ? (pause.awaitingVariant.path as NodePath)
        : ([] as NodePath);
    // Re-open on the captured node's effective model (same node the resumed turn continues on). Null
    // node (torn/absent path) ⇒ omit execution, falling back to the global picker. Prime assertedModel
    // to this SAME value so the QUOTA_RESUMED dispatch's model seam fires no redundant setModel (null
    // captured node leaves the cache untouched-null, deferring to the seam).
    const capturedNode = state ? nodeAtPath(state.root, capturedPath) : null;
    run.assertedModel = capturedNode ? effectiveModel(capturedNode).model : null;
    await deps.startSession({
      cwd: run.cwd,
      permissionMode: policy,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
      ...(capturedNode ? { execution: effectiveModel(capturedNode) } : {}),
    });
    await deps.sendMessage(quotaResumePrompt(pause.awaitingVariant, capturedPath));
    await dispatch({ type: "QUOTA_RESUMED", nowMs: nowFn() });
    for (const o of observers) o.onQuotaResumed?.();
  };

  // Wire the wake seam ONCE per run (start/resume). On a wake (the page un-occluded), if a
  // non-exhausted pause is armed and the reset already passed during suspension, kick fireResume —
  // the in-page timer that should have fired may have been suspended. Routed through enqueueIngest so
  // it can't interleave with a live frame. fireResume's wall-clock re-check backstops a wake BEFORE
  // resetAt (re-schedules rather than resuming early). Idempotent: a second install tears down the prior.
  const installWakeSeam = (): void => {
    if (quotaWakeOff) {
      quotaWakeOff();
      quotaWakeOff = null;
    }
    if (!deps.onWake) return;
    quotaWakeOff = deps.onWake(() => {
      if (!active || !run.quotaPause || run.quotaPause.exhausted) return;
      diag("onWake: page visible; re-checking quota reset against wall clock");
      void enqueueIngest(() => fireResume());
    });
  };

  // THE SEQUENCER (see the `Awaiting` union above): the `result` branch acts ONLY when `awaiting` is
  // armed (non-idle), then re-arms exactly one successor (or `idle`, when the next signal is an
  // ExitPlanMode hold not a `result`). Each branch reads ITS OWN buffer/path — captured at ARM TIME —
  // so swallow / double-advance / cross-step buffer-merge are UNREPRESENTABLE. An armed variant is
  // always set BEFORE the matching `deps.sendMessage(...)` so a `result` delivered as that send
  // resolves (see start()) is never swallowed. Re-arm sites capture the active path at arm time; if
  // null there, we arm `{tag:"idle"}` rather than a variant with a bogus path.
  async function ingestStreamImpl(frame: AgentStream): Promise<void> {
    // TERMINAL GUARD (structural invariant): once the run is terminal (markTerminal flipped `active`
    // false), a frame already in the ingest queue must run NO effects. The queue still DEQUEUES and
    // INVOKES this thunk (error-isolation), but we early-return before any dispatch/sendMessage so a
    // same-tick trailing frame can't act on a dead run. ingestSeen++ records the queued work reached
    // this guard (the chain-not-poisoned falsifiability hook).
    ingestSeen++;
    diag(`ingestStreamImpl: kind=${frame.kind} active=${active} awaiting=${run.awaiting.tag}`);
    if (!active) {
      diag("ingestStreamImpl: SWALLOWED by !active guard (terminal)");
      return;
    }
    // INTENT-WATCHDOG LIVENESS RESET: the intent watchdog measures SILENCE, not total turn duration —
    // a long prototype build (clarifier writing HTML + screenshots, streaming throughout) must not
    // FATAL at 300s. Any frame proving the intent turn is alive re-arms the per-silence window. The
    // `turnWatchdog !== null` guard preserves the AskUserQuestion PAUSE: a held clarify cleared the
    // timer, and liveness frames during the hold must NOT re-arm it — answerClarify alone owns the
    // resume. The `result` frame is excluded: the intent branch below consumes it and disarms.
    if (
      run.awaiting.tag === "intent" &&
      run.turnWatchdog !== null &&
      (frame.kind === "assistant_text" ||
        frame.kind === "tool_use" ||
        frame.kind === "tool_result" ||
        frame.kind === "status" ||
        frame.kind === "subagent_started")
    ) {
      armTurnWatchdog("intent", []);
    }
    if (frame.kind === "system_init") {
      // RESUME-SUPPORT SESSION CAPTURE: the SDK announced this conversation's session_id. Capture it
      // driver-local immediately (so it survives even if the dispatch is a no-op), then self-persist it
      // via SESSION_INITIALIZED. NOT a sequencer boundary: it touches NO `awaiting` variant and runs
      // regardless of the armed tag (a pure idempotent ledger stamp). Returns here so the frame never
      // falls through to the `result`-only sequencer below.
      run.sdkSessionId = frame.session_id;
      diag(`system_init: captured sdk session_id=${run.sdkSessionId}`);
      if (frame.session_id && frame.session_id !== state?.sdk_session_id) {
        await dispatch({ type: "SESSION_INITIALIZED", sessionId: frame.session_id });
      }
      return;
    }
    if (frame.kind === "quota_exceeded") {
      // THE QUOTA WALL. A non-fatal quota_exceeded frame arrived (the sidecar detected
      // usage/rate-limit exhaustion and is gracefulExit(0)ing its child). PAUSE the run instead of
      // letting it die:
      //   • CAPTURE the in-flight turn (`awaiting`) so the resume re-arms the SAME sequencer step;
      //   • CLEAR the turn watchdog — the wait is unbounded (hours), so the silence-timer must not
      //     FATAL the paused run; the resumed turn re-arms its own watchdog;
      //   • DISARM `awaiting` to idle for the pause (no live turn; a stray result must be swallowed);
      //   • RESET priorExited tracking (the paused session has not exited yet);
      //   • DISPATCH QUOTA_PAUSED — the reducer routes to notifyQuotaPaused (budget remains) or
      //     notifyQuotaExhausted (fail-closed: no budget ⇒ remaining 0). The notify* handler installs
      //     the in-memory pause + schedules the timer (paused) or no timer (exhausted).
      // NOT terminal — `active` stays true through the pause.
      diag(`quota_exceeded: pausing run; resetAt=${frame.resetAt} source=${frame.source} awaiting=${run.awaiting.tag}`);
      const captured: Awaiting = run.awaiting;
      clearTurnWatchdog();
      run.awaiting = { tag: "idle" };
      run.pendingQuotaCapture = captured;
      await dispatch({ type: "QUOTA_PAUSED", resetAt: frame.resetAt, source: frame.source });
      run.pendingQuotaCapture = null;
      return;
    }
    if (frame.kind === "assistant_text") {
      // Append to the CURRENT variant's buffer only; drop while idle OR resuming (no cross-step
      // merge — resume-turn chatter must never leak into the deferred step's capture).
      if (run.awaiting.tag !== "idle" && run.awaiting.tag !== "resuming") {
        run.awaiting = { ...run.awaiting, buffer: run.awaiting.buffer + (run.awaiting.buffer ? "\n" : "") + frame.text };
      }
      return;
    }
    if (frame.kind !== "result") return;
    // Swallow rule: an unarmed (`idle`) `result` is no boundary. (A post-approval/advance resume
    // result is NOT idle anymore — it lands while `{tag:"resuming"}` holds the deferred next step,
    // and is consumed by the `resuming` branch below.)
    if (run.awaiting.tag === "idle") return;

    // SESSION-LIMIT LOOP-STOP GUARD. A genuine FAILED turn (`is_error`) in an ARMED step
    // must TERMINATE the run, never be consumed as a normal boundary that advances the next phase (the
    // infinite "You've hit your session limit…" loop). But the orchestrator DELIBERATELY produces
    // `is_error` results: post-decomposition-approval it interrupts the in-flight turn, which emits a
    // terminal `result` (subtype "error_during_execution", `deliberateInterrupt` stamped by index.ts)
    // the `resuming` branch consumes. So this guard EXCLUDES:
    //   • the `resuming` tag (the deliberate-interrupt boundary is consumed there);
    //   • `frame.deliberateInterrupt` (the host-side verdict index.ts stamped, persisted on the frame);
    //   • subtype "error_during_execution" (what an orchestrator interrupt always emits — a
    //     belt-and-suspenders second exclusion if the annotation is ever absent).
    // (`idle` is already excluded above.) Everything else with `is_error` is a genuine failure: disarm,
    // FATAL (full teardown via notifyFatal→endSdkSession), and return.
    if (
      frame.is_error &&
      run.awaiting.tag !== "resuming" &&
      !frame.deliberateInterrupt &&
      frame.subtype !== "error_during_execution"
    ) {
      diag(`result(is_error) in armed turn "${run.awaiting.tag}" — FATAL (no advance): ${frame.result}`);
      run.awaiting = { tag: "idle" };
      await dispatch({ type: "FATAL", message: frame.result ?? "Run failed" });
      return;
    }

    switch (run.awaiting.tag) {
      case "resuming": {
        // The in-flight decomposition-approval-resumed turn just ended — normally because approve()'s
        // decomposition branch interrupted it (the aborted `result`, subtype error_during_execution),
        // or voluntarily if it won the race. Either way THIS result is the boundary the deferred send
        // awaited — by construction it can belong to no other step. Consume the hold, disarm the
        // watchdog, and fire the deferred recon turn.
        const nextPath = run.awaiting.nextPath;
        clearTurnWatchdog();
        diag(`resuming branch: resume result consumed, firing deferred recon for "${pathKey(nextPath)}"`);
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
        // PER-LEVEL threading: the deferred first child sees ITS OWN level's completed siblings
        // (none yet, by construction — it is the first), never another level's. The first child of
        // a fresh decomposition has no pending adjust note either (adjustNoteFor is the scope guard).
        run.awaiting = { tag: "recon", path: nextPath, buffer: "" };
        await deps.sendMessage(
          subReconPrompt(
            nextPath,
            mandateFor(nextPath),
            priorSummaries(parentPathOf(nextPath)),
            adjustNoteFor(nextPath),
          ),
        );
        return;
      }
      case "intent": {
        // The GENESIS turn: the intent-clarifier confirmed the user's intent (and in visual mode may
        // have built a prototype). Parse the FINALIZE contract off the buffered final text:
        //   • a trailing ---PROTOTYPE--- block ⇒ open the prototype-review gate (PROTOTYPE_READY) and
        //     go IDLE — the gate resolves through approvePrototype()/refinePrototype() (turn completion
        //     signaled it; no tool held, nothing for cancel() to purge);
        //   • NO-PROTOTYPE / no block (incl. plain prose, where parsePrototypeBlock returns the buffer
        //     untouched) ⇒ the pre-feature path: INTENT_CLARIFIED (writes INTENT.md), send recon + arm.
        const buffered = run.awaiting.buffer;
        run.awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited intent result arrived — disarm its watchdog
        const parsed = parsePrototypeBlock(buffered);
        // Capture the confirmed intent for downstream prompt threading (recon + decomposition-
        // draft). A whitespace-only confirmation collapses to null so those prompts stay byte-
        // identical to their pre-feature form.
        run.confirmedIntent = parsed.intentText.trim() ? parsed.intentText.trim() : null;
        if (parsed.prototype !== null) {
          // ALWAYS capture THIS turn's intent text for downstream composition (never a stale prior
          // round's value) — both the interactive gate and the auto-approve arc compose from it.
          run.pendingIntentText = parsed.intentText;
          const gate: PrototypeGate = { ...parsed.prototype, round: run.prototypeRound + 1, cwd: run.cwd };
          if (run.autoApproveNext) {
            // COMBINED apply-and-approve: the user typed feedback AND clicked approve last round, so
            // the revised prototype is a DOWNSTREAM SPEC — do not surface another review round. The
            // root is in clarifying-intent (refinePrototype moved it there), so we CANNOT dispatch
            // PROTOTYPE_APPROVED directly (it requires prototype-review). Replicate the legal arc:
            // PROTOTYPE_READY moves clarifying-intent → prototype-review, THEN resolveApprove(gate)
            // composes INTENT.md from THIS turn's gate and dispatches PROTOTYPE_APPROVED → recon. Clear
            // the latch before resolving so a throw can't strand it. SUPPRESS the review VIEW
            // notification on this PROTOTYPE_READY (a purely internal hop) — surfacing it would flash
            // the review bar for one frame before resolveApprove approves, the round this action skips.
            diag(
              `intent branch (auto-approve): prototype block parsed (kind=${gate.kind}, round=${gate.round}) — silent PROTOTYPE_READY → resolveApprove`,
            );
            run.autoApproveNext = false;
            await dispatch({ type: "PROTOTYPE_READY", gate }, { suppressNotifyPrototypeReview: true });
            await resolveApprove(gate);
            return;
          }
          diag(
            `intent branch: trailing prototype block parsed (kind=${gate.kind}, round=${gate.round}) — dispatching PROTOTYPE_READY`,
          );
          await dispatch({ type: "PROTOTYPE_READY", gate });
          // awaiting stays idle: the next signal is a HANDLE METHOD (approve/refine), not a frame.
          return;
        }
        // NO BLOCK on an auto-approve round: the agent applied the feedback but emitted no prototype
        // block, so nothing to re-surface — fall through to the normal INTENT_CLARIFIED → recon path.
        // Clear the latch; do NOT route through PROTOTYPE_APPROVED (the root is in clarifying-intent,
        // where INTENT_CLARIFIED is the legal transition).
        if (run.autoApproveNext) {
          diag("intent branch (auto-approve): no prototype block — falling through to INTENT_CLARIFIED");
          run.autoApproveNext = false;
        }
        diag("intent branch: dispatching INTENT_CLARIFIED");
        await dispatch({ type: "INTENT_CLARIFIED", intent: parsed.intentText });
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
        run.awaiting = { tag: "recon", path: [], buffer: "" };
        diag("intent branch: armed recon, sending reconPrompt");
        await deps.sendMessage(reconPrompt(run.request, run.confirmedIntent));
        return;
      }
      case "recon": {
        // UNIFIED recon: the ROOT ([]) routes to the sizer; a child node routes to its draft turn
        // (gen-1's root-recon + sub-recon branches, keyed on path depth).
        const path = run.awaiting.path;
        const reconText = run.awaiting.buffer;
        run.awaiting = { tag: "idle" };
        if (path.length === 0) {
          // ROOT recon. DRIVER-WRITE BOUNDARY: gen-2 NODE_RECON_DONE carries no text and emits no
          // write effect — the driver physically writes recon.md FIRST (gen-1 ordering: recon.md
          // before the persist), then dispatches.
          diag("recon branch (root): writing recon.md + dispatching NODE_RECON_DONE");
          await deps.writePlanTreeFile(run.cwd, "recon.md", reconText);
          await dispatch({ type: "NODE_RECON_DONE", path });
          // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()).
          run.awaiting = { tag: "sizer", path: [], buffer: "" };
          await deps.sendMessage(sizerPrompt());
          return;
        }
        // NON-ROOT recon. No imperative setMode("plan")
        // here: the derived policy (writePolicyFor2, asserted at the dispatch seam) already
        // corrected the mode at the transition that ACTIVATED this node.
        await dispatch({ type: "NODE_RECON_DONE", path });
        const reconState = requireState();
        const reconNode = nodeAtPath(reconState.root, path);
        if (reconNode && reconNode.state.stage === "leaf") {
          // ROOT-COLLAPSE CHILD (the reducer forced leaf/drafting — it inherited the root sizer's
          // single verdict and skips the per-node sizer): draft directly, gen-1 golden behavior.
          // The next signal is the node's ExitPlanMode hold (not a `result`), so stay idle.
          await deps.sendMessage(
            subDraftPrompt(
              path,
              mandateFor(path),
              priorSummaries(parentPathOf(path)),
              adjustNoteFor(path),
              hasBaseline(),
            ),
          );
          return;
        }
        // EVERY OTHER non-root node runs the per-node sizer next (the prompt sequence
        // mirrors the root: recon → sizer). Arm BEFORE sending (see start()).
        run.awaiting = { tag: "sizer", path, buffer: "" };
        await deps.sendMessage(sizerPrompt());
        return;
      }
      // INVARIANT[sizer-two-outcome] (runtime-guard): the sizer decision is exactly single|split; an unparseable decision is coerced to split (loud) and the trailing assertNever(sizer.decision) guards totality.
      //   prevents: an ambiguous/garbled sizer output advancing into an undefined branch
      case "sizer": {
        // Scan buffered lines; take the LAST SIZER match (avoid a stray top-level echo).
        const path = run.awaiting.path;
        let sizer = null as ReturnType<typeof parseSizerDecision>;
        for (const line of run.awaiting.buffer.split(/\r?\n/)) {
          const parsed = parseSizerDecision(line);
          if (parsed) sizer = parsed;
        }
        const sizerBuffer = run.awaiting.buffer;
        run.awaiting = { tag: "idle" };
        if (!sizer) {
          // TWO-OUTCOME SIZER: the decision union is "single" | "split" — anything else (a stale
          // `escalate`, an unknown word, or no SIZER line) is COERCED to split, LOUDLY but not
          // fatally. Split is safe: the decomposition gate is the human checkpoint, so an uncertain
          // sizer must decompose, never end the run.
          diag(
            `sizer: no parseable single/split SIZER decision — COERCING to split. buffer head: ${JSON.stringify(sizerBuffer.slice(0, 200))}`,
          );
          sizer = { decision: "split", confidence: 0, num_plans: 0, scale: "standard" };
        }
        // EXHAUSTIVE dispatch over the sizer decision (each case returns; trailing assertNever makes a
        // missing case a compile error). The reducer enforces the confidence threshold; the driver
        // mirrors its branch so the RIGHT next prompt is sent for each outcome.
        // The decomposition-draft prompt for THIS node: the root drafts the MASTER plan from the
        // raw request; a non-root node drafts its own nested decomposition from its
        // mandate. Either way the next signal is the ExitPlanMode hold (not a `result`) — idle.
        const sendDecompositionDraft = async (): Promise<void> => {
          if (path.length === 0) {
            await deps.sendMessage(masterDraftPrompt(run.request, undefined, run.confirmedIntent, hasBaseline()));
          } else {
            await deps.sendMessage(
              nestedDecompositionDraftPrompt(
                path,
                mandateFor(path),
                priorSummaries(parentPathOf(path)),
                adjustNoteFor(path),
                hasBaseline(),
              ),
            );
          }
        };
        switch (sizer.decision) {
          case "single": {
            if (sizer.confidence >= 0.6) {
              await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
              if (path.length === 0) {
                // ROOT CONFIDENT single: the reducer collapsed the root to a single child 01 already
                // in recon. Drive that child's recon INLINE (gen-1 golden behavior — the sizer result
                // is the boundary; nothing in flight).
                const childPath = activePath();
                if (childPath !== null) {
                  // Arm BEFORE sending (the result may arrive as this sendMessage resolves).
                  run.awaiting = { tag: "recon", path: childPath, buffer: "" };
                  await deps.sendMessage(
                    subReconPrompt(
                      childPath,
                      mandateFor(childPath),
                      priorSummaries(parentPathOf(childPath)),
                      adjustNoteFor(childPath),
                    ),
                  );
                }
                return;
              }
              // NON-ROOT confident single: the node ITSELF became the leaf
              // (leaf/drafting). Send its draft prompt; the next signal is the leaf's ExitPlanMode
              // hold, so arm idle.
              await deps.sendMessage(
                subDraftPrompt(
                  path,
                  mandateFor(path),
                  priorSummaries(parentPathOf(path)),
                  adjustNoteFor(path),
                  hasBaseline(),
                ),
              );
              return;
            }
            // LOW-confidence single: the reducer routes it to `decomposing` (treated as a split).
            await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
            await sendDecompositionDraft();
            return;
          }
          case "split": {
            // SPLIT → decomposing, at ANY depth.
            await dispatch({ type: "SIZER_DONE", path, outcome: sizer });
            await sendDecompositionDraft();
            return;
          }
        }
        assertNever(sizer.decision);
      }
      // eslint-disable-next-line no-fallthrough -- unreachable: every sizer arm returns above.
      case "exec": {
        const path = run.awaiting.path;
        run.awaiting = { tag: "idle" };
        await dispatch({ type: "EXEC_DONE", path });
        // Arm BEFORE sending (the result may arrive as this sendMessage resolves — see start()). The
        // fresh `summary` variant gets buffer:"" — exec-phase chatter is dropped, not threaded.
        // every summary turn is watchdog-bounded (no result ⇒ loud FATAL, never a hang).
        run.awaiting = { tag: "summary", path, buffer: "" };
        armTurnWatchdog("summary", path);
        await deps.sendMessage(summaryPrompt(path, hasBaseline()));
        return;
      }
      case "summary": {
        const path = run.awaiting.path;
        const summaryText = run.awaiting.buffer;
        run.awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited summary result arrived — disarm its watchdog
        run.summaries.set(pathKey(path), summaryText);
        // DRIVER-SIDE WRITE: physically write summaryName2(path) FIRST and mint the brand from the
        // write's returned path — so SUMMARY_WRITTEN carries the FILE's path, never its text (the old
        // text-as-path bug, now uncompilable). The reducer then records the path, activates the next
        // sibling (or completes the root), and fires notifyDone when the last child summarizes.
        const summaryPath = await writePlanTreeFileMinted(summaryName2(path), summaryText);
        await dispatch({ type: "SUMMARY_WRITTEN", path, summaryText, summaryPath });
        if (state && !treeIsDone(state.root)) {
          // THE COMPLETION-ASCENT HOPS (all INLINE — see the audit note below). After a summary
          // lands, exactly one of three nodes is active:
          //   • the PARENT in `reviewing` (right-siblings remain) → send the parent-review prompt
          //     (the next sibling's recon fires ONLY from PARENT_REVIEW_DONE);
          //   • a NON-ROOT ANCESTOR in its ROLL-UP WINDOW (all children summarized) → send its roll-up
          //     summary prompt, fed its DIRECT children's summaries; its result re-enters THIS branch
          //     one level up, continuing the ascent;
          //   • nothing (done — handled above).
          // NO turn is in flight at ANY of these hops. The `result` just consumed IS the
          // summary turn's terminal frame — the SDK is parked awaiting the next user message, and the
          // summary prompt forbids tools, so no held ExitPlanMode could resume anything. The
          // decomposition-approval merge hazard does NOT apply; arming a `resuming` hold here would wait
          // for a result that can never arrive → a guaranteed watchdog FATAL (pinned per-hop by
          // orchestrator-depth2.test.ts). Decomposition approvals are the ONLY resuming-arming sites.
          // Arm BEFORE sending (see start()); if no node is active, stay idle rather than arm a bogus path.
          const nextPath = activePath();
          if (nextPath !== null) {
            const nextNode = nodeAtPath(state.root, nextPath);
            if (nextPath.length === 0 && state.pendingAcceptance) {
              // THE FORCED ACCEPTANCE GATE held. The reducer parked the ROOT in its
              // acceptance window instead of finalizing, and emitted notifyAcceptanceReview. The root
              // is NOT done yet there is NO turn to send — the user must record a verdict
              // (approveAcceptance / divergeAcceptance) before the deferred finalize runs. CRITICAL:
              // this guard MUST sit BEFORE the inRollupWindow branch — the root acceptance window is
              // structurally identical to a roll-up window (inRollupWindow(root) is true here), so
              // without it the driver would send a roll-up summary prompt for the root (which writes
              // no roll-up). Arm idle and wait for the verdict.
              run.awaiting = { tag: "idle" };
              diag("summary consume: root parked at the forced acceptance gate — awaiting verdict");
            } else if (nextNode && nextNode.state.stage === "split" && nextNode.state.phase === "reviewing") {
              // THE PARENT-REVIEW TURN: the reducer moved the parent to `reviewing` because
              // right-siblings remain. Send the no-tools review prompt — the just-written child summary
              // VERBATIM plus the remaining (pending) siblings' FROZEN mandates — and arm `parent-review`
              // + its watchdog. The next child's recon fires ONLY from PARENT_REVIEW_DONE.
              const remaining = nextNode.state.children
                .filter((c) => c.state.stage === "open" && c.state.phase === "pending")
                .map((c) => {
                  const sibPath: NodePath = [...nextPath, c.nn];
                  return { path: sibPath, mandate: mandateFor(sibPath) };
                });
              run.awaiting = { tag: "parent-review", parentPath: nextPath, reviewedChild: path, buffer: "" };
              armTurnWatchdog("parent-review", nextPath);
              await deps.sendMessage(parentReviewPrompt(path, summaryText, remaining));
            } else if (nextNode && inRollupWindow(nextNode)) {
              // ROLL-UP turn for the parent: its summary is awaited like any node summary — the
              // `summary` variant re-armed with the PARENT's path (watchdog-bounded).
              run.awaiting = { tag: "summary", path: nextPath, buffer: "" };
              armTurnWatchdog("summary", nextPath);
              await deps.sendMessage(rollupSummaryPrompt(nextPath, priorSummaries(nextPath)));
            } else {
              // IMPOSSIBLE STATE: a direct sibling recon hop no longer exists.
              // advanceAfterSummary produces exactly three post-summary shapes — parent `reviewing`
              // (intercepts EVERY non-final sibling activation), a non-root ancestor's roll-up
              // window, or done (handled above). The only arcs that mint open/recon are
              // INTENT_CLARIFIED, the sizer root-collapse, DECOMPOSITION_APPROVED, and
              // PARENT_REVIEW_DONE — none fire inside SUMMARY_WRITTEN. Reaching here means reducer and
              // driver have diverged: throw loudly rather than send an unauthorized recon prompt.
              throw new Error(
                `summary consume: active node "${pathKey(nextPath)}" is ${nextNode ? `${nextNode.state.stage}/${nextNode.state.phase}` : "missing"} after SUMMARY_WRITTEN — expected reviewing parent, roll-up window, or done (unreachable)`,
              );
            }
          }
        }
        // If done, the reducer already fired notifyDone — nothing to send. (notifyDone ENDS the SDK
        // session via endSdkSession, so index.ts receives agent-exit → "none", re-enabling New-plan and
        // arming resume-on-Send; the retained lastCwd/lastSessionId let a follow-up Send reopen it.)
        return;
      }
      case "parent-review": {
        // consume the review turn's result: parse ADJUST/NONE (last match wins; unparseable
        // COERCES to NONE loudly, never fatally), dispatch PARENT_REVIEW_DONE (activates the next
        // sibling's recon), stash the single pending note, then send the next child's recon INLINE —
        // the review result IS the boundary (nothing in flight; arming `resuming` would never resolve).
        const parentPath = run.awaiting.parentPath;
        const reviewBuffer = run.awaiting.buffer;
        run.awaiting = { tag: "idle" };
        clearTurnWatchdog(); // the awaited review result arrived — disarm its watchdog
        const parsed = parseParentReview(reviewBuffer);
        if (parsed === null) {
          diag(
            `parent-review: no parseable ADJUST/NONE line — COERCING to NONE. buffer head: ${JSON.stringify(reviewBuffer.slice(0, 200))}`,
          );
        }
        const note = parsed ? parsed.note : null;
        await dispatch({ type: "PARENT_REVIEW_DONE", path: parentPath, note });
        // THE SINGLE NOTE SLOT: set on ADJUST, NULLED on NONE/unparseable (a stale prior note can
        // never survive a NONE review). Scoped to this parent's children via parentKey.
        run.adjustNote = note !== null ? { parentKey: pathKey(parentPath), note } : null;
        diag(
          `parent-review: done for "${pathKey(parentPath)}" — ${note !== null ? `ADJUST note stashed (${JSON.stringify(note.slice(0, 120))})` : "NONE (no note)"}`,
        );
        const nextPath = activePath();
        if (nextPath !== null) {
          // Arm BEFORE sending (see start()). The note (if any) injects into THIS recon prompt —
          // and into the same child's draft prompt later — then clears at its DRAFTED dispatch.
          run.awaiting = { tag: "recon", path: nextPath, buffer: "" };
          await deps.sendMessage(
            subReconPrompt(
              nextPath,
              mandateFor(nextPath),
              priorSummaries(parentPathOf(nextPath)),
              adjustNoteFor(nextPath),
            ),
          );
        }
        return;
      }
    }
  }

  async function ingestPermissionImpl(req: ToolPermissionRequested): Promise<void> {
    // TERMINAL GUARD (structural invariant): see ingestStreamImpl. After the run is terminal a queued
    // permission frame (e.g. a same-tick trailing ExitPlanMode) must NOT dispatch NODE_DRAFTED /
    // notifyAwaitingApproval — that would surface an approval bar nothing ever resolves. ingestSeen++
    // records the queued work reached this guard (chain-not-poisoned hook).
    ingestSeen++;
    if (!active) return;
    if (req.tool === "ExitPlanMode") {
      const plan = (req.input as { plan?: string } | null)?.plan ?? "";
      // an ExitPlanMode is routed by the ACTIVE node's discriminated state, not a
      // master-phase string. open/decomposing (first draft) OR open/awaiting-decomposition-approval
      // ⇒ the DECOMPOSITION flow (the redraft-after-changes case re-enters at open/decomposing —
      // DECOMPOSITION_CHANGES_REQUESTED moves the node back there); leaf/drafting ⇒ the LEAF flow.
      const st = requireState();
      const path = activePath();
      const node = path !== null ? nodeAtPath(st.root, path) : null;
      if (path === null || node === null) return;
      // ROGUE ExitPlanMode DENY: an ExitPlanMode arriving while the active
      // node matches NO legal drafting branch — a summary turn, the roll-up window, a parent-review
      // window, or the EXEC window — must NOT be silently dropped (that strands the held resolver and
      // stalls the turn) NOR fall into the leaf-draft branch below (during execution that would write a
      // spurious duplicate plan and dispatch NODE_DRAFTED against a leaf/executing node — illegal, a
      // non-PlanValidationError that FATALs the run). Resolve it as a DENY with a corrective message so
      // the SDK feeds it back as the tool error and the turn finishes its work. LOUD diag either way.
      const inReviewWindow =
        run.awaiting.tag === "parent-review" ||
        (node.state.stage === "split" && node.state.phase === "reviewing");
      const inSummaryWindow =
        run.awaiting.tag === "summary" || (node.state.stage === "split" && inRollupWindow(node));
      // EXEC window is keyed on the ACTIVE NODE'S state (authoritative), NOT on `awaiting.tag ===
      // "exec"`: `awaiting` can lag the node state (a stale "exec" tag from a prior child), so routing
      // off the tag would wrongly DENY a legitimate next-child draft (leaf/drafting). The leaf-draft
      // branch below also routes purely on node state — this mirrors it.
      const inExecWindow = node.state.stage === "leaf" && node.state.phase === "executing";
      if (inReviewWindow || inSummaryWindow || inExecWindow) {
        // The corrective message names the work the turn is actually doing so the model resumes it
        // instead of re-drafting: the exec window tells it to keep implementing; review/summary tell
        // it to finish that turn's text.
        const message = inExecWindow
          ? "this turn must not call ExitPlanMode — finish implementing the approved plan"
          : `this turn must not call ExitPlanMode — finish the ${inReviewWindow ? "review" : "summary"} text`;
        const turnLabel = inExecWindow ? "exec" : inReviewWindow ? "review" : "summary";
        diag(
          `rogue ExitPlanMode DENIED: id=${req.id} during the ${turnLabel} window (node=${node.state.stage}/${node.state.phase}, awaiting=${run.awaiting.tag}) — this turn must not draft`,
        );
        await deps.resolvePermission({
          id: req.id,
          allow: false,
          message,
        });
        return;
      }
      if (
        node.state.stage === "open" &&
        (node.state.phase === "decomposing" || node.state.phase === "awaiting-decomposition-approval")
      ) {
        // The DECOMPOSITION plan (root: master; non-root: the node's own nested decomposition).
        // Parse + VALIDATE its sub-plan headers FIRST — BEFORE the live writeAgentPlan — then write the
        // plans-dir copy for sidebar nesting (root: flavor master, nn=null; non-root: flavor sub,
        // nn=the node's dotted PathKey), then land CHILDREN_PARSED + DECOMPOSITION_DRAFTED (the reducer
        // sets the unified gate + notifies).
        // VALIDATE-BEFORE-WRITE: a header-less draft, an out-of-1-99 header, or an empty
        // children list throws a PlanValidationError — RECOVERABLE, not a crash. We DENY the held
        // ExitPlanMode with the validation message (the requestChanges mechanism) so the model redrafts;
        // the run stays active, and the MALFORMED MASTER IS NEVER PERSISTED (writeAgentPlan runs only
        // after validation passes). The discriminator is TYPED (`instanceof PlanValidationError`); any
        // OTHER error propagates to the ingest queue's catch → FATAL. On success, capture each child's
        // Mandate (a re-draft replaces the whole map so stale sections never leak).
        let parsed: ParsedMasterPlan;
        try {
          parsed = parseSubPlanHeaders(plan);
        } catch (err) {
          if (err instanceof PlanValidationError) {
            diag(`master-write: decomposition rejected, denying for redraft — ${err.message}`);
            await deps.resolvePermission({ id: req.id, allow: false, message: err.message });
            return;
          }
          throw err;
        }
        // DIAG: log the decomposition-write decision so a live trace confirms the flavor keying
        // (nn=null ⇒ flavor:master; dotted nn ⇒ flavor:sub under the same tree_id). After validation.
        const decompNn = path.length === 0 ? null : pathKey(path);
        diag(
          `master-write: path=writeAgentPlan tree_id=${st.tree_id} nn=${decompNn ?? "null"} flavor=${decompNn === null ? "master" : "sub"} node=${node.state.stage}/${node.state.phase}`,
        );
        const masterPath = await deps.writeAgentPlan(plan, st.tree_id, decompNn, node.execution_model);
        diag(`master-write: wrote -> ${masterPath}`);
        // Child paths are minted as [...parentPath, parseNn(headerNn)] — the header NN is the PER-LEVEL
        // segment; the full dotted id derives from nesting. The mandate map stays keyed by full
        // PathKey: a (re-)draft REPLACES this node's descendant entries (so stale sections never leak)
        // while every OTHER level's mandates survive. At the root the filter degenerates to a full
        // replace (every key descends from "").
        const parentKey = pathKey(path);
        const childPrefix = parentKey === "" ? "" : `${parentKey}.`;
        run.mandates = new Map([
          ...[...run.mandates.entries()].filter(([k]) => !k.startsWith(childPrefix)),
          ...parsed.subplans.map(
            (s): [PathKey, Mandate] => [
              pathKey([...path, s.nn]),
              { title: s.title, sectionBody: s.body, masterPreamble: parsed.preamble },
            ],
          ),
        ]);
        await dispatch({
          type: "CHILDREN_PARSED",
          path,
          children: parsed.subplans.map((s) => ({ nn: s.nn, title: s.title })),
        });
        // DRIVER-WRITE BOUNDARY: the decomposition's .plan-tree copy is a driver write — "master.md"
        // at the root, the dotted "<pathKey>-plan.md" for a nested split (planName2). Written BETWEEN
        // the two dispatches to preserve the gen-1 wire order: writeAgentPlan → state.json (children) →
        // plan file → state.json (gate) → onAwaitingApproval.
        await deps.writePlanTreeFile(run.cwd, planName2(path), plan);
        // THE UNIFIED GATE: DECOMPOSITION_DRAFTED sets pendingApproval (kind "decomposition") and
        // emits notifyAwaitingApproval — the reducer owns the gate surface now (no driver-side
        // sentinel, no masterToolUseId).
        await dispatch({
          type: "DECOMPOSITION_DRAFTED",
          path,
          planPath: masterPath,
          plansDirPath: masterPath,
          toolUseId: req.id,
        });
        // ADJUST-NOTE CLEAR POINT (split child): this node's draft (its nested
        // decomposition) has landed; both prompt injections are behind us.
        clearAdjustNoteOnDraft(path);
        return;
      }
      if (node.state.stage === "leaf") {
        // A LEAF plan being drafted: SINGLE authoritative write here (learn the real path), then
        // dispatch NODE_DRAFTED carrying it (gen-2 events carry no plan text — this is THE write).
        // DIAG: log the leaf-write so a live trace confirms each node is written via nn=<pathKey> with
        // the SAME tree_id as the master (⇒ flavor:sub, nested under the master). One write per draft —
        // re-drafts overwrite, not duplicate. nn is the dotted PathKey STRING ("01", "02.01") — Rust
        // rejects a bare number.
        // ROOT-SINGLE EXCEPTION: the root single-collapse child is the ONLY plan its tree holds — no
        // master file is written (root.planPath stays null), so a dotted nn would mint an ORPHAN
        // flavor:sub the Rust arranger demotes to a standalone with its tree_id NULLED (and the sidebar
        // placeholder, matched by tree_id, never cedes to the real row). Write it nn=null: Rust stamps
        // the root-level flavor (a 0-child master renders as a flat row) and keeps its tree_id.
        // isRootCollapseChild is the canonical predicate — the sole child of a planPath-less root split
        // — so genuine sub-plans of split trees keep their dotted nn.
        const nnPath = isRootCollapseChild(st.root, path) ? null : pathKey(path);
        diag(
          `sub-write: path=writeAgentPlan tree_id=${st.tree_id} nn=${nnPath ?? "null"} flavor=${nnPath === null ? "master (root-single)" : "sub"} node=${node.state.stage}/${node.state.phase}`,
        );
        const realPath = await deps.writeAgentPlan(plan, st.tree_id, nnPath, node.execution_model);
        diag(`sub-write: wrote -> ${realPath}`);
        await dispatch({
          type: "NODE_DRAFTED",
          path,
          toolUseId: req.id,
          planPath: realPath,
          plansDirPath: realPath,
        });
        // ADJUST-NOTE CLEAR POINT (leaf child): the note was injected into this child's
        // recon AND draft prompts; its DRAFTED dispatch ends the note's one-sibling scope.
        clearAdjustNoteOnDraft(path);
        return;
      }
      // Any other node state (open/recon, open/sizing, …): an ExitPlanMode here is not a draft
      // boundary the machine recognizes — ignore it (gen-1 behavior for an unpointed sub).
      return;
    }
    if (req.tool === "AskUserQuestion") {
      const questions = (req.input as AskUserQuestionInput).questions;
      run.clarifyQuestions.set(req.id, questions);
      // INTENT-WATCHDOG PAUSE: a held AskUserQuestion inside the intent turn waits on the USER —
      // arbitrarily long, legitimately. The intent watchdog must not FATAL a healthy run parked on
      // a clarify gate; it re-arms when answerClarify resolves the hold.
      if (run.awaiting.tag === "intent") clearTurnWatchdog();
      await dispatch({ type: "CLARIFY_REQUESTED", toolUseId: req.id, questions });
      return;
    }
  }

  // The ledger captures every node's stage×phase, but the DRIVER also holds state nothing on disk
  // describes: the prior-sibling `summaries` text and the per-child `mandates` (parsed from each
  // split's decomposition plan). resume() reloads BOTH from disk so a resumed run threads the same
  // context a never-killed run would. Without it, multi-sibling resume is silently context-stripped.

  // Walk the tree and reload `summaries` + `mandates` from disk. Clears both maps first (a resume must
  // not inherit a previous run's leftovers — resume() guarantees no run was active, but defense in
  // depth). Skips entirely when no readPlanTreeFile dep is wired (older fakes) — the resumed run then
  // threads no prior context (degraded, not broken).
  const reloadDriverStateFromDisk = async (root: TreeNode): Promise<void> => {
    run.summaries.clear();
    run.mandates = new Map();
    const read = deps.readPlanTreeFile;
    if (!read) return;
    // Depth-first walk minting each node's NodePath. For EVERY node whose state carries a non-null
    // summaryPath, read summaryName2(path) into summaries[pathKey]. For EVERY split node with a
    // non-null decomposition plan (planPath), read planName2(path) and parse its sub-plan headers
    // into mandates keyed EXACTLY as the live ingestPermission decomposition path keys them
    // (pathKey([...path, childNn]) -> {title, sectionBody, masterPreamble}).
    const visit = async (node: TreeNode, path: NodePath): Promise<void> => {
      // SUMMARIES: a summarized node (leaf or split) recorded its summary file at summaryName2(path).
      // The root never writes a summary file (summaryName2 throws on []), and a summarized split's
      // own roll-up file IS summaryName2(path) — so guard out the root explicitly.
      if (
        path.length > 0 &&
        node.state.stage !== "open" &&
        node.state.summaryPath !== null
      ) {
        const text = await read(run.cwd, summaryName2(path));
        if (text !== null) run.summaries.set(pathKey(path), text);
      }
      // MANDATES: a split node that actually drafted a decomposition (planPath non-null) records its
      // children's mandates from that plan file. A planPath-less split is the root confident-single
      // collapse (no decomposition plan exists) — nothing to parse.
      if (node.state.stage === "split" && node.state.planPath !== null) {
        const plan = await read(run.cwd, planName2(path));
        if (plan !== null) {
          // BEST-EFFORT reload (degraded, not broken). A malformed on-disk decomposition (a
          // PlanValidationError) must NOT abort the whole resume — it just means this subtree's
          // mandates can't be reloaded (same degraded outcome as a missing plan file). The
          // resumed-APPROVE re-parse keeps its own throw — there a malformed master is a genuine
          // redraft signal handled upstream.
          try {
            const parsed = parseSubPlanHeaders(plan);
            for (const s of parsed.subplans) {
              run.mandates.set(pathKey([...path, s.nn]), {
                title: s.title,
                sectionBody: s.body,
                masterPreamble: parsed.preamble,
              });
            }
          } catch (err) {
            if (!(err instanceof PlanValidationError)) throw err;
            diag(
              `resume reload: decomposition plan ${planName2(path)} failed validation (skipping mandate reload, degraded): ${err.message}`,
            );
          }
        }
      }
      if (node.state.stage === "split") {
        for (const child of node.state.children) {
          await visit(child, [...path, child.nn]);
        }
      }
    };
    await visit(root, []);
  };

  // The synthetic toolUseId a resumed gate carries (its live permission id died with the prior
  // process). Prefixed `resumed:` so a stray live-id match is impossible.
  const resumedToolUseId = (path: NodePath): string => `resumed:${pathKey(path)}`;

  // Continue from the resolved ResumePlan. Mirrors the live phase boundaries:
  //   - "gate": re-present the held approval gate PURELY from disk (no tokens). Build an in-memory
  //     ApprovalGate2 from the on-disk artifact, set state.pendingApproval directly (NOT via the
  //     reducer — there is no DRAFTED event to replay), set heldPermissionId to the synthetic id,
  //     mark resumedGate, fire onAwaitingApproval + emit a snapshot. Send NO prompt.
  //   - "resend": ARM the matching `awaiting` variant (arm-before-send) then re-send that step's
  //     existing prompt. Prior summaries thread in via priorSummaries(path) (reloaded above).
  const resumeActionForPhase = async (plan: ResumePlan): Promise<void> => {
    if (plan.kind === "gate") {
      // Resolve the artifact the user reviews. LEAF: planPath/plansDirPath are real paths off the
      // node. DECOMPOSITION: planPath is a FILENAME relative to .plan-tree/ ("master.md" or
      // "<pathKey>-plan.md"; plansDirPath null) — resolve it under <cwd>/.plan-tree/. The live
      // decomposition write used the SAME path for both, so mirror that.
      const planPath =
        plan.gateKind === "decomposition" ? `${run.cwd}/.plan-tree/${plan.planPath}` : plan.planPath;
      const plansDirPath = plan.plansDirPath ?? planPath;
      // PHASE-ONLY RE-ARM. recoveryFor returns the SAME decomposition gate ResumePlan for BOTH
      // `open/decomposing` (a draft that survived but whose DRAFTED gate event died) and
      // `open/awaiting-decomposition-approval` (the gate already armed at kill). Only the FORMER needs
      // a phase fix: left at `decomposing`, a later Approve dispatches DECOMPOSITION_APPROVED whose
      // guard requires `awaiting-decomposition-approval` → THROW → FATAL (the dead-end this fixes).
      // Dispatch GATE_RE_PRESENTED — keyed on the REHYDRATED node being `open/decomposing` with a
      // decomposition gate — to advance ONLY the phase (no persist, no notify). The already-armed
      // `awaiting-decomposition-approval` case skips this (the guard rejects it) and is unchanged.
      if (state && plan.gateKind === "decomposition") {
        const reNode = nodeAtPath(state.root, plan.path);
        if (reNode && reNode.state.stage === "open" && reNode.state.phase === "decomposing") {
          await dispatch({ type: "GATE_RE_PRESENTED", path: plan.path });
        }
      }
      const gate: ApprovalGate2 = {
        path: plan.path,
        kind: plan.gateKind,
        toolUseId: resumedToolUseId(plan.path),
        planPath,
        plansDirPath,
        redraftCount: plan.redraftCount,
      };
      if (state) state.pendingApproval = gate;
      run.heldPermissionId = gate.toolUseId;
      run.resumedGate = true;
      run.awaiting = { tag: "idle" };
      diag(
        `resume: re-presenting ${gate.kind} gate at "${pathKey(gate.path)}" from disk (planPath=${planPath}, synthetic id=${gate.toolUseId})`,
      );
      for (const o of observers) o.onAwaitingApproval?.(gate);
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    if (plan.kind === "acceptance") {
      // RE-MINT THE FORCED ACCEPTANCE GATE on resume. The root is parked in its acceptance
      // window (all children summarized, baseline frozen, no verdict) — the build is COMPLETE, only the
      // human verdict is missing. NO model turn to re-send; just re-arm the transient gate as the live
      // notifyAcceptanceReview path does so the acceptance bar re-appears. After this,
      // approveAcceptance()/divergeAcceptance() drive the deferred finalize to done.
      //
      // The gate is re-derived (NOT persisted): cwd is the resume cwd; openTarget defaults to
      // "index.html"; runCommand is unknown on resume (never serialized). round is 1.
      const gate: AcceptanceGate = {
        cwd: run.cwd,
        openTarget: "index.html",
        runCommand: null,
        round: 1,
      };
      if (state) state.pendingAcceptance = gate;
      run.awaiting = { tag: "idle" }; // no turn in flight — the gate waits on a human verdict.
      diag(`resume: re-minting the forced acceptance gate (cwd=${run.cwd}, openTarget=${gate.openTarget})`);
      for (const o of observers) o.onAcceptanceReview?.(gate);
      // Best-effort OPEN the baseline so the user can exercise the just-built result against it — the
      // same non-fatal best-effort the live notifyAcceptanceReview effect performs.
      if (deps.openBaseline && gate.openTarget !== null) {
        try {
          await deps.openBaseline(run.cwd, gate.openTarget);
          diag(`resume acceptance: opened baseline "${gate.openTarget}"`);
        } catch (err) {
          console.error("open_baseline failed (non-fatal)", err);
          diag(`resume acceptance: open_baseline failed (non-fatal): ${String(err)}`);
        }
      }
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    // `restart` / `prototype-gate` / `rewind`. The pure scope layer
    // (resumeScopeForRoot) now surfaces these as resumable verdicts; this is their DRIVER continuation.
    // (`leaf/executing` is NOT here — Phase 3 owns the duplicate-write recovery; its rewind stays
    // non-offerable, so it never reaches resumeActionForPhase as a resumable.)
    if (plan.kind === "restart") {
      // RE-ENTER THE GENESIS CLARIFY STEP. The rehydrated root is open/clarifying-intent; the session
      // was opened above in the DERIVED "prototype" policy (so the prototype-write containment hook is
      // installed — same as a fresh start()). Replay the fresh-start clarify SEND: pre-create the
      // prototype dir, ARM `intent` BEFORE the send (arm-before-send), arm the intent watchdog, and
      // re-send intentPrompt SEEDED FROM THE ROOT TITLE (`request`). The next clarifier turn is handled
      // by the SAME `case "intent"` consume branch a fresh run uses.
      await deps.ensurePrototypeDir?.(run.cwd);
      run.awaiting = { tag: "intent", buffer: "" };
      armTurnWatchdog("intent", []);
      diag(`resume: re-entering genesis clarify (restart from "${plan.from}"), sending intentPrompt seeded from title`);
      await deps.sendMessage(intentPrompt(run.request));
      return;
    }
    if (plan.kind === "prototype-gate") {
      // RE-PRESENT THE PROTOTYPE REVIEW GATE FROM DISK. The rehydrated root is open/prototype-review;
      // the session was opened above in the DERIVED "prototype" policy, so the PreToolUse containment
      // hook (sidecar/permissions.ts) is ACTIVE — a resumed prototype-review session's writes stay
      // confined under <cwd>/.plan-tree/prototype/. (Installed purely by startSession's
      // `permissionMode: "prototype"`.)
      //
      // The transient PrototypeGate died with the prior process (never serialized), so RECONSTRUCT a
      // minimal gate from durable on-disk artifacts: the prototype dir is <cwd>/.plan-tree/prototype/
      // and its primary visual is index.html. round is prototypeRound+1 (=1 — resume reset it to 0).
      // INTENT.md does not exist yet at prototype-review (PROTOTYPE_APPROVED writes it), so
      // pendingIntentText stays null; the user re-approves or refines. Set pendingPrototype directly
      // (NOT via the reducer — the root is ALREADY prototype-review), fire onPrototypeReview, emit a
      // snapshot. Send NO prompt — the gate resolves through approvePrototype()/refinePrototype().
      const protoDir = `${run.cwd}/.plan-tree/prototype`;
      const gate: PrototypeGate = {
        kind: "html",
        paths: [`${protoDir}/index.html`],
        screenshot: null,
        inlinePreview: null,
        variants: [],
        round: run.prototypeRound + 1,
        cwd: run.cwd,
      };
      if (state) state.pendingPrototype = gate;
      run.awaiting = { tag: "idle" };
      diag(`resume: re-presenting prototype-review gate from disk (dir=${protoDir}, round=${gate.round})`);
      for (const o of observers) o.onPrototypeReview?.(gate);
      if (state) emitSnapshot(toSnapshot2(state));
      return;
    }
    // REWIND — re-present the NEAREST DURABLE GATE rather than discard the run.
    if (plan.kind === "rewind") {
      if (plan.toGate === "decomposition") {
        // THE THROWING-GATE PATH, NOW UNREACHABLE-BY-CONSTRUCTION. A `decomposition` rewind would
        // re-present a node's decomposition approval gate — coherent ONLY for a node still at
        // open/awaiting-decomposition-approval, but recoveryFor no longer emits an OFFERABLE
        // decomposition rewind for ANY phase (the rollup / between-children-review cases now `resend`
        // instead). If one ever reaches here the node is already split, so approving would dispatch
        // CHILDREN_PARSED / DECOMPOSITION_APPROVED against a non-open node and THROW — a wedged Resume.
        // Refuse loudly up front rather than re-present a gate that dead-ends on click. Retained as a
        // guard, not a live path.
        const node = nodeAtPath(state!.root, plan.path);
        const reason =
          `resume: refusing to re-present a decomposition gate at "${pathKey(plan.path)}" — the node is ` +
          `${node ? `${node.state.stage}/${node.state.phase}` : "missing"}, not ` +
          `open/awaiting-decomposition-approval (approving it would dead-end). Start a new plan.`;
        diag(reason);
        run.awaiting = { tag: "idle" };
        await dispatch({ type: "FATAL", message: reason });
        return;
      }
      // THE EXECUTING-CONTINUE PATH. A leaf/executing rewind differs from a torn
      // leaf-approval gate: the plan is ALREADY approved and the node is ALREADY at leaf/executing —
      // re-presenting its APPROVAL gate would (on approve) send resumedLeafApprovalPrompt, RESTARTING
      // implementation from scratch and re-applying on-disk edits (violates I3). Instead re-ENTER
      // execution directly with the AUDIT-AND-CONTINUE prompt: the node is ALREADY leaf/executing, so
      // we DON'T dispatch APPROVE (illegal against a non-gate node) — just ARM `exec` (arm-before-send;
      // the next result's EXEC_DONE is legal against leaf/executing) and send resumedLeafContinuePrompt
      // so the model inspects the tree and finishes the remaining steps. Detected from the NODE's state
      // at `path`. The banner gates REACHING here behind the partial-apply confirm (P3c).
      const rewindNode = nodeAtPath(state!.root, plan.path);
      if (
        plan.planPath !== null &&
        rewindNode?.state.stage === "leaf" &&
        rewindNode.state.phase === "executing"
      ) {
        // BEST-EFFORT durable-plan check: a LEAF plan lives in the PLANS STORE at its absolute
        // `~/.claude/plans/...` planPath (leaves never write `.plan-tree/` plans; only splits do).
        // Verify it through the PLANS channel by that absolute path — NOT readPlanTreeFile(cwd,
        // planName2(path)), which targets `.plan-tree/<NN-plan.md>` (a file a leaf NEVER writes; the
        // allow-list also rejects an absolute name), so it would ALWAYS read null and FATAL every real
        // executing-continue. If the plan is genuinely gone (the Rust command REJECTS) degrade SAFELY to
        // a clear terminal rather than tell the model to "continue" a plan it cannot read. Skipped when
        // the read dep is absent — then we proceed on the node's planPath, as the gate path does.
        if (deps.readPlanContents) {
          let missing = false;
          try {
            // read_plan_contents resolves the text or REJECTS — a throw means absent/out-of-bounds.
            await deps.readPlanContents(plan.planPath);
          } catch {
            missing = true;
          }
          if (missing) {
            const reason =
              `resume: cannot continue executing leaf at "${pathKey(plan.path)}" — its approved plan ` +
              `(${plan.planPath}) is gone from disk` +
              (plan.hazard ? ` (${plan.hazard})` : "") +
              ". Start a new plan.";
            diag(reason);
            run.awaiting = { tag: "idle" };
            await dispatch({ type: "FATAL", message: reason });
            return;
          }
        }
        // ARM BEFORE SEND (the continue turn's result may land as sendMessage resolves — start()
        // discipline). The node STAYS leaf/executing (no APPROVE); EXEC_DONE on the next result then
        // advances it to summary exactly as a normal execution completion does.
        run.awaiting = { tag: "exec", path: plan.path, buffer: "" };
        diag(
          `resume: CONTINUING leaf/executing at "${pathKey(plan.path)}" (audit-and-continue, planPath=${plan.planPath}) — armed exec, NOT re-presenting the approval gate`,
        );
        await deps.sendMessage(resumedLeafContinuePrompt(plan.planPath));
        return;
      }
      // toGate "leaf-approval" / "leaf" — a torn/degenerate leaf checkpoint. When the leaf plan
      // artifact survived (planPath non-null) re-present its approval gate; when it is gone (planPath
      // null — a torn ledger or the no-active-node rewind) there is NOTHING durable to re-present, so
      // surface a SAFE TERMINAL (mark terminal + a clear FATAL) rather than crash — I1 at runtime.
      if (plan.planPath !== null) {
        const gate: ApprovalGate2 = {
          path: plan.path,
          kind: "leaf",
          toolUseId: resumedToolUseId(plan.path),
          planPath: plan.planPath,
          plansDirPath: plan.planPath,
          redraftCount: nodeAtPath(state!.root, plan.path)?.redraftCount ?? 0,
        };
        if (state) state.pendingApproval = gate;
        run.heldPermissionId = gate.toolUseId;
        run.resumedGate = true;
        run.awaiting = { tag: "idle" };
        diag(`resume: rewinding to leaf-approval gate at "${pathKey(plan.path)}" from disk (planPath=${plan.planPath})`);
        for (const o of observers) o.onAwaitingApproval?.(gate);
        if (state) emitSnapshot(toSnapshot2(state));
        return;
      }
      // NO durable plan artifact — there is nothing to re-present. Surface a clear terminal message
      // (the hazard names what made the node unrecoverable) and END the run cleanly via the FATAL
      // path (markTerminal + endSdkSession + onFatal), instead of throwing into the resume catch.
      const reason =
        `resume: cannot rewind to a leaf gate at "${pathKey(plan.path)}" — its plan artifact is gone` +
        (plan.hazard ? ` (${plan.hazard})` : "") +
        ". Start a new plan.";
      diag(reason);
      run.awaiting = { tag: "idle" };
      await dispatch({ type: "FATAL", message: reason });
      return;
    }
    // RESEND: arm the matching variant BEFORE sending its prompt (the result may arrive as the send
    // resolves — same discipline as start()). confirmedIntent is null on resume (the genesis turn's
    // capture is gone); that is acceptable — the recon prompt simply omits the intent block.
    const path = plan.path;
    switch (plan.awaiting) {
      case "recon": {
        run.awaiting = { tag: "recon", path, buffer: "" };
        const prompt =
          path.length === 0
            ? reconPrompt(run.request, run.confirmedIntent)
            : subReconPrompt(path, mandateFor(path), priorSummaries(parentPathOf(path)), adjustNoteFor(path));
        diag(`resume: re-sending recon prompt for "${pathKey(path)}"`);
        await deps.sendMessage(prompt);
        return;
      }
      case "sizer": {
        run.awaiting = { tag: "sizer", path, buffer: "" };
        diag(`resume: re-sending sizer prompt for "${pathKey(path)}"`);
        await deps.sendMessage(sizerPrompt());
        return;
      }
      case "draft": {
        // A "draft" resend is ONLY ever a leaf/drafting node. A leaf is always drafted via
        // subDraftPrompt — even the root single-collapse child. masterDraftPrompt is the DECOMPOSITION
        // draft (a "gate" phase here, never "draft"), so subDraftPrompt is the faithful re-send. The
        // next signal is the node's ExitPlanMode hold (not a `result`), so stay idle.
        run.awaiting = { tag: "idle" };
        diag(`resume: re-sending leaf draft prompt for "${pathKey(path)}"`);
        await deps.sendMessage(
          subDraftPrompt(
            path,
            mandateFor(path),
            priorSummaries(parentPathOf(path)),
            adjustNoteFor(path),
            hasBaseline(),
          ),
        );
        return;
      }
      case "decompose": {
        // `open/decomposing` with NO decomposition artifact on disk (the disk probe said ABSENT): the
        // draft was never produced, so RE-SEND the decompose turn fresh — the faithful mirror of the
        // live SIZER_DONE→sendDecompositionDraft step (root re-drafts its MASTER plan; a nested split
        // re-drafts its own decomposition). We do NOT re-dispatch SIZER_DONE — the node is ALREADY at
        // open/decomposing (the sizer's verdict is durable), so re-sizing would double-size. The
        // non-serialized state was already reloaded by resume()'s reloadDriverStateFromDisk, so
        // mandateFor/priorSummaries thread the same context a never-killed run would. The next signal
        // is the node's ExitPlanMode hold, NOT a `result` — so arm idle, as the live decompose step does.
        run.awaiting = { tag: "idle" };
        diag(`resume: re-sending decompose draft prompt for "${pathKey(path)}"`);
        if (path.length === 0) {
          await deps.sendMessage(masterDraftPrompt(run.request, undefined, run.confirmedIntent, hasBaseline()));
        } else {
          await deps.sendMessage(
            nestedDecompositionDraftPrompt(
              path,
              mandateFor(path),
              priorSummaries(parentPathOf(path)),
              adjustNoteFor(path),
              hasBaseline(),
            ),
          );
        }
        return;
      }
      case "rollup": {
        // RE-RUN THE IN-FLIGHT ROLL-UP SUMMARY TURN. The active node is a NON-ROOT split in
        // its roll-up window (all children summarized). The decomposition is already approved+durable;
        // the only lost work is the un-landed roll-up summary turn. reloadDriverStateFromDisk reloaded
        // the DIRECT children's summaries, so priorSummaries(path) feeds rollupSummaryPrompt as the live
        // ascent does. Arm `summary` (arm-before-send) + its watchdog; the result re-enters the `summary`
        // consume branch, which OVERWRITES summaryName2(path) and dispatches SUMMARY_WRITTEN{path} to
        // complete the split and continue the ascent. NO decomposition gate is re-presented (already split).
        run.awaiting = { tag: "summary", path, buffer: "" };
        armTurnWatchdog("summary", path);
        diag(`resume: re-running roll-up summary turn for "${pathKey(path)}"`);
        await deps.sendMessage(rollupSummaryPrompt(path, priorSummaries(path)));
        return;
      }
      case "review": {
        // RE-RUN THE IN-FLIGHT PARENT-REVIEW TURN. The active node is a split in `reviewing`.
        // The decomposition is already approved+durable; the only lost work is the un-landed
        // parent-review turn — a NO-TOOLS turn, so re-running it has no duplicate side effects. The
        // REVIEWED child is the rightmost SUMMARIZED direct child; the remaining siblings are the pending
        // children. Their mandates + the reviewed child's summary were reloaded by
        // reloadDriverStateFromDisk. Re-send parentReviewPrompt and arm `parent-review`; the result
        // re-enters the consume branch, which dispatches PARENT_REVIEW_DONE{path} and advances to the
        // next pending child's recon.
        const node = nodeAtPath(state!.root, path);
        if (!node || node.state.stage !== "split" || node.state.phase !== "reviewing") {
          throw new Error(
            `resume review: node "${pathKey(path)}" is ${node ? `${node.state.stage}/${node.state.phase}` : "missing"}, expected split/reviewing`,
          );
        }
        const summarized = node.state.children.filter(
          (c) => c.state.stage !== "open" && c.state.phase === "summarized",
        );
        const reviewedChildNode = summarized[summarized.length - 1];
        if (!reviewedChildNode) {
          // assertCoherent2 forbids reviewing without ≥1 summarized child — loud, never silent.
          throw new Error(`resume review: reviewing node "${pathKey(path)}" has no summarized child to review`);
        }
        const reviewedChild: NodePath = [...path, reviewedChildNode.nn];
        const childSummary = run.summaries.get(pathKey(reviewedChild)) ?? "";
        const remaining = node.state.children
          .filter((c) => c.state.stage === "open" && c.state.phase === "pending")
          .map((c) => {
            const sibPath: NodePath = [...path, c.nn];
            return { path: sibPath, mandate: mandateFor(sibPath) };
          });
        run.awaiting = { tag: "parent-review", parentPath: path, reviewedChild, buffer: "" };
        armTurnWatchdog("parent-review", path);
        diag(`resume: re-running parent-review turn for "${pathKey(path)}" (reviewed child "${pathKey(reviewedChild)}")`);
        await deps.sendMessage(parentReviewPrompt(reviewedChild, childSummary, remaining));
        return;
      }
    }
    assertNever(plan.awaiting);
  };

  // Live frames reach the handle fire-and-forget through the index.ts bridge, possibly back-to-back
  // within one tick. enqueueIngest chains each frame's work onto a single tail promise so frames
  // process in strict submission order — the union's single-armed-step invariant only holds if no two
  // frames interleave mid-await. ERROR ISOLATION: the tail is rebuilt with `.catch` so a throw is
  // logged and the tail stays RESOLVED, letting the next frame still run (a poisoned chain would
  // silently drop every later frame).
  let ingestQueue: Promise<void> = Promise.resolve();
  // INVARIANT[ingest-queue-serialized-and-poison-proof] (runtime-guard): frames process one-at-a-time through this promise chain; a throw drives a loud FATAL but the `.catch` leaves the tail resolved so later frames still run.
  //   prevents: a single throwing frame stalling the run silently / poisoning the chain
  const enqueueIngest = (work: () => Promise<void>): Promise<void> => {
    // `chained` is the queue-tail promise for THIS frame's work (named to avoid shadowing the
    // module-level `run: RunState` bundle — a future edit in this scope must touch the bundle, not
    // this local promise).
    const chained = ingestQueue.then(work);
    // ERROR ISOLATION + VISIBLE FAILURE: a throw in one frame must not silently stall the run. Log it,
    // then drive the run to a terminal FATAL so the UI surfaces the error and resets. The fatal-dispatch
    // is itself wrapped so a throw there (e.g. already terminal) still leaves the tail RESOLVED — the
    // chain is never poisoned and later frames can still run.
    ingestQueue = chained.catch(async (err) => {
      console.error("orchestrator ingest frame failed", err);
      // LOUD diag: if a pre-result frame throws here it dispatches FATAL -> markTerminal, which would
      // deactivate the orchestrator BEFORE the recon result lands (making the bridge gate false — the
      // prime suspect for the halt). Surface it in the dev terminal with the error text.
      const message = err instanceof Error ? err.message : String(err);
      diag(`enqueueIngest CATCH: ingest frame threw active=${active} err=${message}`);
      // TYPED NON-FATAL: a PlanValidationError must NEVER FATAL the run (a recoverable redraft
      // signal). The live decomposition-draft path catches it at the parse site; this is the BACKSTOP
      // for the resume re-parse / reloadDriverStateFromDisk paths where it can reach the queue
      // unguarded. Discriminated by TYPE (instanceof). Log it, leave the run active, let the redraft
      // flow continue.
      if (err instanceof PlanValidationError) {
        diag(`enqueueIngest CATCH: PlanValidationError (recoverable, NOT fatal) — ${message}`);
        return;
      }
      try {
        if (active) {
          await dispatch({ type: "FATAL", message: `orchestrator ingest frame failed: ${message}` });
        }
      } catch (fatalErr) {
        console.error("orchestrator FATAL dispatch after ingest failure also failed", fatalErr);
      }
    });
    return ingestQueue;
  };

  const handle: OrchestratorHandle = {
    start: async ({ cwd: startCwd, request: startRequest, images: startImages }) => {
      // Idempotent-guarded: a second start while active is a no-op (the seam is single-owner). Return
      // false so the composer does not treat a dead start as a real one (and close its modal).
      // INVARIANT[start-is-idempotent] (runtime-guard): a second start() while active is a no-op returning false.
      //   prevents: a dead start closing the composer modal / running the onStarted chain
      if (active) return false;
      // ALLOCATE A FRESH PER-RUN BUNDLE. A run shares ONE handle with the next (the singleton), so any
      // per-run map/flag left populated would bleed run A's context into run B's prompts (a stale
      // summary, mandate, or held-permission id). Replacing the WHOLE bundle resets every transient
      // TOGETHER — forgetting one (the prior HIGH-severity leak) is unrepresentable.
      run = freshRunState(startCwd, startRequest);
      // The session below opens in the DERIVED GENESIS policy ("prototype": clarifying-intent derives
      // it — throwaway prototype artifacts may be written under .plan-tree/prototype/, nothing else).
      // Priming the cache to the same value makes the START dispatch's policy seam fire NO setMode —
      // which matters because the session is not open yet at that dispatch (a pre-start
      // set-permission-mode is dropped). The first real assert is "plan" at the
      // INTENT_CLARIFIED/PROTOTYPE_APPROVED boundary, when the session is live.
      run.assertedPolicy = "prototype";
      // PRIME the model cache before the START dispatch below runs the model seam with active===true
      // while the driver is NOT open yet, so an unprimed null vs the genesis-phase model would fire
      // setModel on a not-yet-live session (Err → fatal). Prime the cache to the genesis root's
      // effective model — the genesis root is ALWAYS open/clarifying-intent (⇒ Sonnet), so this equals
      // what E1 opens the session with below (effectiveModel of the post-START genesis root). Computed
      // off a genesis-shaped node (mirroring dispatch's START base) because the real root does not exist
      // until the dispatch, exactly as assertedPolicy is primed to the literal genesis policy.
      run.assertedModel = effectiveModel({
        nn: parseNn(1),
        title: run.request,
        redraftCount: 0,
        lastFeedback: null,
        state: { stage: "open", phase: "clarifying-intent" },
        execution_model: null,
      }).model;
      active = true;
      activeOrchestrator = handle;
      // wire the wake seam for the lifetime of the run (torn down at markTerminal). A
      // quota pause armed mid-run uses it to recover from WebView timer suspension during a long wait.
      installWakeSeam();
      diag("start(): active set true, activeOrchestrator registered");
      // CLEANUP-ON-THROW: everything past here can reject (the START dispatch's resetPlanTreeDir effect
      // is the first awaitable), and the guard is already armed. Without the catch the rejection escapes
      // with `active` stuck true and `activeOrchestrator` registered — every retry hits the idempotency
      // guard and the orchestrator is wedged for the session. markTerminal does the terminal bookkeeping
      // (active=false, watchdog cleared, deregistered); disarm `awaiting` too (markTerminal doesn't own
      // it), then RETHROW so the composer still surfaces the message.
      try {
        const treeId = newTreeId();
        // Genesis: build the fresh tree (persists state.json). START now lands in `clarifying-intent`.
        await dispatch({ type: "START", treeId, request: run.request, nowMs: nowFn() });
        // QUOTA AUTO-RESUME BUDGET. Resolve the composer's choice (impure localStorage read
        // confined to defaultDeps) and stamp it onto the fresh ledger via QUOTA_BUDGET_SET, AT START
        // (after the genesis ledger exists, before the first turn) so a mid-run quota wall has its
        // budget. An absent resolveAutoResumeBudget leaves the reducer's fail-closed 0 default (no
        // auto-resume). resume() never reaches here, so it inherits the persisted budget.
        if (deps.resolveAutoResumeBudget) {
          const { budget } = deps.resolveAutoResumeBudget();
          await dispatch({ type: "QUOTA_BUDGET_SET", budget });
        }
        // Open the single SDK session in the derived genesis policy ("prototype" — see the
        // assertedPolicy note above), then send the INTENT prompt and arm "intent" so the first
        // turn-completion `result` advances the sequencer (intent → recon/prototype-review → …).
        // Open on the genesis node's EFFECTIVE model (root at clarifying-intent ⇒ Sonnet/high via
        // phaseModel). E3 will prime run.assertedModel to this SAME value so the first dispatch's
        // model seam fires no setModel on the not-yet-live driver.
        await deps.startSession({
          cwd: run.cwd,
          permissionMode: "prototype",
          execution: effectiveModel(requireState().root),
        });
        // VISUAL MODE: pre-create <cwd>/.plan-tree/prototype/ BEFORE the intent prompt goes out —
        // the sidecar's "prototype" policy only allows writes UNDER the dir (it cannot mkdir it),
        // and the prompt tells the clarifier the dir already exists. Optional dep (older fakes):
        // absent ⇒ skipped.
        await deps.ensurePrototypeDir?.(run.cwd);
        // Arm BEFORE sending: send_agent_message returns once the line is queued, and the turn's
        // `result` frame can reach ingestStream before/at the same flush as this await settling. Arming
        // after the await would let that result land while awaiting is idle and be swallowed — the run
        // halting at the opening phase (the minecraft-clone bug).
        // INVARIANT[arm-before-send] (convention): the next awaiting variant is armed before deps.sendMessage, because the turn's result can reach ingest before the send resolves.
        //   prevents: a result landing while awaiting is idle and being swallowed (the run halting at the opening phase)
        run.awaiting = { tag: "intent", buffer: "" };
        armTurnWatchdog("intent", []);
        diag("start(): armed intent, sending intentPrompt");
        // Multimodal first turn: thread the user's attached images into ONLY this first intent send
        // (omit-when-empty — every other deps.sendMessage in the driver stays text-only). When images
        // are present, intentPrompt also gets the forwarding directive so the main agent relays the
        // visual context into the text-only subagents it spawns.
        const hasStartImages = !!(startImages && startImages.length);
        await deps.sendMessage(
          intentPrompt(run.request, hasStartImages),
          hasStartImages ? startImages : undefined,
        );
      } catch (err) {
        markTerminal("start() threw");
        run.awaiting = { tag: "idle" };
        // Best-effort: if startSession already opened the SDK session before the throw, end it so a
        // live session can never coexist with isOrchestrationActive()===false (the Stop-routing
        // desync endSdkSession exists to prevent). Both inner calls are individually caught.
        await endSdkSession();
        throw err;
      }
      return true;
    },

    // RESUME. Mirrors start()'s setup discipline — register the active guard, prime the
    // policy cache, open the session, arm-before-send — but seeds from the ledger and re-presents/
    // re-sends instead of dispatching a fresh START.
    resume: async ({ cwd: resumeCwd, ledger }) => {
      // Idempotent-guarded exactly like start(): a second entry while active is a no-op.
      if (active) return false;
      // Seed the in-memory state from the ledger (pure: runs assertCoherent2, copies sdk_session_id,
      // nulls all transient gates). A torn ledger throws here — let it propagate to the caller (the
      // frontend wraps the click), nothing is registered yet.
      state = rehydrateState2(ledger);
      // allocate a fresh per-run bundle for the resumed run (every transient reset together). The
      // re-presented gate / re-sent step below re-arms exactly what the resumed phase needs; the
      // non-serialized summaries/mandates are reloaded from disk by reloadDriverStateFromDisk, and the
      // sdk_session_id is re-seeded from the ledger after the resumable check.
      run = freshRunState(resumeCwd, ledger.root.title);
      // DISK-PROBE SEAM: resumeScopeForRoot is PURE+synchronous, but the decomposing disambiguation
      // needs a real on-disk check (does planName2(activePath) exist under <cwd>/.plan-tree/?).
      // recoveryFor only probes the ACTIVE node's path, so pre-read that single artifact here and back
      // the synchronous predicate with the cached result. A NON-NULL read ⇒ "present" (re-present the
      // gate, no re-draft); null/absent or no readPlanTreeFile dep ⇒ "absent" (re-send the decompose
      // draft) — the conservative default. The predicate matches on pathKey so a probe of any other
      // path falls through to absent rather than a phantom hit.
      const decompositionArtifactCache = new Map<string, boolean>();
      const activeForProbe = activePathOf(state.root);
      if (activeForProbe !== null && deps.readPlanTreeFile) {
        const text = await deps.readPlanTreeFile(run.cwd, planName2(activeForProbe));
        decompositionArtifactCache.set(pathKey(activeForProbe), text !== null);
      }
      const decompositionArtifactExists = (path: NodePath): boolean =>
        decompositionArtifactCache.get(pathKey(path)) ?? false;
      // Resolve the resume scope. If the active phase is not resumable, do NOT start a run (guard
      // anyway — the frontend should have shown the blocked message). Pass the run-level facts
      // (baseline_ / acceptance_) so the acceptance window classifies as resumable, and the
      // disk-probe predicate so open/decomposing is classified gate-vs-resend by what is on disk.
      const scope: ResumeScope = resumeScopeForRoot(state.root, state, decompositionArtifactExists);
      if (!scope.resumable) {
        diag(`resume: active phase "${activePhaseLabel(state.root)}" is not resumable (${scope.reason}) — refusing`);
        state = null;
        return false;
      }
      // RESUME re-seeds the SDK session id from the ledger (freshRunState defaulted it null). All other
      // transients were already zeroed by the fresh-bundle allocation above; the non-serialized
      // summaries/mandates are reloaded from disk by reloadDriverStateFromDisk below.
      run.sdkSessionId = state.sdk_session_id ?? null;
      // DERIVED POLICY: the session opens in the policy the rehydrated tree implies — executing →
      // acceptEdits, planning → plan, genesis → prototype. The startSession dep maps policy → SDK mode;
      // prime the cache to the SAME value so the first post-resume dispatch's policy seam fires no
      // redundant setMode (and a pre-send setMode can't race a not-yet-live session).
      const policy = writePolicyFor2(state.root);
      run.assertedPolicy = policy;
      // PRIME the model cache: the first post-resume dispatch runs the model seam with
      // active===true. Resolve the resumed ACTIVE node ONCE (reused to OPEN the session at E1 below so
      // the opened model and the primed cache are byte-identical) and prime the cache to its effective
      // model. A null active path (acceptance/terminal window) leaves the cache null — the session opens
      // on the global picker and the seam sets the model once a node is active.
      const resumeActiveNode =
        activeForProbe !== null ? nodeAtPath(state.root, activeForProbe) : null;
      run.assertedModel = resumeActiveNode ? effectiveModel(resumeActiveNode).model : null;
      active = true;
      activeOrchestrator = handle;
      // wire the wake seam for the resumed run too (a resumed run can hit a quota wall).
      installWakeSeam();
      diag(`resume(): active set true, activeOrchestrator registered (policy=${policy}, phase=${activePhaseLabel(state.root)})`);
      // CLEANUP-ON-THROW (mirrors start()): everything past here can reject (session open, disk
      // reads, the resume action's send). The guard is armed, so a rejection would otherwise wedge the
      // orchestrator active forever — tear down + rethrow exactly as start() does.
      try {
        // Reload the non-serialized driver state (summaries/mandates) from disk BEFORE acting, so the
        // re-sent prompts thread the same prior context a never-killed run would.
        await reloadDriverStateFromDisk(state.root);
        // Open the single SDK session in the derived policy, RESUMING the prior transcript. A missing/
        // undefined sdk_session_id ⇒ the dep omits resumeSessionId ⇒ a fresh session (the sidecar's
        // expired-transcript fallback emits a non-fatal resume_fallback frame and runs the step fresh).
        // Open on the resumed ACTIVE node's effective model (resumeActiveNode, resolved above and
        // primed onto assertedModel). Null active path (acceptance/terminal window) ⇒ omit execution,
        // falling back to the global picker.
        await deps.startSession({
          cwd: run.cwd,
          permissionMode: policy,
          ...(state.sdk_session_id !== undefined ? { resumeSessionId: state.sdk_session_id } : {}),
          ...(resumeActiveNode ? { execution: effectiveModel(resumeActiveNode) } : {}),
        });
        // Continue from the resolved phase: re-present the gate (no prompt) or re-send the step.
        await resumeActionForPhase(scope.plan);
      } catch (err) {
        markTerminal("resume() threw");
        run.awaiting = { tag: "idle" };
        await endSdkSession();
        throw err;
      }
      return true;
    },

    snapshot: () => toSnapshot2(requireState()),

    // THE UNIFIED APPROVE SURFACE. `pathKeyStr` is parsed at the UI boundary (parsePathKey throws
    // loudly on garbage); the held gate is looked up and the action routes by gate.kind through an
    // EXHAUSTIVE switch ending in assertNever — the dangerous branch (interrupt) stays lexically
    // INSIDE the decomposition case so it can never be hoisted to cover a leaf approval.
    approve: async (pathKeyStr) => {
      const path = parsePathKey(pathKeyStr);
      const gate = state?.pendingApproval ?? null;
      if (!gate || pathKey(gate.path) !== pathKey(path)) {
        throw new Error(
          `approve("${pathKeyStr}"): no held approval gate for that path (held: ${
            gate ? `"${pathKey(gate.path)}"` : "none"
          })`,
        );
      }
      // RESUMED-GATE APPROVAL: the gate was reconstructed from disk; its toolUseId is the
      // synthetic `resumed:` sentinel and the live resolver is dead. There is NO in-flight turn here,
      // so the merge-into-in-flight-turn hazard the live decomposition branch defers around does NOT
      // apply — we send the continuation prompt INLINE and never interrupt. The reducer transitions the
      // tree as the live path does; its resolvePermission effect against the synthetic id is dropped by
      // runEffect's resumed short-circuit.
      if (run.resumedGate) {
        run.resumedGate = false;
        switch (gate.kind) {
          case "leaf": {
            // The reducer moves the leaf to executing (policy → acceptEdits at the dispatch seam),
            // resolving the synthetic id is a no-op. Then instruct the resumed conversation to
            // implement the approved plan and arm `exec` (arm-before-send) for the exec result.
            await dispatch({ type: "APPROVE", path });
            run.awaiting = { tag: "exec", path, buffer: "" };
            diag(`resumed approve (leaf) at "${pathKey(path)}": sending implement prompt, armed exec`);
            await deps.sendMessage(resumedLeafApprovalPrompt(gate.planPath));
            return;
          }
          case "decomposition": {
            // parsedChildren is null on resume — re-derive the children by re-parsing the on-disk
            // decomposition plan (the gate's own artifact), then replay CHILDREN_PARSED (rebuilds the
            // stash) + DECOMPOSITION_APPROVED (materializes the split with child[0] in recon). Finally
            // fire the first child's recon INLINE — nothing is in flight, so no resuming hold / no
            // interrupt (unlike the live decomposition approve).
            const read = deps.readPlanTreeFile;
            const planText = read ? await read(run.cwd, planName2(path)) : null;
            if (planText === null) {
              throw new Error(
                `resumed approve (decomposition) at "${pathKey(path)}": decomposition plan ${planName2(path)} not found on disk — cannot re-derive children`,
              );
            }
            // ON RESUME — DENY-FOR-REDRAFT, never a silent wedge. approve() is NOT wrapped in
            // enqueueIngest (a direct UI call), so a PlanValidationError from the re-parse would escape
            // to main.ts's generic catch — leaving the gate held with no redraft and no FATAL (a stuck
            // Resume→Approve). A malformed on-disk master is RECOVERABLE: move the node back to
            // open/decomposing (DECOMPOSITION_CHANGES_REQUESTED, dropping the dead synthetic id's
            // resolve) and send the resumed redraft prompt with the validation message. The run stays
            // active; the next signal is the re-draft's fresh ExitPlanMode hold (resumedGate already
            // cleared above). Non-validation errors still propagate — same typed discriminator as live.
            let parsed: ParsedMasterPlan;
            try {
              parsed = parseSubPlanHeaders(planText);
            } catch (err) {
              if (err instanceof PlanValidationError) {
                diag(`resumed approve (decomposition) at "${pathKey(path)}": on-disk master malformed, denying for redraft — ${err.message}`);
                await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback: err.message });
                run.awaiting = { tag: "idle" };
                await deps.sendMessage(resumedDecompositionChangesPrompt(err.message));
                return;
              }
              throw err;
            }
            // Repopulate this node's mandates from the re-parsed plan (reloadDriverStateFromDisk could
            // not — the node was still open/awaiting-decomposition-approval, artifact-free at rest).
            const parentKey = pathKey(path);
            const childPrefix = parentKey === "" ? "" : `${parentKey}.`;
            run.mandates = new Map([
              ...[...run.mandates.entries()].filter(([k]) => !k.startsWith(childPrefix)),
              ...parsed.subplans.map(
                (s): [PathKey, Mandate] => [
                  pathKey([...path, s.nn]),
                  { title: s.title, sectionBody: s.body, masterPreamble: parsed.preamble },
                ],
              ),
            ]);
            await dispatch({
              type: "CHILDREN_PARSED",
              path,
              children: parsed.subplans.map((s) => ({ nn: s.nn, title: s.title })),
            });
            await dispatch({ type: "DECOMPOSITION_APPROVED", path });
            // The first child is now active in recon. Send its recon prompt INLINE + arm `recon`
            // (arm-before-send). activePath() reads the freshly-materialized first child.
            const nextPath = activePath();
            if (nextPath !== null) {
              run.awaiting = { tag: "recon", path: nextPath, buffer: "" };
              diag(`resumed approve (decomposition) at "${pathKey(path)}": firing recon for first child "${pathKey(nextPath)}"`);
              await deps.sendMessage(
                subReconPrompt(
                  nextPath,
                  mandateFor(nextPath),
                  priorSummaries(parentPathOf(nextPath)),
                  adjustNoteFor(nextPath),
                ),
              );
            }
            return;
          }
        }
        assertNever(gate.kind);
      }
      switch (gate.kind) {
        case "decomposition": {
          // DECOMPOSITION APPROVAL (the gen-1 approveMaster body, path-keyed). The deferred-recon
          // target is the stash's FIRST child: DECOMPOSITION_APPROVED materializes the split with
          // child[0] active, so the path is known PRE-dispatch — needed because the resuming hold must
          // be armed before any await below.
          const stash = state?.parsedChildren ?? null;
          const firstNn =
            stash && pathKey(stash.path) === pathKey(path) ? stash.children[0].nn : null;
          const nextPath: NodePath | null = firstNn !== null ? [...path, firstNn] : null;
          if (nextPath !== null) {
            // ARM BEFORE THE FIRST AWAIT. The resolve round-trip (inside the dispatch below) yields to
            // the event loop, and the approval-resumed turn's `result` can reach ingestStream during
            // those awaits. Armed only after them (the old ordering), that result landed while awaiting
            // was idle and was SWALLOWED — the deferred recon never fired and the watchdog FATALed a
            // healthy run. DO NOT send the recon prompt here either: resolving the approval resumes the
            // SAME in-flight decomposition turn (with its canned "start coding" injection), so a message
            // sent now merges INTO that turn — a whole sub-plan in one turn with no gate (the confirmed
            // incident). The resumed turn's `result` fires it.
            armResuming(nextPath);
          }
          // The reducer resolves the held permission (allow) + persists; the resolve effect nulls
          // assertedPolicy so the dispatch seam re-asserts the derived "plan" policy BEFORE the
          // deferred recon prompt can fire. This closes the incident where the planning phases
          // after decomposition approval ran in a writable mode.
          await dispatch({ type: "DECOMPOSITION_APPROVED", path });
          if (nextPath !== null) {
            // Do NOT wait for the approval-resumed turn to end voluntarily: told "start coding", the
            // model free-runs (the phase-1 incident — background agents spawned, writes denied by the
            // plan backstop, NO result for minutes, watchdog FATAL). INTERRUPT it: the sidecar's
            // interrupt calls Query.interrupt(), the aborted turn emits its terminal `result` within
            // seconds, and the `resuming` branch consumes that as the boundary firing the deferred
            // recon. Armed-then-interrupt (no await between arm and the dispatch above) so the boundary
            // can never land on an unarmed sequencer. SCOPED lexically INSIDE the decomposition case —
            // the leaf case must never interrupt (there the resumed turn IS the execution). A failed
            // interrupt is logged, not rethrown: the watchdog backstops a missing boundary into a FATAL.
            try {
              await deps.interrupt();
            } catch (err) {
              console.error(
                "interrupt after decomposition approval failed (watchdog will backstop)",
                err,
              );
            }
          }
          return;
        }
        case "leaf": {
          // LEAF APPROVAL (the gen-1 approve body). The reducer resolves the held ExitPlanMode (allow);
          // the derived policy flips to acceptEdits; the SDK resumes the SAME turn and executes. NO
          // prompt is sent — the resumed turn IS the execution, so there is no inline-send hazard here
          // (unlike the decomposition case), and for the same reason it must NEVER call deps.interrupt()
          // (that would abort the execution the user just approved). Arm "exec" (capturing the path) so
          // the NEXT `result` (exec completion) is caught.
          await dispatch({ type: "APPROVE", path });
          run.awaiting = { tag: "exec", path, buffer: "" };
          return;
        }
      }
      assertNever(gate.kind);
    },

    // THE UNIFIED REQUEST-CHANGES SURFACE: deny the held gate with feedback. For BOTH kinds the SDK
    // feeds the deny reason back to the model as the tool error and RESUMES THE SAME TURN to
    // re-draft — send NOTHING inline (a message sent now would be merged into that still-in-flight
    // turn, the same hazard the approve decomposition branch defers around). The next signal is the
    // re-draft's fresh ExitPlanMode hold, not a `result` — nothing to arm.
    requestChanges: async (pathKeyStr, feedback) => {
      const path = parsePathKey(pathKeyStr);
      const gate = state?.pendingApproval ?? null;
      if (!gate || pathKey(gate.path) !== pathKey(path)) {
        throw new Error(
          `requestChanges("${pathKeyStr}"): no held approval gate for that path (held: ${
            gate ? `"${pathKey(gate.path)}"` : "none"
          })`,
        );
      }
      // RESUMED-GATE REQUEST-CHANGES: the synthetic id cannot be denied (the live resolver is
      // dead), so a live deny's "resume the held turn to re-draft" is impossible. The reducer still
      // moves the node back to drafting (open/decomposing or leaf/drafting), its synthetic-id deny is
      // dropped by runEffect, and we send an explicit redraft prompt with the feedback INLINE. The next
      // signal is the re-draft's fresh ExitPlanMode hold (a permission frame, not a `result`), so arm idle.
      if (run.resumedGate) {
        run.resumedGate = false;
        switch (gate.kind) {
          case "decomposition": {
            await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback });
            run.awaiting = { tag: "idle" };
            diag(`resumed requestChanges (decomposition) at "${pathKey(path)}": sending redraft prompt`);
            await deps.sendMessage(resumedDecompositionChangesPrompt(feedback));
            return;
          }
          case "leaf": {
            await dispatch({ type: "REQUEST_CHANGES", path, feedback });
            run.awaiting = { tag: "idle" };
            diag(`resumed requestChanges (leaf) at "${pathKey(path)}": sending redraft prompt`);
            await deps.sendMessage(resumedLeafChangesPrompt(feedback));
            return;
          }
        }
        assertNever(gate.kind);
      }
      switch (gate.kind) {
        case "decomposition": {
          // The reducer denies the held permission with the feedback, discards the stale child
          // parse, and moves the node back to open/decomposing for the same-turn redraft.
          await dispatch({ type: "DECOMPOSITION_CHANGES_REQUESTED", path, feedback });
          run.awaiting = { tag: "idle" };
          return;
        }
        case "leaf": {
          // The reducer denies with feedback; the node re-drafts IN PLACE (active path fixed,
          // redraftCount incremented).
          await dispatch({ type: "REQUEST_CHANGES", path, feedback });
          run.awaiting = { tag: "idle" };
          return;
        }
      }
      assertNever(gate.kind);
    },

    answerClarify: async (toolUseId, answers) => {
      await dispatch({ type: "CLARIFY_ANSWERED", toolUseId, answers });
      // INTENT-WATCHDOG RESUME: the clarify hold resolved, the intent turn is generating again —
      // re-arm the paused watchdog (see the AskUserQuestion ingest branch).
      if (run.awaiting.tag === "intent") armTurnWatchdog("intent", []);
    },

    approvePrototype: async (opts) => {
      const gate = state?.pendingPrototype ?? null;
      if (!gate) throw new Error("approvePrototype(): no pending prototype gate");
      // The root is already in prototype-review with this gate held; resolveApprove composes
      // INTENT.md, dispatches PROTOTYPE_APPROVED (legal from prototype-review), arms recon and
      // sends the recon prompt. `asWorkingReference` (DEFAULT false — "just a sketch") additionally
      // freezes .plan-tree/prototype/ → .plan-tree/baseline/ and records baseline_ on the ledger.
      await resolveApprove(gate, opts?.asWorkingReference === true);
    },

    refinePrototype: async (feedback, opts) => {
      const gate = state?.pendingPrototype ?? null;
      if (!gate) throw new Error("refinePrototype(): no pending prototype gate");
      // DRIVER-OWNED round increment (see the prototypeRound discipline note): count the refine
      // request itself, so the NEXT gate is minted round prototypeRound+1 regardless of clarifier
      // output.
      // INVARIANT[prototype-round-driver-owned-monotonic] (runtime-guard): prototypeRound counts completed refine requests, incremented ONLY here, reset ONLY via freshRunState; the gate mints round+1.
      //   prevents: a clarifier-supplied round count gaming the loop-escape threshold
      run.prototypeRound++;
      await dispatch({ type: "PROTOTYPE_REFINED", feedback });
      // COMBINED apply-and-approve: arm the auto-approve latch LAST, only after the dispatch resolved —
      // so a dispatch throw can never leave the flag set with no turn in flight. The intent-ingestion
      // branch reads it when the revised prototype block arrives and auto-resolves the gate forward
      // (PROTOTYPE_READY → PROTOTYPE_APPROVED) instead of surfacing another review round.
      if (opts?.autoApprove) run.autoApproveNext = true;
      // Re-arm the intent turn (same genesis arm + watchdog) BEFORE sending. The session is idle
      // — the intent turn that surfaced this gate already ended — so nothing is in flight to
      // interrupt; the refine prompt simply opens the next visual round's turn.
      run.awaiting = { tag: "intent", buffer: "" };
      armTurnWatchdog("intent", []);
      diag(
        `refinePrototype: round=${run.prototypeRound}, autoApprove=${opts?.autoApprove === true}, re-armed intent, sending refine prompt`,
      );
      await deps.sendMessage(refinePrototypePrompt(feedback));
    },

    approveAcceptance: async () => {
      // APPROVE THE FORCED ACCEPTANCE GATE. The root is parked in its acceptance window;
      // ACCEPTANCE_APPROVED performs the deferred finalize (root → summarized + notifyDone) and records
      // acceptance_={verdict:"approved"}. No turn is in flight (a post-completion hold), so nothing to
      // interrupt; markTerminal runs inside notifyDone's effect.
      if (!state?.pendingAcceptance) throw new Error("approveAcceptance(): no pending acceptance gate");
      await dispatch({ type: "ACCEPTANCE_APPROVED", decidedMs: nowFn() });
    },

    divergeAcceptance: async (reason) => {
      // ACCEPT DIVERGENCE FROM THE BASELINE FLOOR, recording WHY. Same finalize as approve;
      // ACCEPTANCE_DIVERGED additionally persists the reason (the audit trail for the waived floor).
      if (!state?.pendingAcceptance) throw new Error("divergeAcceptance(): no pending acceptance gate");
      await dispatch({ type: "ACCEPTANCE_DIVERGED", reason, decidedMs: nowFn() });
    },

    refineAcceptance: async (target) => {
      // RE-PLAN A SUB-PLAN from the forced acceptance gate (the third gate action). The
      // reducer RESETS the target node + its right-siblings to a fresh re-execution shape (target →
      // open/recon, right-siblings → open/pending), clears pendingAcceptance, deletes each reset node's
      // on-disk NN-plan.md/NN-summary.md, and persists. No turn is in flight (a post-completion hold),
      // so we drive the target's recon turn ourselves (mirroring the PARENT_REVIEW_DONE recon hop). On
      // re-completion (baseline still present, no verdict) the Phase-5 gate re-arms automatically.
      if (!state?.pendingAcceptance) throw new Error("refineAcceptance(): no pending acceptance gate");
      // Compute the reset set (target + right-siblings at the target's level) BEFORE dispatch so we can
      // drop their STALE summaries from the driver's per-level threading map — a refine re-runs them,
      // so a leftover entry would thread a stale summary into the re-run AND survive as a phantom
      // sibling summary. The reducer re-validates the same set (it is the source of truth).
      const parentPath = target.slice(0, -1);
      const parentNode = nodeAtPath(state.root, parentPath);
      const resetKeys: PathKey[] = [];
      if (parentNode && parentNode.state.stage === "split") {
        const idx = parentNode.state.children.findIndex((c) => c.nn === target[target.length - 1]);
        if (idx >= 0) {
          for (let i = idx; i < parentNode.state.children.length; i++) {
            resetKeys.push(pathKey([...parentPath, parentNode.state.children[i].nn]));
          }
        }
      }
      await dispatch({ type: "ACCEPTANCE_REFINED", target });
      // Drop the reset nodes' stale summaries (the reducer already deleted the on-disk files; this
      // clears the in-memory threading map to match). A reset node may itself be a SPLIT (with depth-2
      // sub-plans + a roll-up under "01"), so drop the ENTIRE SUBTREE of each reset node, not just its
      // direct key — otherwise a re-run that re-decomposes with colliding child NNs would thread the
      // stale "01."-prefixed entries as phantom summaries. Scope is strictly the reset nodes' subtrees;
      // left-siblings are never matched.
      for (const resetKey of resetKeys) {
        const subtreePrefix = `${resetKey}.`;
        for (const k of [...run.summaries.keys()]) {
          if (k === resetKey || k.startsWith(subtreePrefix)) run.summaries.delete(k);
        }
      }
      // Drive the target's recon turn. The session is idle (the gate was a post-completion hold), so
      // the recon prompt opens a fresh turn — no resuming hold, no interrupt. Arm BEFORE sending.
      const nextPath = activePath();
      if (nextPath !== null) {
        run.awaiting = { tag: "recon", path: nextPath, buffer: "" };
        diag(`refineAcceptance: reset "${pathKey(target)}" + right-siblings, armed recon at "${pathKey(nextPath)}"`);
        await deps.sendMessage(
          subReconPrompt(
            nextPath,
            mandateFor(nextPath),
            priorSummaries(parentPathOf(nextPath)),
            adjustNoteFor(nextPath),
          ),
        );
      }
    },

    ingestStream: (frame) => enqueueIngest(() => ingestStreamImpl(frame)),

    ingestPermission: (req) => enqueueIngest(() => ingestPermissionImpl(req)),

    cancel: async () => {
      // Cancel is terminal: stop the turn + end the session, purge any held interactive permission so
      // the sidecar's held resolver is not stranded, and deregister. The on-disk ledger is LEFT INTACT;
      // the next START sweeps it into .plan-tree/.archive/, where exactly one generation survives.
      const wasActive = active;
      markTerminal("cancel()");
      // RESUMED-GATE GUARD: a resumed gate's heldPermissionId is the synthetic `resumed:`
      // sentinel — the sidecar holds NO resolver for it, so purging would call a dead id. Skip the
      // purge for synthetic ids (clear local state + the resumed flag). Real held ids purge as before.
      run.resumedGate = false;
      if (run.heldPermissionId && run.heldPermissionId.startsWith("resumed:")) {
        run.heldPermissionId = null;
      } else if (run.heldPermissionId) {
        const id = run.heldPermissionId;
        run.heldPermissionId = null;
        try {
          await deps.resolvePermission({
            id,
            allow: false,
            message: "Run cancelled.",
          });
        } catch (err) {
          console.error("resolve_tool_permission (cancel purge) failed", err);
        }
      }
      if (wasActive) {
        await endSdkSession();
      }
    },

    subscribe: (obs) => {
      observers.add(obs);
      return () => {
        observers.delete(obs);
      };
    },

    teardown: async () => {
      if (torn) return;
      torn = true;
      await handle.cancel();
      observers.clear();
    },

    orchestrationActive: () => active,

    resuming: () => run.awaiting.tag === "resuming",

    // INVARIANT[quota-paused-single-probe] (runtime-guard): 'are we quota-paused?' has one answer — quotaPause!==null || quotaPausePending; both agent-exit listeners read it.
    //   prevents: a same-tick agent-exit classified as end-of-run instead of a pause
    quotaPaused: () => run.quotaPause !== null || run.quotaPausePending,

    markQuotaPausePending: () => {
      // set synchronously the instant a quota_exceeded frame is seen, BEFORE the
      // microtask-deferred QUOTA_PAUSED installs `quotaPause`. Makes quotaPaused() synchronously-correct
      // for the same-tick agent-exit both listeners consult. Cleared when the pause resolves
      // (clearQuotaPause).
      run.quotaPausePending = true;
    },

    notifyAgentExit: () => {
      // The prior (paused) sidecar session exited. Only meaningful while a non-exhausted pause is
      // armed: record the exit and, if the resume timer already fired and was waiting on it, kick the
      // deferred resume (serialized through enqueueIngest, the timer-fired path). No-op otherwise
      // (a genuine end-of-run exit, or an exit while no pause is armed). Idempotent.
      if (!run.quotaPause || run.quotaPause.exhausted) return;
      if (run.quotaPause.priorExited) return;
      run.quotaPause.priorExited = true;
      diag("notifyAgentExit: prior paused session exited; re-checking deferred resume");
      void enqueueIngest(() => fireResume());
    },

    setExecutionModel: async (path, options) => {
      // Thin pass-through to the reducer's override event (mirrors approvePrototype → resolveApprove →
      // dispatch): the reducer stamps execution_model + model_source "override" and emits `persist`; the
      // funnel emits the fresh snapshot the sidebar badge / picker re-render off. No turn is in flight to
      // interrupt — a model override never touches the running session.
      await dispatch({ type: "EXECUTION_MODEL_SET", path, options });
    },

    dispatch: (event) => dispatch(event),
  };

  // TEST-ONLY: register this handle's ingest-seen counter accessor so __ingestSeenForTest(handle) can
  // observe how many ingest thunks the queue actually invoked. Off the frozen interface (a side table).
  ingestSeenAccessors.set(handle, () => ingestSeen);

  // TEST-ONLY (cross-run-leak guard): expose the per-run transient sizes so a test can prove a FRESH
  // run resets every per-run map/flag. The leak class is closed by allocating a fresh bundle in
  // start()/resume(); this accessor is the falsifiable witness. Off the frozen interface (a side table).
  runTransientAccessors.set(handle, () => ({
    summaries: run.summaries.size,
    mandates: run.mandates.size,
    clarifyQuestions: run.clarifyQuestions.size,
    adjustNotePresent: run.adjustNote !== null,
  }));

  return handle;
}

// TEST-ONLY side table: handle -> a getter for its private ingestSeen counter (the count of ingest
// thunks the queue dequeued+invoked). Used by the error-isolation test to prove the queue chain was
// not poisoned by a throwing frame, independently of the terminal guard suppressing effects.
const ingestSeenAccessors = new WeakMap<OrchestratorHandle, () => number>();

// TEST-ONLY: read how many ingest-impl thunks `handle`'s queue has dequeued+invoked. Returns 0 for an
// unknown handle. NOT part of the frozen UI contract.
export function __ingestSeenForTest(handle: OrchestratorHandle): number {
  return ingestSeenAccessors.get(handle)?.() ?? 0;
}

// TEST-ONLY — the per-run transient sizes snapshot shape + side table.
interface RunTransientSizes {
  summaries: number;
  mandates: number;
  clarifyQuestions: number;
  adjustNotePresent: boolean;
}
const runTransientAccessors = new WeakMap<OrchestratorHandle, () => RunTransientSizes>();

// TEST-ONLY: read `handle`'s per-run transient sizes (summaries/mandates/clarifyQuestions map
// sizes + whether an adjust note is pending). A fresh run MUST reset all of these — this is the
// witness for the cross-run-leak guard. Returns the empty shape for an unknown handle. NOT part of
// the frozen UI contract.
export function __runTransientSizesForTest(handle: OrchestratorHandle): RunTransientSizes {
  return (
    runTransientAccessors.get(handle)?.() ?? {
      summaries: 0,
      mandates: 0,
      clarifyQuestions: 0,
      adjustNotePresent: false,
    }
  );
}

// The live app shares ONE orchestrator instance between the gate controller and the composer-entry,
// so both drive the SAME handle. Constructed lazily on first access, real-deps-bound. Tests install a
// fake via __setOrchestratorForTest and reset module state via __resetOrchestratorForTest.

let singleton: OrchestratorHandle | null = null;

// The shared orchestrator instance for the live app (lazy, real-deps-bound).
export function getOrchestrator(): OrchestratorHandle {
  if (!singleton) singleton = createOrchestrator();
  return singleton;
}

// TEST-ONLY: install a fake handle (e.g. createOrchestrator(fakeDeps)) as the shared singleton.
export function __setOrchestratorForTest(h: OrchestratorHandle | null): void {
  singleton = h;
}

// TEST-ONLY: register `h` as the module-level active-guard entry (what isOrchestrationActive() /
// isOrchestratorResuming() read) without driving a real start(). Cleared by __resetOrchestratorForTest.
export function __setActiveOrchestratorForTest(h: OrchestratorHandle | null): void {
  activeOrchestrator = h;
}

// TEST-ONLY: reset module state between tests. Nulls the singleton AND the module-level
// activeOrchestrator guard so a leaked active singleton cannot bleed across tests — a stale
// isOrchestrationActive()===true would make handleToolPermissionRequested early-return and silently
// disable the entire main.inproc-review.test.ts suite.
export function __resetOrchestratorForTest(): void {
  singleton = null;
  activeOrchestrator = null;
}

// A fresh tree id. Mirrors the backend's seed style (a short random hex) without colliding with the
// backend-seeded ids — START establishes the canonical tree_id the driver tags every writeAgentPlan
// with, so a sub is never mistagged as a master.
function newTreeId(): string {
  const rand = Math.random().toString(16).slice(2, 10);
  return `tree-${Date.now().toString(36)}-${rand}`;
}
