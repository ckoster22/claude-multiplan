import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 2 RemoteData migration — the two COLLECTION reads in main.ts beyond list_plans:
//   A. the comment LIST as a PATH-KEYED RemoteData<CommentRecord[]> owned by the comments facade
//      (src/render/comments.ts) and driven by get_comments (load), set_comments (save), and
//      clear_comments (clearAll) — the SINGLE, path-keyed, no-split-brain model the render path reads.
//   B. list_pending_reviews (launch recovery) as RemoteData<ReviewRequest[]>.
//
// These tests use the REAL ./render facade (NOT mocked) so the genuine load/save/clear IO path runs
// end-to-end and actually drives the facade's per-path RemoteData model — exactly the way the app
// does. Migration A asserts against the REAL model via the facade accessor `__getCommentStateForTest`
// (paneEl + path), NOT a shadow copy. The backend is a shared in-memory comment store keyed by REAL
// plan path; every relevant invoke is serviced from H so the arm transitions are observable.
//
// Falsifiability (documented per test): each new arm assertion is paired with a concrete one-line
// inversion of the production code that turns it RED. Confirmed by temporarily applying the break.
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

import {
  openPlan,
  __getReviewListStateForTest,
  __resetReviewStateForTest,
} from "./main";
import { __getCommentStateForTest } from "./render";
import { asAbsPath, asStem } from "./types";

