import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// The sidebar plan-list read modeled as RemoteData<PlanRecord[]> (Phase 2 migration). These tests
// pin the REFRESH lifecycle and the per-arm render the sidebar produces:
//   • initial load: initial -> fetching -> success | zeroResults | error
//   • in-place refresh (a watcher tick on an already-loaded list): NEVER paints a fetching/zeroResults
//     intermediate — the populated `success` list stays rendered while the next read is in flight, and
//     the data is replaced in place.
//   • rejected initial load: lands in the `error` arm (no last-good data); renders the empty sidebar.
//
// We boot the real main.ts against an invoke/listen shim and drive `refreshList` by firing a
// `plan-changed` event (the production path), exactly like main.selection.test.ts.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
  // When true, list_plans REJECTS (models a transient IPC failure).
  listPlansRejects: false,
  // Optional MANUAL gate for list_plans: when set, list_plans returns this promise instead of
  // resolving immediately, so a test can inspect the DOM WHILE a refresh is in flight.
  pendingList: null as null | Promise<unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    if (cmd === "list_plans") {
      if (H.listPlansRejects) return Promise.reject(new Error("transient list_plans failure"));
      if (H.pendingList) return H.pendingList;
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
vi.mock("./titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { __resetReviewStateForTest, __getListStateForTest, __resetListStateForTest } from "./main";
import { installMockOrchestrator } from "./mock/orchestrator";
import {
  __resetOrchestratorForTest,
  __setActiveOrchestratorForTest,
} from "./conversation/orchestrator";

function planRow(absPath: string, stem: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: "/work",
    unread: false,
    flavor: "standalone",
    tree_id: null,
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function rowCount(): number {
  return document.querySelectorAll("#plan-list [data-path]").length;
}

const P1 = "/home/u/.claude/plans/p1.md";
const P2 = "/home/u/.claude/plans/p2.md";

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  H.listPlansRejects = false;
  H.pendingList = null;
  __resetReviewStateForTest();
  // Module state persists across tests in a vitest file, so a prior test's success/zeroResults
  // listState would leak into the next test — making the "rejected INITIAL load" test inherit a
  // last-good (zeroResults) and (correctly) no-op the failure instead of surfacing the error arm.
  // Reset to a genuine `initial()` so each lifecycle test exercises a true initial load.
  __resetListStateForTest();
  __resetOrchestratorForTest();
  __setActiveOrchestratorForTest(null);
  document.body.innerHTML = "";
});

describe("sidebar plan-list as RemoteData<PlanRecord[]>", () => {
  // CORE refresh-lifecycle guard. After an initial successful load renders a POPULATED list, a
  // watcher-triggered (in-place) refresh must keep that `success` list rendered the whole time and
  // NEVER paint a `fetching`/`zeroResults` intermediate — both of those arms fold to the empty
  // sidebar, which would clear the rows mid-fetch.
  //
  // FALSIFIABILITY: the production guard `if (isInitial(listState))` in refreshList is what keeps the
  // in-place refresh from setting `fetching()` + rendering. Dropping that guard — i.e. setting
  // `listState = fetching(); applyFilterAndRender();` at the top of EVERY refresh — repaints the empty
  // fetching render while `list_plans` is in flight, so the mid-flight assertion below (rows still
  // present) goes RED. (Confirmed: temporarily removing the guard makes this test fail; restoring it
  // makes it pass.) The same mid-flight assertion also catches a spurious `zeroResults` reset, since
  // zeroResults folds to the same empty render.
  it("list-refresh-never-renders-fetching-in-place", async () => {
    // Initial load: two real plans render as a populated list (RemoteData `success`).
    H.rows = [planRow(P1, "p1"), planRow(P2, "p2")];
    installMockOrchestrator();
    bootDom();
    await flush();
    expect(rowCount(), "initial load renders both rows (success)").toBe(2);
    const st0 = __getListStateForTest();
    expect(st0.kind, "after a populated initial load the state is success").toBe("success");

    // A watcher tick triggers an IN-PLACE refresh, but list_plans is HELD in flight so we can inspect
    // the DOM mid-refresh.
    const d = deferred<unknown>();
    H.pendingList = d.promise;
    for (const h of H.listeners["plan-changed"] ?? []) {
      h({ payload: { path: "/home/u/.claude/plans/unrelated.md" } });
    }
    await flush(); // let refreshList run up to the (still-pending) list_plans await

    // MID-FLIGHT: the populated success list is unchanged — no fetching/zeroResults flash cleared it.
    expect(
      rowCount(),
      "in-place refresh keeps the populated list mid-flight (no fetching/zeroResults flash)",
    ).toBe(2);
    expect(
      __getListStateForTest().kind,
      "in-place refresh does NOT revert the state to fetching while in flight",
    ).toBe("success");

    // Resolve the in-flight read with the same populated rows: the data is replaced in place, the
    // state stays success, and the rows remain rendered (never a zeroResults flash on the way through).
    H.pendingList = null;
    d.resolve([planRow(P1, "p1"), planRow(P2, "p2")]);
    await flush();
    expect(rowCount(), "after the in-place refresh resolves, the populated list remains").toBe(2);
    expect(__getListStateForTest().kind, "still success after the refresh").toBe("success");
  });

  // ARM COVERAGE: a populated read -> `success` -> the list renders.
  it("populated list_plans renders the success list", async () => {
    H.rows = [planRow(P1, "p1"), planRow(P2, "p2")];
    installMockOrchestrator();
    bootDom();
    await flush();

    expect(__getListStateForTest().kind, "populated read parses to success").toBe("success");
    expect(rowCount()).toBe(2);
    expect(document.querySelector<HTMLElement>("#plan-count")!.textContent).toBe("2 files");
  });

  // ARM COVERAGE: an empty read -> `zeroResults` -> the empty-state (no rows, "0 files").
  it("empty list_plans renders the zeroResults empty-state", async () => {
    H.rows = [];
    installMockOrchestrator();
    bootDom();
    await flush();

    expect(__getListStateForTest().kind, "empty read parses to zeroResults").toBe("zeroResults");
    expect(rowCount()).toBe(0);
    expect(document.querySelector<HTMLElement>("#plan-count")!.textContent).toBe("0 files");
  });

  // ARM COVERAGE: a rejected INITIAL load (no last-good data) lands in the `error` arm. There is no
  // sidebar error UI, so the documented behavior is the empty sidebar — but the state is `error`, NOT
  // `fetching`/`initial`. FALSIFIABILITY: if the catch did not set `failure()` when there is no
  // last-good, the state would remain `fetching` and the `.kind === "error"` assertion goes RED.
  it("rejected initial load surfaces the error arm (empty sidebar, no error UI)", async () => {
    H.listPlansRejects = true;
    installMockOrchestrator();
    bootDom();
    await flush();

    expect(__getListStateForTest().kind, "a rejected initial load lands in the error arm").toBe(
      "error",
    );
    expect(rowCount(), "no rows render (no error UI exists)").toBe(0);
    // The reading pane stays at the boot empty-state — the transient-list-failure no-op leaves the
    // selection/pane untouched (no plan was ever opened).
    expect(document.querySelector("#plan-list [data-path].active")).toBeNull();
  });
});
