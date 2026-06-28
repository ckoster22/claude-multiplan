import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Phase 3 — RemoteData migration of the SCALAR comment-COUNT read (get_comment_count).
//
// The count is modeled as a ScalarRemoteData<number> in main.ts and folded via matchScalar:
//   success(n) → commit the count (an EMPTY count is success(0), NEVER zeroResults),
//   error       → read failed: leave the last-good count in place (no clobber), as before.
// The existing `countReqSeq` latest-wins guard is preserved UNCHANGED and stays OUTSIDE the
// RemoteData fold (it gates the success arm's `commentCount = success(n)` write).
//
// This suite drives the REAL refreshCommentCount → currentCommentCount path through a mocked Tauri
// seam (mirrors main.feedback.test.ts's controllable get_comment_count deferreds):
//
//   1. THE stale-clobber freshness invariant for the NEW RemoteData write path: two overlapping
//      refreshCommentCount calls where the OLDER get_comment_count resolves LAST must NOT clobber the
//      newer count — the seq gate still fences the RemoteData success arm's commit.
//        FALSIFIABLE: dropping the `if (seq !== countReqSeq) return;` gate in refreshCommentCount lets
//        the stale older read's matchScalar success arm commit `success(1)`, so currentCommentCount()
//        reads 1 → this test goes red. (Verified manually: deleting that one line flipped this test to
//        FAIL — the stale 1 landed; reverted.)
//
//   2. success arm: a resolved get_comment_count number commits and currentCommentCount() reflects it.
//   3. error  arm: a rejected get_comment_count is handled AS TODAY — the last-good count survives
//      (the error arm never clobbers commentCount), not reset to 0.
// ---------------------------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const H = vi.hoisted(() => ({
  // get_comment_count control:
  //   "queue"   → hand back a fresh deferred per call (the freshness race resolves out of order),
  //   "resolve" → resolve immediately with `countValue` (success-arm test),
  //   "reject"  → reject immediately (error-arm test).
  countMode: "resolve" as "queue" | "resolve" | "reject",
  countValue: 0,
  countQueue: [] as Array<Deferred<number>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_comment_count") {
      if (H.countMode === "reject") return Promise.reject(new Error("count read failed"));
      if (H.countMode === "queue") {
        const d = deferred<number>();
        H.countQueue.push(d);
        return d.promise;
      }
      return Promise.resolve(H.countValue);
    }
    if (cmd === "list_plans") return Promise.resolve([]);
    if (cmd === "read_plan_contents") return Promise.resolve("# plan\n");
    if (cmd === "get_comments") return Promise.resolve([]);
    if (cmd === "list_pending_reviews") return Promise.resolve([]);
    if (cmd === "resolve_cwds") return Promise.resolve({});
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./render", () => ({
  renderInto: vi.fn(),
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
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));

import { refreshCommentCount, currentCommentCount, __setOpenPathForMock } from "./main";

function bootDom(): void {
  document.body.innerHTML = `
    <div class="tab-row"><span class="tab" data-tab="plans">Plans</span></div>
    <div class="tab-pane" id="tab-plans"><span id="plan-count"></span><div class="plan-list" id="plan-list"></div></div>
    <div class="tab-pane" id="tab-contents"><div class="toc-list" id="toc-list"></div></div>
    <main id="reader-scroll"><div class="md" id="reading-pane"></div></main>
    <div class="doc-header"><div id="doc-filename"></div><div id="doc-src"></div></div>`;
  (document.querySelector("#reader-scroll") as HTMLElement).scrollTo = () => {};
  window.dispatchEvent(new Event("DOMContentLoaded"));
}

async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  H.countMode = "resolve";
  H.countValue = 0;
  H.countQueue.length = 0;
  // Clear selection/openPath so a prior test's open plan cannot bleed into the next.
  __setOpenPathForMock(null);
});

describe("refreshCommentCount — the RemoteData count write passes through the countReqSeq freshness gate", () => {
  it("an OLDER get_comment_count resolving LAST does NOT clobber the newer count (newest wins)", async () => {
    H.countMode = "queue";
    bootDom();
    await flush();
    H.countQueue.length = 0; // drain anything the boot path enqueued.

    // A plan is open so refreshCommentCount does not short-circuit on a null openPath.
    __setOpenPathForMock("/p/X.md");

    // Fire two overlapping refreshes for the open plan: #0 (older, seq N+1), #1 (newer, seq N+2).
    void refreshCommentCount();
    void refreshCommentCount();
    await flush();
    expect(H.countQueue.length).toBe(2);

    // Resolve the NEWER request first → its success arm commits success(5).
    H.countQueue[1].resolve(5);
    await flush();
    expect(currentCommentCount()).toBe(5);

    // Now resolve the STALE OLDER request LAST. Its seq is behind countReqSeq, so the gate returns
    // BEFORE the matchScalar success arm runs → commentCount must NOT become success(1).
    H.countQueue[0].resolve(1);
    await flush();
    expect(currentCommentCount(), "newest count survives — stale older read is dropped").toBe(5);
  });
});

describe("refreshCommentCount — scalar arm coverage", () => {
  it("success: a resolved count commits (currentCommentCount reflects the number)", async () => {
    H.countMode = "resolve";
    H.countValue = 0; // first establish a known baseline.
    bootDom();
    await flush();

    __setOpenPathForMock("/p/A.md");
    H.countValue = 4;
    await refreshCommentCount();
    await flush();
    // Falsifiable: if the success arm did not commit `success(n)`, this would stay at the baseline.
    expect(currentCommentCount()).toBe(4);
  });

  it("error: a rejected count is handled as today — the last-good count survives (no clobber to 0)", async () => {
    bootDom();
    await flush();

    // Establish a known last-good count of 6 via a successful read.
    __setOpenPathForMock("/p/B.md");
    H.countMode = "resolve";
    H.countValue = 6;
    await refreshCommentCount();
    await flush();
    expect(currentCommentCount()).toBe(6);

    // Now the read FAILS. The error arm must NOT clobber the holder.
    H.countMode = "reject";
    await refreshCommentCount();
    await flush();
    // Falsifiable: if the error arm wrote `commentCount = failure(...)`, unwrapOr would read 0 here.
    expect(currentCommentCount(), "a failed read leaves the last-good count in place").toBe(6);
  });
});
