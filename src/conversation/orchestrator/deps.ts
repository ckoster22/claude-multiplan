// Multiplan orchestration — injected dependency interface + the real-Tauri-bound factory (leaf).
// Relocated verbatim from the former single-file orchestrator.ts (only import paths shifted).

import { invoke } from "@tauri-apps/api/core";
import { resolveModelOptions } from "../../model-picker";
import { resolveAutoResumeBudget } from "../../auto-resume-setting";
import type { AttachedImage } from "../images";
import type { WritePolicy } from "../plan-tree";


// ---- injected dependency interface (mirror ComposerInvoker) ---------------------------------

// Every Tauri command an Effect needs, wrapped so tests inject fakes. `defaultDeps()` binds these
// to real `invoke(...)`. Async throughout — the driver awaits each effect in order.
export interface OrchestratorDeps {
  // start_agent_session({ cwd, permissionMode, resumeSessionId? }). `resumeSessionId` (camelCase →
  // Rust `resume_session_id` → sidecar `"resume"`) is omitted when undefined ⇒ fresh session. start()
  // never passes it; resume() passes state.sdk_session_id (undefined → fresh expired-transcript path).
  startSession(args: { cwd: string; permissionMode: string; resumeSessionId?: string }): Promise<void>;
  // send_agent_message({ text }) — or { text, images } for the multimodal first-turn send. `images`
  // is omitted when empty: every text-only send forwards the byte-identical `{ text }` shape.
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
  // cancel_agent_run() — the TURN-INTERRUPT boundary. Sends `{type:"interrupt"}` → the SDK query's
  // interrupt(): the in-flight turn aborts and emits its terminal `result` (subtype
  // `error_during_execution`; the sidecar normalizes every subtype to `result`, so the resuming
  // consume-path accepts it). Distinct dep from cancelRun (same wire command) so call sites — and the
  // tests asserting interrupt is/isn't fired — read as intent, not teardown.
  interrupt(): Promise<void>;
  // end_agent_session()
  endSession(): Promise<void>;
  // plan_tree::write_plan_tree_file({ cwd, name, contents }) -> the absolute path written.
  writePlanTreeFile(cwd: string, name: string, contents: string): Promise<string>;
  // PHASE 6 — plan_tree::delete_plan_tree_file({ cwd, name }) — delete <cwd>/.plan-tree/<name>,
  // containment-guarded + allow-list-validated like writePlanTreeFile. Absent file ⇒ graceful no-op.
  // The refine branch clears each reset node's NN-plan.md / NN-summary.md for a clean re-run.
  // OPTIONAL so pre-Phase-6 fakes compile; absent ⇒ skip the delete (overwrite-on-re-run still corrects).
  deletePlanTreeFile?(cwd: string, name: string): Promise<void>;
  // plan_tree::read_plan_tree_file({ cwd, name }) -> the file's text, or null when absent (Rust
  // Option<String>). RESUME (Phase 3): reloads the non-serialized driver state (summaries, mandates)
  // from on-disk .plan-tree/ artifacts. OPTIONAL; absent ⇒ reload skipped (resumed run threads no
  // prior summaries/mandates — degraded, not broken).
  readPlanTreeFile?(cwd: string, name: string): Promise<string | null>;
  // read_plan_contents({ path }) -> the plan file's text. Unlike readPlanTreeFile (the `.plan-tree/`
  // allow-listed channel), this reads the PLANS STORE by absolute `~/.claude/plans/...` path — where
  // LEAF plans live (writeAgentPlan writes them there, NOT `.plan-tree/`). REJECTS (throws, not
  // Ok(None)) on a missing/out-of-bounds path. RESUME (Phase 3b): the leaf/executing audit-and-continue
  // verifies the leaf's durable plan through THIS, keyed by the node's absolute planPath (readPlanTreeFile
  // would always miss — wrong channel, and its allow-list rejects an absolute name). OPTIONAL; absent ⇒
  // durable check skipped (continuation trusts the node's planPath, as the gate path does).
  readPlanContents?(path: string): Promise<string>;
  // plan_tree::reset_plan_tree_dir({ cwd }) — archive every current <cwd>/.plan-tree/ entry into
  // .plan-tree/.archive/ (replacing any prior archive). Run by START before the genesis persist.
  resetPlanTreeDir(cwd: string): Promise<void>;
  // ensure_prototype_dir({ cwd }) -> the absolute prototype dir path. Creates
  // <cwd>/.plan-tree/prototype/ (idempotent) BEFORE the visual-mode intent prompt, so the clarifier
  // never needs Bash/mkdir (the "prototype" policy only allows writes UNDER the dir, not creating it).
  // OPTIONAL; absent ⇒ the driver skips the call.
  ensurePrototypeDir?(cwd: string): Promise<string>;
  // BASELINE FREEZE (Phase 3): create + populate <cwd>/.plan-tree/baseline/ when the user marks the
  // visual prototype a "working reference". ensureBaselineDir creates the dir; freezeBaseline
  // recursively copies the prototype subtree in (both containment-guarded). OPTIONAL; absent ⇒ skip the
  // freeze and record NO baseline_ (the presence record must match disk — recon still proceeds).
  ensureBaselineDir?(cwd: string): Promise<string>;
  freezeBaseline?(cwd: string): Promise<string>;
  // PHASE 5 — open a frozen-baseline artifact in the OS default handler (`open_baseline`; `path` is
  // relative to <cwd>/.plan-tree/baseline/, containment-guarded). The forced-acceptance gate calls
  // this so the user can exercise the baseline against the build. OPTIONAL; absent ⇒ the gate still
  // surfaces, just without the "open baseline" step.
  openBaseline?(cwd: string, path: string): Promise<void>;
  // write_agent_plan({ plan, treeId, nn }) -> the absolute path written. `nnPath` is null for the
  // root decomposition plan (flavor master), else the node's dotted PathKey string ("01", "02.01", …).
  // Rust takes Option<String> and REJECTS a bare JSON number — callers must send the string form.
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
  // PHASE 4 — INJECTABLE WAKE SEAM (optional — defaults to document.visibilitychange): a WebView
  // occluded through a quota wait suspends its in-page timers, so the quota timer may still be pending
  // when it un-occludes. This "page just woke" signal lets the quota machinery recompute remaining
  // time against the WALL CLOCK and resume if the reset already passed. Returns an unsubscribe fn
  // (called at teardown). Tests inject a fake capturing the callback to drive a wake without a DOM event.
  onWake?(fn: () => void): () => void;
  // PHASE 6 — INJECTABLE AUTO-RESUME BUDGET SEAM (optional). start() resolves the run's quota budget
  // through this and dispatches QUOTA_BUDGET_SET (the impure localStorage read lives ONLY in
  // defaultDeps, keeping the interface narrow). Returns {budget}: 0 ("off") never auto-resumes, 1
  // ("once") grants one. Absent ⇒ no QUOTA_BUDGET_SET, leaving the reducer's fail-closed 0 default.
  // resume() never reads this — it inherits the persisted ledger budget.
  resolveAutoResumeBudget?(): { budget: number };
}

// Bind the dependency interface to the real Tauri commands (the same `invoke` the rest of the code
// uses). Tests never call this — they inject a fake OrchestratorDeps instead.
export function defaultDeps(): OrchestratorDeps {
  return {
    startSession: (args) =>
      // Resolve the header-picker selection (reads localStorage) and forward model/effort to Rust.
      // resolveModelOptions returns {model, effort?} with NO effort key when absent, so spreading it
      // never sends `effort: undefined`. This impure resolution lives only in the adapter.
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
    // PHASE 4 — fire `fn` whenever the document becomes visible again. visibilitychange (not focus)
    // is the WebView suspension boundary; filter to the visible edge so a hide doesn't fire the wake.
    // Guarded for non-DOM environments (defaultDeps must not throw if document is absent).
    onWake: (fn) => {
      if (typeof document === "undefined") return () => {};
      const handler = (): void => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
    // PHASE 6 — resolve the composer's auto-resume choice (reads localStorage) into the per-run budget
    // start() dispatches as QUOTA_BUDGET_SET. This impure read lives ONLY here.
    resolveAutoResumeBudget: () => resolveAutoResumeBudget(),
  };
}
