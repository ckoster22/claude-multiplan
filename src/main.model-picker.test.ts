import { describe, it, expect, vi, beforeEach } from "vitest";

// Sub-Plan 03 — the reading-pane "Execution model" picker + the sidebar badge live-update, driven
// through the REAL main.ts consumer wiring. Mirrors main.orchestrator-gate.test.ts: install a real
// createOrchestrator(fakeDeps) as the shared singleton BEFORE booting the DOM (so main.ts subscribes
// to OUR handle), script a run to a held LEAF gate for child 01, then assert the picker the gate's
// openPlan mounted — segment state, recommendation, rationale — and that clicking a different model
// dispatches setExecutionModel with the resolved NodePath + triage-aligned options AND flips the
// sidebar badge / picker to the override state within the same session.

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };

const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    const path = (a.path as string) ?? "";
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nbody text here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve(H.store[path] ?? []);
    if (cmd === "get_comment_count") return Promise.resolve((H.store[path] ?? []).length);
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
import { parseNn, pathKey } from "./conversation/plan-tree";
import {
  createOrchestrator,
  __setOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorDeps,
  type OrchestratorHandle,
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

// A sub sidebar row for the live tree (tree_id + nn_path both required so it resolves to a live node).
function subRow(absPath: string, stem: string, treeId: string, nnPath: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: null,
    unread: false,
    flavor: "sub",
    tree_id: treeId,
    nn: Number(nnPath.split(".")[0]),
    nn_path: nnPath,
    child_count: null,
    collapsed: false,
    h1s: [],
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
        <div class="review-bar hidden" id="review-bar">
          <span id="review-bar-label"></span>
          <button id="review-submit" disabled>Submit feedback</button>
          <button id="review-clear">Clear comments</button>
          <button id="review-approve" class="hidden">Approve &amp; Build</button>
          <button id="review-resume"></button>
        </div>
        <div class="md" id="reading-pane"></div>
      </div>
      <div class="tab-pane" id="tab-conversation">
        <button class="conv-cancel" id="conversation-cancel"></button>
        <div class="conv-stream" id="conversation-stream"></div>
      </div>
    </div></main>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
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

// Script the installed handle to a held LEAF gate for child 01 (confident-single collapse, so no
// decomposition gate is held along the way), mirroring main.orchestrator-gate.test.ts. Sets H.rows
// AFTER start (once the real treeId is known) so the gate's sidebar refresh sees a row that resolves
// to the live node.
async function driveToLeafGate(h: OrchestratorHandle, planPath: string): Promise<void> {
  await h.start({ cwd: "/work", request: "do it" });
  const treeId = h.snapshot().treeId;
  H.rows = [subRow(planPath, "1", treeId, "01")];
  const dispatch = (e: PlanTreeEvent2) => h.dispatch(e);
  await dispatch({ type: "INTENT_CLARIFIED", intent: "i" });
  await dispatch({ type: "NODE_RECON_DONE", path: [] });
  await dispatch({ type: "SIZER_DONE", path: [], outcome: { decision: "single", confidence: 0.95, num_plans: 1, scale: "standard" } });
  await dispatch({ type: "NODE_RECON_DONE", path: [parseNn(1)] });
  await dispatch({ type: "NODE_DRAFTED", path: [parseNn(1)], toolUseId: "sub-1-tu", planPath, plansDirPath: "/p" });
  await flush();
}

beforeEach(() => {
  H.store = {};
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  __resetReviewStateForTest();
  __resetOrchestratorForTest();
});

describe("model picker — mounted for a live leaf node with the triaged recommendation", () => {
  it("shows the .on segment, recommendation, and rationale for a standard leaf (Sonnet/auto)", async () => {
    const planPath = "/p/01.md";
    const h = createOrchestrator(makeDeps());
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToLeafGate(h, planPath);
    await flush();

    // The gate opened the leaf plan; the picker is visible and mounted in the doc header.
    const bar = document.querySelector<HTMLElement>("#model-bar")!;
    expect(bar.classList.contains("hidden")).toBe(false);
    // The leaf's persisted model is Sonnet (standard scale) with source auto → Sonnet segment `.on`.
    const on = bar.querySelector<HTMLElement>(".seg button.on")!;
    expect(on.dataset.preset).toBe("sonnet-5");
    expect(on.classList.contains("sonnet")).toBe(true);
    // Auto (not overridden) → recommendation pill, NO "overridden by you".
    expect(bar.querySelector(".recpill")!.textContent).toBe("Recommended: Sonnet 5");
    expect(bar.querySelector(".overridden")).toBeNull();
    expect(bar.querySelector(".rationale")!.textContent).toContain("Coding execution");

    // The sidebar badge for this row reads Sonnet + auto.
    const badge = document.querySelector<HTMLElement>(`[data-path="${planPath}"] .mbadge`)!;
    expect(badge.classList.contains("sonnet")).toBe(true);
    expect(badge.querySelector(".rec")!.textContent).toBe("auto");
    expect(badge.classList.contains("override")).toBe(false);
  });

  it("clicking Fable dispatches setExecutionModel([01], {claude-fable-5, high}) and flips badge+picker to override", async () => {
    const planPath = "/p/01.md";
    const h = createOrchestrator(makeDeps());
    const spy = vi.spyOn(h, "setExecutionModel");
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToLeafGate(h, planPath);
    await flush();

    const bar = document.querySelector<HTMLElement>("#model-bar")!;
    const fableBtn = bar.querySelector<HTMLElement>('.seg button[data-preset="fable-5"]')!;
    fableBtn.click();
    await flush();

    // The dispatch carried the resolved NodePath (child 01) and the TRIAGE-ALIGNED options — Fable's
    // triage effort is "high", NOT the preset's "low". FALSIFY: dispatch the raw PRESET_OPTIONS (effort
    // "low") → the effort assertion goes RED.
    expect(spy).toHaveBeenCalledTimes(1);
    const [pathArg, optsArg] = spy.mock.calls[0];
    expect(pathKey(pathArg)).toBe("01");
    expect(optsArg).toEqual({ model: "claude-fable-5", effort: "high" });

    // Badge live-update: the row's badge flipped to the override state within the same session
    // (proves the guarded onSnapshot re-render). FALSIFY: remove the badge re-render in onSnapshot →
    // the badge stays sonnet/auto and this goes RED.
    const badge = document.querySelector<HTMLElement>(`[data-path="${planPath}"] .mbadge`)!;
    expect(badge.classList.contains("fable")).toBe(true);
    expect(badge.classList.contains("override")).toBe(true);
    expect(badge.querySelector(".rec")).toBeNull();

    // The picker re-rendered too: Fable `.on`, and the recommendation replaced by "overridden by you".
    const on = bar.querySelector<HTMLElement>(".seg button.on")!;
    expect(on.dataset.preset).toBe("fable-5");
    expect(bar.querySelector(".recpill")).toBeNull();
    expect(bar.querySelector(".overridden")!.textContent).toBe("overridden by you");
  });

  it("clicking the already-selected segment of an auto node is an inert no-op (no dispatch, stays auto)", async () => {
    const planPath = "/p/01.md";
    const h = createOrchestrator(makeDeps());
    const spy = vi.spyOn(h, "setExecutionModel");
    __setOrchestratorForTest(h);
    bootDom();
    await flush();

    await driveToLeafGate(h, planPath);
    await flush();

    const bar = document.querySelector<HTMLElement>("#model-bar")!;
    // The leaf is Sonnet/auto, so Sonnet is the `.on` segment. Clicking it must NOT dispatch —
    // otherwise the reducer would irreversibly flip auto→override for no change. FALSIFY: drop the
    // self-no-op guard in renderModelBar's click handler → this expectation goes RED.
    const sonnetBtn = bar.querySelector<HTMLElement>('.seg button[data-preset="sonnet-5"]')!;
    expect(sonnetBtn.classList.contains("on")).toBe(true);
    sonnetBtn.click();
    await flush();

    expect(spy).not.toHaveBeenCalled();
    // The node is still auto: recommendation pill present, no "overridden by you", badge reads auto.
    expect(bar.querySelector(".recpill")).not.toBeNull();
    expect(bar.querySelector(".overridden")).toBeNull();
    const badge = document.querySelector<HTMLElement>(`[data-path="${planPath}"] .mbadge`)!;
    expect(badge.querySelector(".rec")!.textContent).toBe("auto");
    expect(badge.classList.contains("override")).toBe(false);

    // But a DIFFERENT segment still dispatches — the guard is a self-no-op, not a global block.
    const fableBtn = bar.querySelector<HTMLElement>('.seg button[data-preset="fable-5"]')!;
    fableBtn.click();
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pathKey(spy.mock.calls[0][0])).toBe("01");
    expect(spy.mock.calls[0][1]).toEqual({ model: "claude-fable-5", effort: "high" });
  });
});
