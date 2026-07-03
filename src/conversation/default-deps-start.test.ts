// Falsifiable test for the ONE seam the picker reaches the wire through: the
// real `defaultDeps().startSession` adapter. The orchestrator core's
// OrchestratorDeps.startSession interface stays narrow ({cwd, permissionMode}) —
// the model/effort resolution lives ONLY in this impure adapter, which reads
// localStorage directly via resolveModelOptions(). The orchestrator unit tests
// inject FAKE deps and never exercise defaultDeps, so without this test the
// frontend→Rust wire would be uncovered (cf. the documented "green mocked tests
// hid a cross-boundary bug" failure mode).
//
// We mock @tauri-apps/api/core's `invoke` so we can assert exactly what
// `start_agent_session` receives, and drive a known preset through jsdom's
// localStorage.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MODEL_PRESET_KEY } from "../model-picker";
import { AUTO_RESUME_KEY } from "../auto-resume-setting";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { defaultDeps } from "./orchestrator";

// jsdom's bundled localStorage is a non-functional stub in this harness (it warns
// `--localstorage-file was provided without a valid path` and lacks setItem/clear).
// Install a tiny Map-backed Storage so the real adapter's resolveModelOptions() —
// which reads the GLOBAL localStorage — sees our persisted preset.
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("defaultDeps().startSession forwards the resolved picker model/effort to Rust", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage(),
      configurable: true,
      writable: true,
    });
  });

  it("forwards the persisted preset's model + effort alongside cwd/permissionMode", async () => {
    // Persist a non-default preset so a wrong (default) value would be detectable.
    localStorage.setItem(MODEL_PRESET_KEY, "fable-5");

    const deps = defaultDeps();
    await deps.startSession({ cwd: "/tmp/proj", permissionMode: "plan" });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // FALSIFY: drop the `...resolveModelOptions()` spread in the adapter → the args
    // object lacks model/effort → RED.
    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-fable-5",
      effort: "low",
    });
  });

  it("forwards the sonnet-5 preset's model + effort (falsifies the roster rename)", async () => {
    // Persist the renamed sonnet preset: a stale "claude-sonnet-4-6" model in
    // PRESET_OPTIONS["sonnet-5"] would surface here as the wrong wire arg.
    localStorage.setItem(MODEL_PRESET_KEY, "sonnet-5");

    const deps = defaultDeps();
    await deps.startSession({ cwd: "/tmp/proj", permissionMode: "plan" });

    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-sonnet-5",
      effort: "medium",
    });
  });

  it("falls back to the default preset (Opus 4.8 / high) when nothing is persisted", async () => {
    // Opus's effort resolves from the global plan-reader-opus-effort key (default
    // "high"); an empty store resolves Opus → effort "high".
    const deps = defaultDeps();
    await deps.startSession({ cwd: "/tmp/proj", permissionMode: "plan" });

    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  it("an explicit per-phase execution model WINS over the persisted global preset (E1)", async () => {
    // Persist a global preset that MUST be ignored when the caller supplies `execution`: a wrong
    // adapter (`...resolveModelOptions()` ignoring args.execution) would surface the opus preset here.
    localStorage.setItem(MODEL_PRESET_KEY, "opus-4-8");

    const deps = defaultDeps();
    await deps.startSession({
      cwd: "/tmp/proj",
      permissionMode: "plan",
      execution: { model: "claude-fable-5", effort: "low" },
    });

    // FALSIFY: revert the adapter to `...resolveModelOptions()` (ignoring args.execution) → the wire
    // carries the opus global preset, not fable → RED.
    expect(invokeMock).toHaveBeenCalledWith("start_agent_session", {
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-fable-5",
      effort: "low",
    });
  });

  it("an explicit execution with NO effort omits the effort key (key-omission preserved)", async () => {
    const deps = defaultDeps();
    await deps.startSession({
      cwd: "/tmp/proj",
      permissionMode: "plan",
      execution: { model: "claude-sonnet-5" },
    });

    // The forwarded args must lack an `effort` key entirely — never `effort: undefined`.
    const call = invokeMock.mock.calls.find((c) => c[0] === "start_agent_session");
    expect(call?.[1]).toEqual({
      cwd: "/tmp/proj",
      permissionMode: "plan",
      model: "claude-sonnet-5",
    });
    expect(call?.[1] as object).not.toHaveProperty("effort");
  });
});

describe("defaultDeps().writeAgentPlan forwards the node's triaged execution model", () => {
  beforeEach(() => invokeMock.mockClear());

  it("forwards executionModel:{model, effort} to write_agent_plan", async () => {
    const deps = defaultDeps();
    await deps.writeAgentPlan("# plan\n", "tree-1", "01", {
      model: "claude-sonnet-5",
      effort: "medium",
    });

    // FALSIFY: drop the 4th-arg forwarding in the adapter → executionModel absent/null → RED.
    expect(invokeMock).toHaveBeenCalledWith("write_agent_plan", {
      plan: "# plan\n",
      treeId: "tree-1",
      nn: "01",
      executionModel: { model: "claude-sonnet-5", effort: "medium" },
    });
  });

  it("sends executionModel:null when the node carries no model (legacy fallback)", async () => {
    const deps = defaultDeps();
    await deps.writeAgentPlan("# master\n", "tree-1", null, null);

    expect(invokeMock).toHaveBeenCalledWith("write_agent_plan", {
      plan: "# master\n",
      treeId: "tree-1",
      nn: null,
      executionModel: null,
    });
  });
});

describe("defaultDeps().resolveAutoResumeBudget reads the persisted composer choice (Phase 6)", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeStorage(),
      configurable: true,
      writable: true,
    });
  });

  it("resolves the persisted 'off' choice to budget 0", () => {
    localStorage.setItem(AUTO_RESUME_KEY, "off");
    const deps = defaultDeps();
    // FALSIFY: drop the resolveAutoResumeBudget wiring in defaultDeps → seam undefined → RED.
    expect(deps.resolveAutoResumeBudget!()).toEqual({ budget: 0 });
  });

  it("resolves the persisted 'once' choice to budget 1", () => {
    localStorage.setItem(AUTO_RESUME_KEY, "once");
    const deps = defaultDeps();
    expect(deps.resolveAutoResumeBudget!()).toEqual({ budget: 1 });
  });

  it("falls back to the UI default (once → budget 1) when nothing is persisted", () => {
    const deps = defaultDeps();
    expect(deps.resolveAutoResumeBudget!()).toEqual({ budget: 1 });
  });
});

describe("defaultDeps().ensurePrototypeDir wires invoke('ensure_prototype_dir', { cwd })", () => {
  beforeEach(() => invokeMock.mockClear());

  it("forwards the cwd to the Rust command (the visual-prototype dir pre-create seam)", async () => {
    const deps = defaultDeps();
    await deps.ensurePrototypeDir!("/tmp/proj");
    // FALSIFY: rename the command or drop the arg in the adapter → RED.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ensure_prototype_dir", { cwd: "/tmp/proj" });
  });
});
