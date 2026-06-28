import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 3 — RemoteData migration of the SCALAR plan-save read (write_agent_plan) in main.ts's
// handleToolPermissionRequested (the in-process ExitPlanMode intercept).
//
// The write result is modeled as a ScalarRemoteData<string> and folded via matchScalar:
//   success(path) → the written path drives the post-write flow (register review + open + Plan tab),
//   error         → AUTO-DENY the held canUseTool seam (resolve_tool_permission allow:false) +
//                   surface #hook-status, register NO review.
// (An empty path is success(""), NOT zeroResults — a scalar write has no empty state.)
//
// This suite locks BOTH arms end-to-end by firing the REAL tool-permission-requested handler through a
// mocked Tauri seam (mirrors main.inproc-review.test.ts). ./render and ./conversation are REAL; the
// orchestrator is reset to INACTIVE so the handler's `if (isOrchestrationActive()) return;` guard does
// not pre-empt the legacy in-process path under test.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  listeners: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  rows: [] as Array<Record<string, unknown>>,
  writtenPath: "/home/u/.claude/plans/agent-plan.md",
  failWriteAgentPlan: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    const path = (a.path as string) ?? "";
    if (cmd === "write_agent_plan") {
      if (H.failWriteAgentPlan) return Promise.reject(new Error("disk full"));
      return Promise.resolve(H.writtenPath);
    }
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nselect this phrase here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "get_comment_count") return Promise.resolve(0);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    void path;
    // resolve_tool_permission / set_agent_permission_mode / set_open_plan / mark_viewed /
    // focus_main_window / … — recorded above, resolve benignly.
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
// ./render and ./conversation are intentionally REAL (the comment IO + facade listener run for real).

import { __resetReviewStateForTest } from "./main";
import {
  __resetOrchestratorForTest,
  __setActiveOrchestratorForTest,
} from "./conversation/orchestrator";

function planRow(absPath: string, stem: string): Record<string, unknown> {
  return {
    absolute_path: absPath,
    filename_stem: stem,
    mtime_ms: 1,
    cwd: null,
    unread: false,
    flavor: "standalone",
    tree_id: null,
    nn: null,
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

async function fireToolPermission(payload: {
  id: string;
  tool: string;
  input?: unknown;
  agent_id?: string | null;
}): Promise<void> {
  const ev = {
    payload: {
      seq: 1,
      kind: "tool_permission_requested",
      id: payload.id,
      tool: payload.tool,
      input: payload.input ?? {},
      agent_id: payload.agent_id ?? null,
    },
  };
  for (const h of H.listeners["tool-permission-requested"] ?? []) h(ev);
  await flush();
}

function calls(cmd: string): Array<Record<string, unknown>> {
  return H.invokeCalls.filter((c) => c.cmd === cmd).map((c) => c.args);
}

beforeEach(() => {
  H.invokeCalls = [];
  H.listeners = {};
  H.rows = [];
  H.writtenPath = "/home/u/.claude/plans/agent-plan.md";
  H.failWriteAgentPlan = false;
  __resetReviewStateForTest();
  __resetOrchestratorForTest();
  __setActiveOrchestratorForTest(null);
});

describe("write_agent_plan — scalar arm coverage in the ExitPlanMode intercept", () => {
  it("success arm: the resolved path drives the post-write flow (review registered, seam HELD)", async () => {
    const path = "/home/u/.claude/plans/agent-plan.md";
    H.writtenPath = path;
    H.rows = [planRow(path, "agent-plan")];
    bootDom();
    await flush();

    await fireToolPermission({ id: "tu_ok", tool: "ExitPlanMode", input: { plan: "# A real plan\n" }, agent_id: null });
    await flush();

    // write_agent_plan invoked once with the plan markdown; the success arm yielded its path.
    expect(calls("write_agent_plan")).toHaveLength(1);
    expect(calls("write_agent_plan")[0].plan).toBe("# A real plan\n");
    // The post-write flow ran: the review is registered (bar VIEWING, Approve shown) and the seam is
    // HELD (the only allow path is #review-approve — resolve_tool_permission was NOT called).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(false);
    // Falsifiable: if the success arm did not yield the path (e.g. returned null), the early return
    // would fire — no review, bar hidden, and these would flip.
    expect(calls("resolve_tool_permission")).toHaveLength(0);
  });

  it("error arm: a rejected write AUTO-DENIES the seam and registers NO review", async () => {
    H.failWriteAgentPlan = true; // make ONLY write_agent_plan reject.
    H.rows = [];
    bootDom();
    await flush();

    await fireToolPermission({ id: "tu_fail", tool: "ExitPlanMode", input: { plan: "# doomed\n" }, agent_id: null });
    await flush();

    // The error arm released the seam with a DENY (no hang).
    const resolves = calls("resolve_tool_permission");
    expect(resolves).toHaveLength(1);
    expect(resolves[0].id).toBe("tu_fail");
    expect(resolves[0].allow).toBe(false);
    // No review registered → the bar stays hidden, Approve hidden.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-approve")!.classList.contains("hidden")).toBe(true);
    // The failure is surfaced on the #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("error")).toBe(true);
    // Falsifiable: if the error arm did not run (e.g. success(path) folded the rejection), no DENY
    // would fire and resolve_tool_permission would be empty.
  });
});
