import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 3 — RemoteData migration of the READING-PANE reads (read_plan_contents, read_plan_tree_file).
//
// The reading-pane content (read_plan_contents) is modeled as a ScalarRemoteData<string> and folded
// via matchScalar; the optional INTENT.md placeholder read (read_plan_tree_file) is modeled via
// fromNullable and folded via match. This suite locks, driving the REAL openPlan → pane write through a
// mocked Tauri / `./render` seam (it does NOT lean on render-guard.test.ts, which exercises the guard
// helper in ISOLATION and never touches the real read_plan_contents → pane write):
//
//   1. THE stale-clobber freshness invariant for the NEW RemoteData write path: a slower OLDER read
//      resolving LAST must NOT clobber a newer render — the render-generation guard still fences the
//      write BEFORE the RemoteData success arm renders.
//        FALSIFIABLE: removing the post-read `if (!renderGuard.isCurrent(gen)) return;` gate in
//        openPlan's non-sentinel branch lets the older read's matchScalar success arm renderInto the
//        pane, so it reads "Plan A" → this test goes red. (Verified manually: deleting that one line
//        flipped this test to FAIL — "Plan A" landed; reverted.)
//
//   2. read_plan_contents rejection → the `error` arm paints the "Could not read plan: …" failure
//      state rendered today.
//
//   3. read_plan_tree_file (INTENT.md, the optional sentinel placeholder read) arms:
//        present → `success` renders the intent markdown; absent (null) → `zeroResults` renders the
//        static in-progress placeholder.
// ---------------------------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  // read_plan_contents control: "queue" parks each read on a deferred (so the race can resolve out of
  // order), "reject" rejects (error-arm test), "resolve" resolves immediately with `contentsText`.
  contentsMode: "resolve" as "queue" | "reject" | "resolve",
  contentsText: "# plan\n",
  readQueue: [] as Array<{ path: string; resolve: (v: string) => void }>,
  // read_plan_tree_file(INTENT.md): text when present, null when absent — drives the
  // success/zeroResults arms of the optional read.
  intentText: null as string | null,
  // list_plans rows (populate lastRecords so openPlan can resolve a sentinel row's cwd).
  rows: [] as Array<Record<string, unknown>>,
  invokeCalls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    H.invokeCalls.push({ cmd, args: a });
    if (cmd === "read_plan_contents") {
      if (H.contentsMode === "reject") return Promise.reject(new Error("boom: no such file"));
      if (H.contentsMode === "queue") {
        return new Promise<string>((resolve) => {
          H.readQueue.push({ path: (a.path as string) ?? "", resolve });
        });
      }
      return Promise.resolve(H.contentsText);
    }
    if (cmd === "read_plan_tree_file") {
      const name = (a.name as string) ?? "";
      if (name === "INTENT.md") return Promise.resolve(H.intentText);
      // state.json (resume detection) + everything else: no resumable tree → no banner.
      return Promise.resolve(null);
    }
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "get_comment_count") return Promise.resolve(0);
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "agent_auth_status") return Promise.resolve({ hasToken: true });
    if (cmd === "hook_status") return Promise.resolve(false);
    if (cmd === "read_plan_transcript")
      return Promise.resolve({ found: false, path: null, cwd: null, session_id: null, lines: [] });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// renderInto wraps the markdown verbatim in a <p> so pane.textContent === the rendered markdown
// (works for "# Plan A" AND the "_This plan is in progress…_" placeholder). settle + comments resolve
// immediately — the only race under test is the read_plan_contents await.
vi.mock("./render", () => ({
  renderInto: vi.fn((paneEl: HTMLElement, markdown: string) => {
    paneEl.innerHTML = `<p data-source-line="0">${markdown}</p>`;
    paneEl.classList.remove("raw");
  }),
  settle: vi.fn(() => Promise.resolve()),
  extractToc: vi.fn(() => []),
  applyComments: vi.fn(),
  initComments: vi.fn(),
  onCommentCountChanged: vi.fn(),
  loadCommentsFor: vi.fn(async () => []),
  clearAllComments: vi.fn(),
  invalidatePopover: vi.fn(),
}));
vi.mock("./render/scroll", () => ({
  captureAnchor: vi.fn(() => null),
  applyDelta: vi.fn(),
  scrollToHeading: vi.fn(),
}));
vi.mock("./titlebar", () => ({
  initTitlebar: vi.fn(),
  initThemeToggle: vi.fn(),
  initTextSize: vi.fn(),
}));

import { openPlan, __resetReviewStateForTest, __resetListStateForTest } from "./main";
import {
  __resetOrchestratorForTest,
  __setActiveOrchestratorForTest,
} from "./conversation/orchestrator";
import { asAbsPath, asStem } from "./types";

