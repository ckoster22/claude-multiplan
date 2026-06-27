import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// the Selection union + resolveSelection (the sidebar selection model).
//
// `openPath` is now a DERIVED GETTER over a single `selection` source of truth
// (none | plan | sentinel | placeholder). After EVERY refreshList, `resolveSelection` runs:
//   • a `plan` selection whose path VANISHED from list_plans collapses to `none` — the ghost
//     reading pane is reset to the empty state (this is the NEW behaviour these tests pin).
//   • `sentinel` and `placeholder` selections are EXEMPT (a live run / a resume sentinel standing
//     in for a not-yet-listed tree must survive), as is a `plan` selection that IS the held
//     orchestrator gate's plan (its sidebar row can lag the write — the placeholder stands in).
//
// We boot the real main.ts against an invoke/listen shim and drive `refreshList` by firing a
// `plan-changed` event (the production path), exactly like main.resume-banner.test.ts.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
  // When true, list_plans REJECTS (models a transient IPC failure) so the refreshList catch path is
  // exercised.
  listPlansRejects: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    if (cmd === "list_plans") {
      if (H.listPlansRejects) return Promise.reject(new Error("transient list_plans failure"));
      return Promise.resolve(H.rows);
    }
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nbody here\n");
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(0);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    if (cmd === "read_plan_transcript")
      return Promise.resolve({ found: false, path: null, cwd: null, session_id: null, lines: [] });
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

import { __resetReviewStateForTest, __setRunPlaceholderForTest, __setOpenPathForMock } from "./main";
import {
  installMockOrchestrator,
  emitApprovalGate,
  __getMockObserversForTest,
} from "./mock/orchestrator";
import { __resetOrchestratorForTest, __setActiveOrchestratorForTest } from "./conversation/orchestrator";

function planRow(absPath: string, stem: string, treeId: string | null = null): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: "/work",
    unread: false,
    flavor: "standalone",
    tree_id: treeId,
    nn: null,
    nn_path: null,
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
        <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
        <div class="resume-banner hidden" id="resume-banner">
          <span id="resume-banner-msg"></span>
          <button id="resume-plan-btn" class="hidden">Resume</button>
          <span class="resume-confirm hidden" id="resume-confirm">
            <span id="resume-hazard"></span>
            <button id="resume-confirm-btn">Confirm</button>
            <button id="resume-cancel-btn">Cancel</button>
          </span>
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
    <div class="toast hidden" id="toast"></div>
    <div class="conv-modal hidden" id="composer-modal">
      <textarea id="composer-request"></textarea>
      <input id="composer-dir" />
      <button id="composer-choose-dir"></button>
      <button id="composer-start"></button>
      <button id="composer-cancel"></button>
      <div class="conv-auth hidden" id="composer-auth"><input id="composer-token" /><button id="composer-token-submit"></button></div>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 24): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Fire a (production) plan-changed event for an unrelated path → handlePlanChanged → refreshList.
async function fireUnrelatedPlanChanged(): Promise<void> {
  const handlers = H.listeners["plan-changed"] ?? [];
  expect(handlers.length, "main.ts registered a plan-changed listener").toBeGreaterThan(0);
  for (const h of handlers) h({ payload: { path: "/home/u/.claude/plans/unrelated.md" } });
  await flush();
}

const PLAN = "/home/u/.claude/plans/p.md";

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  H.listPlansRejects = false;
  __resetReviewStateForTest();
  __resetOrchestratorForTest();
  __setActiveOrchestratorForTest(null);
  document.body.innerHTML = "";
});

