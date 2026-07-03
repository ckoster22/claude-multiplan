import { describe, it, expect, vi, beforeEach } from "vitest";

// The conversation-header live execution-model chip, driven through the REAL main.ts consumer wiring
// against the REAL orchestrator. Mirrors main.model-picker.test.ts: install a createOrchestrator(fakeDeps)
// as the shared singleton BEFORE booting the DOM (so main.ts subscribes to OUR handle), then drive the
// orchestrator through phases and assert the chip reflects the ACTIVE node's live model:
//   • recon phase  → Sonnet 5 · high (visible);
//   • sizing phase → Opus 4.8 · high;
//   • run terminates → hidden.
// The chip's model is the orchestrator's own effectiveModel resolution, so it cannot drift from the
// model the session actually runs.

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nbody text here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(0);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    (H.listeners[name] ??= []).push(handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { __resetReviewStateForTest } from "./main";
import { parseNn, type PlanTreeFilePath } from "./conversation/plan-tree";
import {
  createOrchestrator,
  __setOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorDeps,
  type PlanTreeEvent2,
} from "./conversation/orchestrator";

function makeDeps(): OrchestratorDeps {
  return {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_cwd, name) => `/abs/.plan-tree/${name}`),
    writeAgentPlan: vi.fn(async (_plan, _treeId, nn) => `/p/${nn}.md`),
    resetPlanTreeDir: vi.fn(async () => {}),
  };
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls">
      <button class="conv-new-plan" id="new-plan-btn"></button>
      <button id="theme-toggle"></button>
    </div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span>
      <div class="sidebar-status"><span class="conv-status" id="sdk-status"></span></div>
      <div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="reader-inner">
      <div class="tab-row reader-tab-row">
        <span class="tab active" data-tab="plan">Plan</span>
        <span class="tab" data-tab="conversation">Conversation</span>
      </div>
      <div class="tab-pane active" id="tab-plan">
        <div class="doc-header">
          <div id="doc-filename"></div><div id="doc-src"></div>
          <div class="modelbar hidden" id="model-bar"></div>
        </div>
        <div class="md" id="reading-pane"></div>
      </div>
      <div class="tab-pane" id="tab-conversation">
        <div class="conv-toolbar">
          <span class="conv-model-chip hidden" id="conversation-model-chip"></span>
          <button class="conv-pause" id="conversation-pause"></button>
          <button class="conv-resume" id="conversation-resume"></button>
          <button class="conv-cancel" id="conversation-cancel"></button>
        </div>
        <div class="conv-stream" id="conversation-stream"></div>
      </div>
    </div></main>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea>
      <input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <div id="composer-mode"><button class="conv-mode-btn active" data-mode="plan"></button><button class="conv-mode-btn" data-mode="acceptEdits"></button></div>
      <button id="composer-start"></button>
      <button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function chipEl(): HTMLElement {
  return document.querySelector<HTMLElement>("#conversation-model-chip")!;
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  __resetReviewStateForTest();
  __resetOrchestratorForTest();
});

describe("conversation-header model chip — tracks the ACTIVE session's live model", () => {
  it("recon-phase snapshot shows Sonnet 5 · high and the chip is visible", async () => {
    const h = createOrchestrator(makeDeps());
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await h.start({ cwd: "/work", request: "do it" });
    // INTENT_CLARIFIED moves the root open node into `recon` — the active node's phase model is
    // Sonnet 5 / high (research domain). FALSIFY: hardcode a different model in renderModelChip's
    // effectiveModel call → the name assertion goes RED.
    await h.dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
    await flush();

    const chip = chipEl();
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.classList.contains("sonnet")).toBe(true);
    expect(chip.querySelector(".cm-name")!.textContent).toBe("Sonnet 5");
    expect(chip.querySelector(".cm-effort")!.textContent).toBe("high");
    // The tooltip carries the phase's triage rationale ("why this model").
    expect(chip.title).toContain("research");
  });

  it("sizing-phase snapshot flips the chip to Opus 4.8 · high", async () => {
    const h = createOrchestrator(makeDeps());
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await h.start({ cwd: "/work", request: "do it" });
    await h.dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
    await flush();
    // Sonnet at recon…
    expect(chipEl().querySelector(".cm-name")!.textContent).toBe("Sonnet 5");

    // NODE_RECON_DONE([]) moves the root into `sizing` — the active node's phase model is Opus 4.8 /
    // high (reasoning domain). FALSIFY: hardcode Sonnet in renderModelChip → this flip goes RED.
    await h.dispatch({ type: "NODE_RECON_DONE", path: [] });
    await flush();

    const chip = chipEl();
    expect(chip.classList.contains("hidden")).toBe(false);
    expect(chip.classList.contains("opus")).toBe(true);
    expect(chip.querySelector(".cm-name")!.textContent).toBe("Opus 4.8");
    expect(chip.querySelector(".cm-effort")!.textContent).toBe("high");
  });

  it("hides the chip once the run terminates (no active session to report)", async () => {
    const h = createOrchestrator(makeDeps());
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    // Drive a confident-single-collapse run down to its one leaf, then all the way to completion.
    await h.start({ cwd: "/work", request: "do it" });
    const dispatch = (e: PlanTreeEvent2) => h.dispatch(e);
    await dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
    await dispatch({ type: "NODE_RECON_DONE", path: [] });
    await dispatch({ type: "SIZER_DONE", path: [], outcome: { decision: "single", confidence: 0.95, num_plans: 1, scale: "standard" } });
    await dispatch({ type: "NODE_RECON_DONE", path: [parseNn(1)] });
    // The live interactive-tool path holds the leaf's ExitPlanMode gate, then approve() executes it.
    await h.ingestPermission({
      seq: 1,
      kind: "tool_permission_requested",
      id: "sub-1-tu",
      tool: "ExitPlanMode",
      input: { plan: "sub 1 plan" },
      agent_id: null,
    } as never);
    await h.approve("01");
    await flush();

    // The run is live at the leaf — the chip is visible (a real active node exists).
    expect(chipEl().classList.contains("hidden")).toBe(false);

    // Finish the leaf: exec + summary completes the single-collapse root → onDone fires and drops the
    // snapshot. FALSIFY: remove the `!node` hide branch in renderModelChip → the chip stays visible
    // (or throws on the null node) and this assertion goes RED.
    await dispatch({ type: "EXEC_DONE", path: [parseNn(1)] });
    await dispatch({ type: "SUMMARY_WRITTEN", path: [parseNn(1)], summaryText: "s", summaryPath: "/p/1-summary.md" as PlanTreeFilePath });
    await flush();

    const chip = chipEl();
    expect(chip.classList.contains("hidden")).toBe(true);
    expect(chip.querySelector(".cm-name")).toBeNull();
    expect(chip.hasAttribute("title")).toBe(false);
  });
});
