import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 2 RemoteData migration — the two COLLECTION reads in main.ts beyond list_plans:
//   A. the comment LIST as a PATH-KEYED RemoteData<CommentRecord[]> owned by the comments facade
//      (src/render/comments.ts) and driven by get_comments (load), set_comments (save), and
//      clear_comments (clearAll) — the SINGLE, path-keyed, no-split-brain model the render path reads.
//   B. list_pending_reviews (launch recovery) as RemoteData<ReviewRequest[]>.
//
// These tests use the REAL ./render facade (NOT mocked) so the genuine load/save/clear IO path runs
// end-to-end and actually drives the facade's per-path comment model — exactly the way the app does.
// Migration A asserts through the OBSERVABLE surface (rendered `.cmt-hl` highlight spans + the backend
// comment store), NOT internal RemoteData arms. The backend is a shared in-memory comment store keyed
// by REAL plan path; every relevant invoke is serviced from H so the behavior is observable.
//
// Falsifiability (documented per test): each assertion is paired with a concrete one-line inversion of
// the production code that turns it RED. Confirmed by temporarily applying the break.
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };
type Review = { schema: number; review_id: string; session_id: string; cwd: string; transcript_path: string; plan_text: string; plan_file_path: string; created_ms: number };

const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  invokeCalls: [] as Array<{ cmd: string; path: string }>,
  pendingReviews: [] as Review[],
  responses: [] as Array<{ reviewId: string; decision: string; reason: string }>,
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { path?: string; comments?: Rec[] }) => {
    const path = args?.path ?? "";
    H.invokeCalls.push({ cmd, path });
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n\nselect this phrase here\n");
    if (cmd === "list_plans") return Promise.resolve(H.rows);
    if (cmd === "get_comments") return Promise.resolve(H.store[path] ?? []);
    if (cmd === "get_comment_count") return Promise.resolve((H.store[path] ?? []).length);
    if (cmd === "set_comments") {
      const next = args?.comments ?? [];
      if (next.length === 0) delete H.store[path];
      else H.store[path] = next;
      return Promise.resolve(next);
    }
    if (cmd === "clear_comments") {
      delete H.store[path];
      return Promise.resolve([]);
    }
    if (cmd === "resolve_cwds") return Promise.resolve({});
    if (cmd === "list_pending_reviews") return Promise.resolve(H.pendingReviews);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    H.listeners[name] = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));
// NOTE: ./render is intentionally NOT mocked — we need the real comments load/save/clear IO path.

import { openPlan, __resetReviewStateForTest } from "./main";
import { asAbsPath, asStem } from "./types";

/** The pane element initComments was wired to (the REAL per-path comment model lives behind it). */
function readingPane(): HTMLElement {
  return document.querySelector<HTMLElement>("#reading-pane")!;
}

/**
 * The number of DISTINCT comments highlighted in the reading pane right now, counted off the
 * observable DOM: every `.cmt-hl` span carries its comment's id in `data-c`, and a single multi-node
 * selection yields several SIBLING spans sharing one id, so we de-dupe by id. This is the
 * user-observable proxy for "how many comments are anchored on screen".
 */
function highlightCount(): number {
  const ids = new Set<string>();
  for (const el of readingPane().querySelectorAll<HTMLElement>(".cmt-hl")) {
    if (el.dataset.c) ids.add(el.dataset.c);
  }
  return ids.size;
}

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

function review(reviewId: string, planFilePath: string, createdMs: number): Review {
  return {
    schema: 1,
    review_id: reviewId,
    session_id: "s",
    cwd: "/work",
    transcript_path: "/t.jsonl",
    plan_text: "# plan\n\nselect this phrase here\n",
    plan_file_path: planFilePath,
    created_ms: createdMs,
  };
}

