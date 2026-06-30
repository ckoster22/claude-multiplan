// Multiplan orchestration — injected dependency interface + the real-Tauri-bound factory (leaf).
//
// Relocated VERBATIM from the former single-file orchestrator.ts. No logic changed; only the
// one-level relative-import path shifts forced by moving into the orchestrator/ subdirectory.

import { invoke } from "@tauri-apps/api/core";
import { resolveModelOptions } from "../../model-picker";
import { resolveAutoResumeBudget } from "../../auto-resume-setting";
import type { AttachedImage } from "../images";
import type { WritePolicy } from "../plan-tree";


// ---- injected dependency interface (mirror ComposerInvoker) ---------------------------------

// Every Tauri command an Effect needs, wrapped so tests inject fakes. `defaultDeps()` binds these
// to real `invoke(...)`. Async throughout — the driver awaits each effect in order.
export interface OrchestratorDeps {
  // start_agent_session({ cwd, permissionMode, resumeSessionId? }). RESUME (Phase 3): the optional
  // `resumeSessionId` is forwarded to Rust as `resumeSessionId` (camelCase → Rust `resume_session_id`
  // → sidecar `"resume"`). Absent/undefined ⇒ a fresh session (omitted from the invoke args, never
  // sent as `undefined`). start() never passes it; resume() passes state.sdk_session_id (which may
  // itself be undefined → fresh, the expired-transcript fallback the sidecar handles).
  startSession(args: { cwd: string; permissionMode: string; resumeSessionId?: string }): Promise<void>;
  // send_agent_message({ text }) — or, for the multimodal first-turn send, send_agent_message({ text,
  // images }). `images` is OPTIONAL and OMITTED-WHEN-EMPTY: every text-only send (all but the first
  // intent send) passes no `images` arg, so defaultDeps forwards the byte-identical `{ text }` shape.
  sendMessage(text: string, images?: AttachedImage[]): Promise<void>;
  // set_agent_permission_mode({ mode }) — only the two derived write policies are ever asserted.
  setMode(mode: WritePolicy): Promise<void>;
  // resolve_tool_permission({ id, allow, message?, updatedInput? })
  resolvePermission(args: {
    id: string;
    allow: boolean;
    message?: string;
    updatedInput?: unknown;
  }): Promise<void>;
  // cancel_agent_run() — used by cancel()/teardown alongside endSession.
  cancelRun(): Promise<void>;
  // cancel_agent_run() — the TURN-INTERRUPT boundary. The Rust command sends `{type:"interrupt"}`
  // to the sidecar, which calls the SDK query's `interrupt()` (Query.interrupt, sdk.d.ts): the
  // in-flight turn is aborted and emits its terminal `result` frame (an SDKResultError, subtype
  // `error_during_execution`) — the sidecar normalizes EVERY result subtype to a `result` frame, so
  // the resuming consume-path accepts it. A distinct dep from cancelRun (same wire command) so the
  // call sites — and the tests asserting interrupt IS/IS-NOT fired — read as intent, not teardown.
  interrupt(): Promise<void>;
  // end_agent_session()
  endSession(): Promise<void>;
  // plan_tree::write_plan_tree_file({ cwd, name, contents }) -> the absolute path written.
  writePlanTreeFile(cwd: string, name: string, contents: string): Promise<string>;
  // PHASE 6 — plan_tree::delete_plan_tree_file({ cwd, name }) — delete <cwd>/.plan-tree/<name>,
  // containment-guarded + allow-list-validated EXACTLY like writePlanTreeFile (it reuses the same
  // guarded_plan_tree_path). Absent file ⇒ graceful no-op (Ok), never an error. Used by the refine
  // branch to clear each reset node's NN-plan.md / NN-summary.md so the re-run overwrites a clean
  // slate. OPTIONAL + additive (like the resume/baseline seams) so pre-Phase-6 fakes still compile;
  // absent ⇒ the driver skips the delete (the overwrite-on-re-run still corrects the summary).
  deletePlanTreeFile?(cwd: string, name: string): Promise<void>;
  // plan_tree::read_plan_tree_file({ cwd, name }) -> the file's text, or null when it does not exist
  // (the Rust command returns Option<String>). RESUME (Phase 3): used to reload the non-serialized
  // driver state (summaries, mandates) from the on-disk .plan-tree/ artifacts on resume(). OPTIONAL
  // like the prototype/timer seams so pre-resume fakes still compile; absent ⇒ the reload is skipped
  // (the resumed run threads no prior summaries/mandates — degraded, not broken).
  readPlanTreeFile?(cwd: string, name: string): Promise<string | null>;
  // read_plan_contents({ path }) -> the plan file's text. Unlike readPlanTreeFile (the `.plan-tree/`
  // allow-listed channel), this reads the PLANS STORE by absolute `~/.claude/plans/...` path — the
  // channel a LEAF plan lives in (writeAgentPlan writes leaf plans into `~/.claude/plans/`, NOT
  // `.plan-tree/`). The Rust command REJECTS (throws — not Ok(None)) on a missing/out-of-bounds path.
  // RESUME (Phase 3b): the leaf/executing audit-and-continue verifies the leaf's durable plan through
  // THIS, keyed by the node's absolute planPath — reading it through readPlanTreeFile would ALWAYS
  // miss (the file is not under `.plan-tree/`, and the Rust allow-list rejects an absolute name).
  // OPTIONAL like the other resume seams so pre-Phase-3b fakes still compile; absent ⇒ the durable
  // check is skipped (the continuation proceeds on the node's planPath, the same trust the gate path
  // gives planPath).
  readPlanContents?(path: string): Promise<string>;
  // plan_tree::reset_plan_tree_dir({ cwd }) — archive every current <cwd>/.plan-tree/ entry into
  // .plan-tree/.archive/ (replacing any prior archive). Run by START before the genesis persist.
  resetPlanTreeDir(cwd: string): Promise<void>;
  // ensure_prototype_dir({ cwd }) -> the absolute prototype dir path. Creates
  // <cwd>/.plan-tree/prototype/ (idempotent) BEFORE the visual-mode intent prompt is sent, so the
  // clarifier never needs Bash/mkdir (the sidecar's "prototype" policy only allows writes UNDER the
  // dir — it cannot create it). OPTIONAL like the timer seam: fakes that predate the
  // visual-prototype loop still compile; absent ⇒ the driver skips the call.
  // (The Rust command lands in a parallel task — defaultDeps just wires the invoke.)
  ensurePrototypeDir?(cwd: string): Promise<string>;
  // BASELINE FREEZE (Phase 3): create + populate <cwd>/.plan-tree/baseline/ when the user marks the
  // visual prototype a "working reference". ensureBaselineDir creates the contained dir;
  // freezeBaseline recursively copies the prototype subtree into it (both Rust-side containment-
  // guarded). OPTIONAL like ensurePrototypeDir so pre-baseline fakes still compile; absent ⇒ the
  // driver skips the freeze and records NO baseline_ (a presence record must match disk — the recon
  // hop still proceeds, but no baseline is claimed when the freeze did not actually run).
  ensureBaselineDir?(cwd: string): Promise<string>;
  freezeBaseline?(cwd: string): Promise<string>;
  // PHASE 5 — open a frozen-baseline artifact in the OS default handler (the Rust `open_baseline`
  // command; `path` is relative to <cwd>/.plan-tree/baseline/, containment-guarded Rust-side). The
  // forced-acceptance gate calls this so the user can exercise the baseline against the just-built
  // result. OPTIONAL like the other baseline seams: absent ⇒ the gate still surfaces, but the
  // "open baseline" step is skipped (the verdict actions remain available).
  openBaseline?(cwd: string, path: string): Promise<void>;
  // write_agent_plan({ plan, treeId, nn }) -> the absolute path written. `nnPath` is null for the
  // root decomposition plan (flavor master, for sidebar nesting), else the node's canonical
  // zero-padded dotted PathKey string ("01", "02.01", …). Phase 2 wire: the Rust side takes
  // Option<String> and REJECTS a bare JSON number — every caller must send the string form.
  writeAgentPlan(plan: string, treeId: string, nnPath: string | null): Promise<string>;
  // INJECTABLE TIMER SEAM (optional — defaults to the global timers): the resume watchdog schedules
  // through these so tests fire/inspect it without sleeping. The handle type is opaque (`unknown`)
  // so DOM-number and Node-Timeout environments both fit.
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  // INJECTABLE CLOCK SEAM (optional — defaults to Date.now): the driver stamps `updated_ms` at its
  // single persist path through this, so every ledger write carries a fresh timestamp and tests
  // assert monotonicity without sleeping.
  now?(): number;
  // PHASE 4 — INJECTABLE WAKE SEAM (optional — defaults to document.visibilitychange in defaultDeps):
  // a WebView occluded for the duration of a quota wait suspends its in-page timers (the occluded-
  // window timer-suspension hazard — see MEMORY). When the window un-occludes the quota timer that
  // SHOULD have fired during the wait may still be pending. This seam delivers a "the page just woke"
  // signal so the quota machinery can recompute remaining time against the WALL CLOCK and resume
  // immediately if the reset already passed. Returns an unsubscribe fn (called at teardown). Tests
  // inject a fake that captures the callback so they can drive a wake without a real DOM event.
  onWake?(fn: () => void): () => void;
  // PHASE 6 — INJECTABLE AUTO-RESUME BUDGET SEAM (optional). start() resolves the run's quota
  // auto-resume budget through this and dispatches QUOTA_BUDGET_SET at the START boundary (the
  // resolveModelOptions precedent: the impure localStorage read lives ONLY in defaultDeps, keeping
  // the dep interface narrow). Returns {budget}: 0 ("off") never auto-resumes; 1 ("once") grants a
  // single auto-resume. Absent (older fakes / the resume() path never calls it) ⇒ start() dispatches
  // NO QUOTA_BUDGET_SET, leaving the reducer's fail-closed 0 default (no auto-resume). The resume()
  // path NEVER reads this — it inherits the persisted ledger budget.
  resolveAutoResumeBudget?(): { budget: number };
}