/** The pane element initComments was wired to (the REAL per-path comment model lives behind it). */
function readingPane(): HTMLElement {
  return document.querySelector<HTMLElement>("#reading-pane")!;
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
describe("Migration A — comment list as a path-keyed RemoteData<CommentRecord[]>", () => {
  it("populated load → success(data): opening a plan whose store has comments lands the model in `success`", async () => {
    const path = "/home/u/.claude/plans/Has-Comments.md";
    H.rows = [planRow(path, "Has-Comments")];
    H.store[path] = [{ quote: "select this phrase", comment: "c", block_line: 0, block_end_line: 0, occurrence: 0, id: 1 }];
    bootDom();
    await flush();

    await openPlan(asAbsPath(path), asStem("Has-Comments"));
    await flush();

    // The open-plan load (get_comments) parsed at the facade boundary (fromArray) → the model is
    // `success` carrying the one comment, read from the REAL per-path facade model.
    const st = __getCommentStateForTest(readingPane(), path);
    expect(st.kind).toBe("success");
    expect(st.kind === "success" ? st.data.length : -1).toBe(1);
    // FALSIFIABLE: drop the `cache.set(path, fromArray(recs))` adoption in the facade's loadCommentsFor
    // and the model never leaves `initial` → `success` here goes RED. (Confirmed.)
  });

  it("empty load → zeroResults: opening a plan with NO comments lands the model in `zeroResults` (the empty-comments state)", async () => {
    const path = "/home/u/.claude/plans/No-Comments.md";
    H.rows = [planRow(path, "No-Comments")];
    bootDom();
    await flush();

    await openPlan(asAbsPath(path), asStem("No-Comments"));
    await flush();

    // fromArray([]) routes the empty read to its OWN state, never success([]) or a stale `initial`.
    expect(__getCommentStateForTest(readingPane(), path).kind).toBe("zeroResults");
    // FALSIFIABLE: replace `fromArray(recs)` with `success(recs)` in the facade's loadCommentsFor and
    // the empty read folds to `success` → this `zeroResults` assertion goes RED. (Confirmed.)
  });

  it("no split-brain: get_comments (open load), set_comments (add), and clear_comments (clear) all drive the SAME path-keyed model", async () => {
    const path = "/home/u/.claude/plans/One-Model.md";
    H.rows = [planRow(path, "One-Model")];
    bootDom();
    await flush();

    // 1) get_comments via the open load (store empty) → zeroResults.
    await fireReviewRequested("rev-one-model", path);
    expect(__getCommentStateForTest(readingPane(), path).kind).toBe("zeroResults");

    // 2) set_comments via adding an inline comment → the SAME path entry flips to success(1).
    addCommentViaPopover("please rename this");
    await flush();
    expect(H.store[path]).toHaveLength(1); // backend actually mutated (set_comments landed)
    const afterAdd = __getCommentStateForTest(readingPane(), path);
    expect(afterAdd.kind).toBe("success");
    expect(afterAdd.kind === "success" ? afterAdd.data.length : -1).toBe(1);

    // 3) clear_comments via the two-click manual clear → the SAME path entry returns to zeroResults.
    const clearBtn = document.querySelector<HTMLButtonElement>("#review-clear")!;
    clearBtn.click(); // arms only
    await flush();
    clearBtn.click(); // confirms → clear_comments
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(__getCommentStateForTest(readingPane(), path).kind).toBe("zeroResults");

    // FALSIFIABLE: remove the cache adoptions in the facade's addComment (so the add never writes the
    // path entry) and step (2)'s `success(1)` assertion goes RED — the entry would stay `zeroResults`
    // from step (1), proving the add really flows through the one shared path-keyed model and not a
    // split-brain second array. (Confirmed.)
  });

  it("path-keyed: opening plan B does NOT clobber plan A's model entry (per-path, not a single global)", async () => {
    const pathA = "/home/u/.claude/plans/Plan-A.md";
    const pathB = "/home/u/.claude/plans/Plan-B.md";
    H.rows = [planRow(pathA, "Plan-A"), planRow(pathB, "Plan-B")];
    H.store[pathA] = [{ quote: "select this phrase", comment: "a", block_line: 0, block_end_line: 0, occurrence: 0, id: 1 }];
    // plan B has NO comments.
    bootDom();
    await flush();
    const pane = readingPane();

    await openPlan(asAbsPath(pathA), asStem("Plan-A"));
    await flush();
    const aAfterOpenA = __getCommentStateForTest(pane, pathA);
    expect(aAfterOpenA.kind).toBe("success");
    expect(aAfterOpenA.kind === "success" ? aAfterOpenA.data.length : -1).toBe(1);

    // Open plan B (empty) — its OWN entry is zeroResults.
    await openPlan(asAbsPath(pathB), asStem("Plan-B"));
    await flush();
    expect(__getCommentStateForTest(pane, pathB).kind).toBe("zeroResults");

    // Plan A's entry is UNTOUCHED by B's load — the model is keyed by path, not a single shared slot.
    const aAfterOpenB = __getCommentStateForTest(pane, pathA);
    expect(aAfterOpenB.kind).toBe("success");
    expect(aAfterOpenB.kind === "success" ? aAfterOpenB.data.length : -1).toBe(1);
    // FALSIFIABLE: collapse the facade's per-path `Map<string, RemoteData<…>>` to a single shared
    // RemoteData (drop the path key) and opening B overwrites the one slot → reading pathA after
    // opening B returns B's `zeroResults` → the final `success(1)` assertion goes RED. This is exactly
    // the write-only single-global `commentListState` sham that was removed. (Confirmed.)
  });
});

// ---------------------------------------------------------------------------------------------
// MIGRATION B — list_pending_reviews (launch recovery) as RemoteData<ReviewRequest[]>.
// ---------------------------------------------------------------------------------------------
describe("Migration B — list_pending_reviews as RemoteData<ReviewRequest[]>", () => {
  it("empty list → zeroResults (empty-review state): nothing is recovered and the bar stays hidden", async () => {
    H.pendingReviews = [];
    bootDom();
    await flush();

    expect(__getReviewListStateForTest().kind).toBe("zeroResults");
    // Behavior preserved: no review opened, bar hidden.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    // FALSIFIABLE: replace `fromArray(...)` with `success(...)` at the list_pending_reviews boundary and
    // the empty read folds to `success` → this `zeroResults` assertion goes RED. (Confirmed.)
  });

  it("populated list → success(data): a fresh pending review is parsed to `success` AND recovered (opened + bar shown)", async () => {
    const path = "/home/u/.claude/plans/Recovered.md";
    H.rows = [planRow(path, "Recovered")];
    H.pendingReviews = [review("rev-recover", path, Date.now())];
    bootDom();
    // Recovery chains refreshList → openPlan → refreshReviewBar; the bar-show is at the tail of
    // openPlan, several microtask turns past the point doc-filename is set, so flush generously.
    await flush(30);

    const st = __getReviewListStateForTest();
    expect(st.kind).toBe("success");
    expect(st.kind === "success" ? st.data.length : -1).toBe(1);
    // Behavior preserved: the success arm ran the recovery — the newest pending review's real plan
    // opened + selected and the bar is showing.
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Recovered.md");
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    // FALSIFIABLE: make the `success` fold arm a no-op (skip recovery) and the open/selected + bar
    // assertions go RED while the array still parses — proving the recovery rides the success arm.
    // (Confirmed.)
  });
});