function bootDom(): void {
  document.body.innerHTML = `
    <div class="titlebar"><div class="titlebar-controls"><button id="theme-toggle"></button></div></div>
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span><div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>
    <div class="sel-popover hidden" id="sel-popover">
      <div id="sp-quote"></div><textarea id="sp-text"></textarea>
      <button id="sp-cancel"></button><button id="sp-save"></button>
    </div>
    <div class="review-bar hidden" id="review-bar">
      <span id="review-bar-label"></span>
      <textarea id="prototype-feedback" class="hidden"></textarea>
      <button id="review-submit" disabled></button>
      <button id="review-approve" class="hidden">Approve &amp; Build</button>
      <button id="prototype-open" class="hidden">Open in browser</button>
      <button id="review-clear">Clear comments</button>
      <button id="review-resume"></button>
    </div>
    <button id="hook-setup"></button><button id="hook-remove"></button>
    <span id="hook-status"></span>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function fireReviewRequested(reviewId: string, planFilePath: string): Promise<void> {
  H.listeners["plan-review-requested"]?.({
    payload: { review_id: reviewId, plan_text: "# plan\n\nselect this phrase here\n", plan_file_path: planFilePath },
  });
  await flush();
}

function selectText(block: Element, needle: string, occurrence: number): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let tn = walker.nextNode() as Text | null;
  while (tn) {
    let from = 0;
    while (true) {
      const idx = tn.data.indexOf(needle, from);
      if (idx < 0) break;
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + needle.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      seen++;
      from = idx + needle.length;
    }
    tn = walker.nextNode() as Text | null;
  }
}

function addCommentViaPopover(comment: string): void {
  const pane = document.querySelector<HTMLElement>("#reading-pane")!;
  const block = pane.querySelector("p[data-source-line]") ?? pane;
  selectText(block, "select this phrase", 0);
  pane.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  (document.querySelector("#sp-text") as HTMLTextAreaElement).value = comment;
  document.querySelector<HTMLElement>("#sp-save")!.click();
}

beforeEach(() => {
  H.store = {};
  H.invokeCalls = [];
  H.pendingReviews = [];
  H.responses = [];
  H.listeners = {};
  H.rows = [];
  __resetReviewStateForTest();
});

// ---------------------------------------------------------------------------------------------
// MIGRATION A — the comment list as ONE RemoteData<CommentRecord[]>.
// ---------------------------------------------------------------------------------------------
describe("Migration A — comment list as a path-keyed model behind the render facade", () => {
  it("opening a plan whose store has comments renders the persisted comment as a highlight", async () => {
    const path = "/home/u/.claude/plans/Has-Comments.md";
    H.rows = [planRow(path, "Has-Comments")];
    H.store[path] = [{ quote: "select this phrase", comment: "c", block_line: null, block_end_line: null, occurrence: 0, id: 1 }];
    bootDom();
    await flush();

    await openPlan(asAbsPath(path), asStem("Has-Comments"));
    await flush();

    // The open-plan load (get_comments) feeds applyComments, which re-anchors the persisted comment and
    // wraps its quoted text in a `.cmt-hl` span — the user-observable proof the comment was loaded.
    expect(highlightCount(), "the one persisted comment renders as a highlight").toBe(1);
    // FALSIFIABLE: have openPlan apply [] instead of the loaded records (or skip applyComments) and no
    // highlight wraps → this goes RED. (Confirmed.)
  });

  it("no split-brain: open load, in-pane add, and manual clear all drive the SAME on-screen comment + backend store", async () => {
    const path = "/home/u/.claude/plans/One-Model.md";
    H.rows = [planRow(path, "One-Model")];
    bootDom();
    await flush();

    // 1) Open the (empty) plan as a review → nothing highlighted, backend store empty.
    await fireReviewRequested("rev-one-model", path);
    expect(highlightCount(), "no comments on a freshly-opened empty plan").toBe(0);

    // 2) Add an inline comment via the popover → a highlight appears AND the backend store is mutated.
    addCommentViaPopover("please rename this");
    await flush();
    expect(highlightCount(), "the added comment renders as a highlight").toBe(1);
    expect(H.store[path]).toHaveLength(1); // backend actually mutated (set_comments landed)

    // 3) Clear via the two-click manual clear → the highlight is removed AND clear_comments lands.
    const clearBtn = document.querySelector<HTMLButtonElement>("#review-clear")!;
    clearBtn.click(); // arms only
    await flush();
    clearBtn.click(); // confirms → clear_comments
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(highlightCount(), "clearing removes the on-screen highlight").toBe(0);

    // FALSIFIABLE: make the facade's addComment skip its `wrapRange` (or clearAll skip clearHighlight)
    // and the highlight count after add/clear goes wrong → RED. The backend-store + clear_comments
    // assertions prove the add/clear flow through to the single backend source of truth, not a
    // split-brain second array.
  });

  it("comments are per-path: opening plan B (empty) clears A's highlight; switching back to A restores it", async () => {
    const pathA = "/home/u/.claude/plans/Plan-A.md";
    const pathB = "/home/u/.claude/plans/Plan-B.md";
    H.rows = [planRow(pathA, "Plan-A"), planRow(pathB, "Plan-B")];
    H.store[pathA] = [{ quote: "select this phrase", comment: "a", block_line: null, block_end_line: null, occurrence: 0, id: 1 }];
    // plan B has NO comments.
    bootDom();
    await flush();

    await openPlan(asAbsPath(pathA), asStem("Plan-A"));
    await flush();
    expect(highlightCount(), "A's persisted comment renders when A is open").toBe(1);

    // Open plan B (empty) — the pane re-renders B's content with NO highlight.
    await openPlan(asAbsPath(pathB), asStem("Plan-B"));
    await flush();
    expect(highlightCount(), "plan B has no comments → no highlight").toBe(0);

    // Switch back to A — A's comment re-anchors from its OWN path entry and the highlight reappears.
    await openPlan(asAbsPath(pathA), asStem("Plan-A"));
    await flush();
    expect(highlightCount(), "re-opening A restores A's highlight (comments are keyed by path)").toBe(1);
    // FALSIFIABLE: load comments off a single shared/last-opened path instead of the opened plan's path
    // and re-opening A after B would re-apply B's empty entry → A's highlight would not return → RED.
  });
});

// ---------------------------------------------------------------------------------------------
// MIGRATION B — list_pending_reviews (launch recovery) as RemoteData<ReviewRequest[]>.
// ---------------------------------------------------------------------------------------------
describe("Migration B — list_pending_reviews launch recovery", () => {
  it("empty pending-review list recovers nothing and leaves the review bar hidden", async () => {
    H.pendingReviews = [];
    bootDom();
    await flush();

    // Observable behavior: nothing recovered → no plan opened, the review bar stays hidden. The
    // internal empty-vs-error arm distinction is not user-observable (both recover nothing), so only
    // this behavior is asserted.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
  });

  it("a fresh pending review is recovered on launch — its plan opens and the review bar shows", async () => {
    const path = "/home/u/.claude/plans/Recovered.md";
    H.rows = [planRow(path, "Recovered")];
    H.pendingReviews = [review("rev-recover", path, Date.now())];
    bootDom();
    // Recovery chains refreshList → openPlan → refreshReviewBar; the bar-show is at the tail of
    // openPlan, several microtask turns past the point doc-filename is set, so flush generously.
    await flush(30);

    // Observable behavior: the recovery opened the newest pending review's real plan (selected) and
    // showed the bar.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Recovered.md");
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    // FALSIFIABLE: make the launch-recovery success fold a no-op (skip recovery) and the open/selected +
    // bar assertions go RED. (Confirmed.)
  });
});