// Bind the dependency interface to the real Tauri commands (the same `invoke` the rest of the code
// uses). Tests never call this — they inject a fake OrchestratorDeps instead.
export function defaultDeps(): OrchestratorDeps {
  return {
    startSession: (args) =>
      // Resolve the header-picker selection (reads localStorage directly) and forward
      // model/effort to Rust. Key-omission: `resolveModelOptions` returns a fresh
      // {model, effort?} with NO effort key when absent, so spreading it never sends
      // `effort: undefined`. The OrchestratorDeps.startSession interface stays narrow
      // ({cwd, permissionMode}) — this resolution lives only in the impure adapter.
      invoke("start_agent_session", {
        cwd: args.cwd,
        permissionMode: args.permissionMode,
        // RESUME (Phase 3): forward `resumeSessionId` only when present (key-omission otherwise, so a
        // fresh start never sends `resumeSessionId: undefined`). Rust maps it to `resume_session_id`.
        ...(args.resumeSessionId !== undefined ? { resumeSessionId: args.resumeSessionId } : {}),
        ...resolveModelOptions(),
      }).then(() => undefined),
    sendMessage: (text, images) =>
      invoke(
        "send_agent_message",
        images && images.length ? { text, images } : { text },
      ).then(() => undefined),
    setMode: (mode) => invoke("set_agent_permission_mode", { mode }).then(() => undefined),
    resolvePermission: (args) =>
      invoke("resolve_tool_permission", {
        id: args.id,
        allow: args.allow,
        message: args.message ?? null,
        updatedInput: args.updatedInput ?? null,
      }).then(() => undefined),
    cancelRun: () => invoke("cancel_agent_run").then(() => undefined),
    // Same Tauri command as cancelRun: `cancel_agent_run` IS the graceful q.interrupt() of the
    // current turn (agent.rs sends {type:"interrupt"} to the sidecar). See the interface comment.
    interrupt: () => invoke("cancel_agent_run").then(() => undefined),
    endSession: () => invoke("end_agent_session").then(() => undefined),
    writePlanTreeFile: (cwd, name, contents) =>
      invoke<string>("write_plan_tree_file", { cwd, name, contents }),
    deletePlanTreeFile: (cwd, name) =>
      invoke("delete_plan_tree_file", { cwd, name }).then(() => undefined),
    readPlanTreeFile: (cwd, name) =>
      invoke<string | null>("read_plan_tree_file", { cwd, name }),
    readPlanContents: (path) => invoke<string>("read_plan_contents", { path }),
    resetPlanTreeDir: (cwd) => invoke("reset_plan_tree_dir", { cwd }).then(() => undefined),
    ensurePrototypeDir: (cwd) => invoke<string>("ensure_prototype_dir", { cwd }),
    ensureBaselineDir: (cwd) => invoke<string>("ensure_baseline_dir", { cwd }),
    freezeBaseline: (cwd) => invoke<string>("freeze_baseline", { cwd }),
    openBaseline: (cwd, path) => invoke("open_baseline", { cwd, path }).then(() => undefined),
    writeAgentPlan: (plan, treeId, nnPath) =>
      invoke<string>("write_agent_plan", { plan, treeId, nn: nnPath }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    // PHASE 4 — fire `fn` whenever the document becomes visible again (the page un-occludes).
    // visibilitychange (not focus) is the WebView suspension boundary; we filter to the visible
    // edge so a hide event does not fire the wake. Guarded for non-DOM environments (tests inject
    // their own seam, but defaultDeps must not throw if document is absent).
    onWake: (fn) => {
      if (typeof document === "undefined") return () => {};
      const handler = (): void => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
    // PHASE 6 — resolve the composer's auto-resume choice (reads localStorage directly, key-omission
    // discipline) into the per-run budget start() dispatches as QUOTA_BUDGET_SET. The dep interface
    // stays narrow; this impure read lives ONLY here (the resolveModelOptions precedent).
    resolveAutoResumeBudget: () => resolveAutoResumeBudget(),
  };
}