describe("selection collapse closes the ghost pane", () => {
  // Open a plan, then make it vanish from list_plans → resolveSelection collapses to `none` and
  // the reading pane resets to the empty state. RED before the union/resolveSelection exists:
  // today refreshList leaves the dangling pane painted.
  it("collapses an open plan to the empty pane when its file vanishes from list_plans", async () => {
    H.rows = [planRow(PLAN, "p")];
    installMockOrchestrator();
    bootDom();
    await flush();

    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    // Precondition: the plan is open (header shown, row active, no empty-state).
    expect(document.querySelector(".doc-header")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector(`[data-path="${PLAN}"].active`)).not.toBeNull();
    expect(document.querySelector("#reading-pane .empty-state")).toBeNull();

    // The plan's file vanishes from the list; an unrelated change drives refreshList.
    H.rows = [];
    await fireUnrelatedPlanChanged();

    // Collapsed: header hidden, no active row, pane reset to the select-a-plan empty state.
    expect(document.querySelector(".doc-header")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("[data-path].active")).toBeNull();
    expect(document.querySelector("#reading-pane .empty-state")).not.toBeNull();
  });

  // (regression guard) — a TRANSIENT list_plans FAILURE must NOT collapse the open plan. The
  // catch path used to substitute `records = []`, which flowed into the SAME collapse (prevRecords has
  // P, records=[] ⇒ "vanished") and blanked the pane the user is reading. A fetch error must be a
  // NO-OP for selection + pane. RED before the fix (pane blanked); GREEN after.
  it("does NOT collapse the open plan when list_plans transiently fails (fetch error is a no-op)", async () => {
    H.rows = [planRow(PLAN, "p")];
    installMockOrchestrator();
    bootDom();
    await flush();

    document.querySelector<HTMLElement>(`[data-path="${PLAN}"]`)!.click();
    await flush();
    expect(document.querySelector(`[data-path="${PLAN}"].active`)).not.toBeNull();
    expect(document.querySelector(".doc-header")!.classList.contains("hidden")).toBe(false);

    // list_plans REJECTS on the next refresh (transient IPC failure); an unrelated change drives it.
    H.listPlansRejects = true;
    await fireUnrelatedPlanChanged();

    // The open plan is untouched: still active, header still shown, pane NOT reset to empty-state.
    expect(
      document.querySelector(`[data-path="${PLAN}"].active`),
      "open plan stays active after a transient list_plans failure",
    ).not.toBeNull();
    expect(document.querySelector(".doc-header")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#reading-pane .empty-state")).toBeNull();
  });

  // REGRESSION GUARD — a live-run placeholder selection must SURVIVE a refreshList whose list_plans
  // omits its tree (the run has no real row yet). Over-collapsing (blanking the placeholder variant
  // too) makes the placeholder row vanish + the pane reset → this goes RED.
  it("does NOT collapse a live-run placeholder selection when its tree is absent", async () => {
    H.rows = [];
    installMockOrchestrator();
    bootDom();
    await flush();

    // A run minted + selected its placeholder (no real row exists for it yet).
    __setRunPlaceholderForTest({ treeId: "tree-live", label: "New plan — drafting…" }, true);

    H.rows = [];
    await fireUnrelatedPlanChanged();

    const list = document.querySelector<HTMLElement>("#plan-list")!;
    const ph = list.querySelector<HTMLElement>(".plan.placeholder");
    expect(ph, "placeholder row survives the refreshList").not.toBeNull();
    // DISTINGUISHING signal: an over-collapse resolves `placeholder` → `none`, dropping the
    // placeholder's `.active` (resetToEmptyPane sets selection=none, so ph.selected goes false). A
    // correct exemption keeps it the active selection. (The pane was never rendered in this isolated
    // run, so its boot empty-state is NOT a reliable collapse signal — assert `.active` instead.)
    expect(ph!.classList.contains("active"), "placeholder stays the active selection").toBe(true);
  });

  // REGRESSION GUARD (load-bearing) — the held orchestrator gate's plan must NOT collapse
  // even after it was LISTED and then DROPPED from list_plans while the gate is held (its row can lag /
  // churn mid-hold; the placeholder stands in). This exercises the heldGatePlan exemption GENUINELY:
  // the gate plan is in prevRecords (so wasListed=true) and absent from the new list (stillListed=
  // false), so ONLY the `heldGatePlan` guard prevents the collapse. Deleting that guard makes this RED.
  it("does NOT collapse the held gate's plan after it was listed then dropped (heldGatePlan exemption)", async () => {
    const GATE = "/home/u/.claude/plans/gate-plan.md";
    // The gate plan IS listed first, so the boot refreshList puts it in lastRecords (→ prevRecords).
    H.rows = [planRow(GATE, "gate-plan")];
    installMockOrchestrator();
    bootDom();
    await flush();

    // Align the selection to the gate plan + fan a held approval gate for it (pendingApproval.planPath
    // = GATE, active). VIEWING in-process: #review-approve visible.
    __setOpenPathForMock(GATE);
    emitApprovalGate(GATE);
    await flush();
    const approve = document.querySelector<HTMLElement>("#review-approve")!;
    expect(approve.classList.contains("hidden"), "bar is VIEWING the gate before the refresh").toBe(false);

    // The gate plan DROPS from list_plans while the gate is still held (was listed → now gone).
    H.rows = [];
    await fireUnrelatedPlanChanged();

    // DISTINGUISHING signal: without the heldGatePlan guard this is a genuine vanish (wasListed &&
    // !stillListed) → collapse → openPath null → viewingGate() stops matching → Approve hides. The
    // guard keeps the selection, so the in-process VIEWING bar survives.
    expect(
      approve.classList.contains("hidden"),
      "held gate plan must NOT collapse after it was listed-then-dropped — VIEWING bar survives",
    ).toBe(false);
    expect(__getMockObserversForTest().length).toBeGreaterThan(0);
  });
});