const CWD = "/work/project";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="tab-row">
      <span class="tab" data-tab="plans">Plans</span>
      <span class="tab" data-tab="contents">Contents</span>
    </div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span>
      <div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
  `;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

function pane(): HTMLElement {
  return document.querySelector<HTMLElement>("#reading-pane")!;
}

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  H.contentsMode = "resolve";
  H.contentsText = "# plan\n";
  H.readQueue.length = 0;
  H.intentText = null;
  H.rows = [];
  H.invokeCalls = [];
  // Module state persists across tests in a vitest file — clear selection/openPath, the list model,
  // and the orchestrator so a prior test cannot bleed into the next.
  __resetReviewStateForTest();
  __resetListStateForTest();
  __resetOrchestratorForTest();
  __setActiveOrchestratorForTest(null);
});

describe("openPlan — the read_plan_contents RemoteData write passes through the post-read render-generation guard", () => {
  it("a slower OLDER read resolving LAST does NOT clobber a newer render (newest content wins)", async () => {
    H.contentsMode = "queue";
    bootDom();
    await flush();

    // Open A first; let it clear set_open_plan + the post-set guard and PARK on its read_plan_contents.
    const openA = openPlan(asAbsPath("/p/A.md"), asStem("A"));
    await flush();
    expect(H.readQueue.length, "A should be parked on its read").toBe(1);

    // Open B AFTER A is already past the post-set guard — so the ONLY thing that can stop A clobbering
    // B is the post-READ freshness gate. B bumps the render generation, superseding A.
    const openB = openPlan(asAbsPath("/p/B.md"), asStem("B"));
    await flush();
    expect(H.readQueue.length, "B should now be parked on its own read").toBe(2);

    // Resolve B's read FIRST (B is current): B's content lands in the pane.
    H.readQueue[1].resolve("# Plan B");
    await openB;
    expect(pane().textContent).toContain("Plan B");

    // Now resolve the STALE A LAST. Its post-read isCurrent(genA) check is false → A must bail and
    // never render. With the gate removed, A's matchScalar success arm would renderInto "Plan A".
    H.readQueue[0].resolve("# Plan A");
    await openA;
    expect(pane().textContent, "newest render survives — stale A is dropped").toContain("Plan B");
    expect(pane().textContent).not.toContain("Plan A");
  });
});

describe("openPlan — a read_plan_contents rejection folds to the error arm", () => {
  it("paints the 'Could not read plan' failure state rendered today", async () => {
    H.contentsMode = "reject";
    bootDom();
    await flush();

    await openPlan(asAbsPath("/p/gone.md"), asStem("gone"));

    const p = pane();
    expect(p.classList.contains("raw"), "the error arm marks the pane raw").toBe(true);
    expect(p.textContent ?? "").toContain("Could not read plan");
    // Falsifiable: if the error arm did not paint (e.g. matchScalar's error arm were a no-op), the
    // pane would stay empty and both of these assertions would fail.
    expect(p.textContent ?? "").toContain("boom: no such file");
  });
});

describe("openPlan (sentinel) — read_plan_tree_file(INTENT.md) folds present→success / absent→zeroResults", () => {
  const SENTINEL_TREE = "tree-rdp-01";
  const SENTINEL_PATH = `plan-tree-resume://${SENTINEL_TREE}`;

  // A synthetic resume row as the backend mints it: childless master, sentinel path, cwd + title set.
  function sentinelRow(): Record<string, unknown> {
    return {
      absolute_path: SENTINEL_PATH,
      filename_stem: SENTINEL_TREE,
      mtime_ms: 5,
      cwd: CWD,
      unread: false,
      flavor: "master",
      tree_id: SENTINEL_TREE,
      nn: null,
      nn_path: null,
      child_count: 0,
      collapsed: false,
      h1s: ["Build the renderer"],
    };
  }

  it("present INTENT.md → the success arm renders the intent markdown", async () => {
    H.rows = [sentinelRow()];
    H.intentText = "# real intent\n\nthe original request\n";
    bootDom();
    await flush();

    await openPlan(asAbsPath(SENTINEL_PATH), asStem(SENTINEL_TREE));
    await flush();

    const intentRead = H.invokeCalls.find(
      (c) => c.cmd === "read_plan_tree_file" && c.args.name === "INTENT.md" && c.args.cwd === CWD,
    );
    expect(intentRead, "the sentinel pane reads INTENT.md from the tree's cwd").toBeTruthy();
    expect(pane().textContent ?? "").toContain("the original request");
    expect(pane().textContent ?? "").not.toContain("This plan is in progress");
  });

  it("absent INTENT.md (null) → the zeroResults arm renders the static in-progress placeholder", async () => {
    H.rows = [sentinelRow()];
    H.intentText = null; // read_plan_tree_file resolves null → fromNullable → zeroResults
    bootDom();
    await flush();

    await openPlan(asAbsPath(SENTINEL_PATH), asStem(SENTINEL_TREE));
    await flush();

    // Falsifiable: if fromNullable did not map null → zeroResults (e.g. success(null)), the success
    // arm would render "null" instead of the placeholder and this would fail.
    expect(pane().textContent ?? "").toContain("This plan is in progress");
  });
});
