import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------------------------
// Plan-review UX — OPTION A: a review OPENS THE REAL plan file through the normal plan-open flow.
//
// The redesign (the invariant fix):
//   • A review's plan is a REAL file under ~/.claude/plans/ (its absolute path rides on the payload
//     as `plan_file_path`). Handling a review REFRESHES the sidebar and OPENS that file via openPlan,
//     so the plan's sidebar row is SELECTED (`[data-path].active`) — no more detached IPC-text render
//     with no selection (the bug this file's INVARIANT test pins, red→green in the report).
//   • Review comments are just the opened plan's NORMAL persisted comments (keyed on its real path).
//     There is no synthetic in-memory store.
//   • Browse freely: a pending review NEVER traps navigation. Opening another plan shows it and leaves
//     the review pending; the bar drops to SUMMARY mode (count + Resume). Resume reopens + reselects it.
//   • Submit → respond_to_review decision "deny" + buildFeedbackPrompt(open plan's comments), removes
//     it from pending.
//   • Un-openable: an empty plan_file_path (or an open that throws) is REFUSED — the review is dropped
//     from pending (so it is not counted) and the failure is surfaced on #hook-status; it is NEVER
//     rendered as an unactionable detached phantom.
//
// This test uses the REAL ./render facade (NOT mocked) so the genuine save→IO→fireCountChanged path
// runs end-to-end. The backend is a shared in-memory comment store keyed by REAL plan path; every
// comment-command + respond_to_review invoke is recorded so the persistence + decision invariants are
// checkable.
// ---------------------------------------------------------------------------------------------

type Rec = { quote: string; comment: string; block_line: number | null; block_end_line: number | null; occurrence: number; id: number };
type Review = { schema: number; review_id: string; session_id: string; cwd: string; transcript_path: string; plan_text: string; plan_file_path: string; created_ms: number };

// Hoisted shared state: the backend comment store (keyed by real plan path), a record of EVERY invoke
// call, the pending-reviews fixture, the captured respond_to_review responses, the list_plans rows,
// and a registry of the listen() handlers so tests can FIRE plan-review events.
const H = vi.hoisted(() => ({
  store: {} as Record<string, Rec[]>,
  invokeCalls: [] as Array<{ cmd: string; path: string }>,
  pendingReviews: [] as Review[],
  responses: [] as Array<{ reviewId: string; decision: string; reason: string }>,
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  // Sidebar rows list_plans returns. Tests push a row for a review's plan_file_path so openPlan can
  // select it (the invariant). A PlanRecord-ish shape sufficient for renderSidebar.
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { path?: string; comments?: Rec[]; reviewId?: string; decision?: string; reason?: string }) => {
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
    if (cmd === "respond_to_review") {
      H.responses.push({ reviewId: args?.reviewId ?? "", decision: args?.decision ?? "", reason: args?.reason ?? "" });
      return Promise.resolve(undefined);
    }
    // set_open_plan / mark_viewed / resolve_cwds / focus_main_window / etc. — resolve benignly.
    return Promise.resolve(undefined);
  }),
}));
// The listen mock records each handler by event name so a test can dispatch a synthetic event.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    H.listeners[name] = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./titlebar", () => ({ initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() }));
// NOTE: ./render is intentionally NOT mocked — we need the real comments save/clear IO path.

import { openPlan, reviewCommentCount, __resetReviewStateForTest } from "./main";
import { asAbsPath, asStem } from "./types";
import {
  createOrchestrator,
  __setOrchestratorForTest,
  __resetOrchestratorForTest,
  type OrchestratorDeps,
  type OrchestratorHandle,
} from "./conversation/orchestrator";
import type { PrototypeGate } from "./conversation/plan-tree";

// Recording fake OrchestratorDeps (mirrors main.orchestrator-gate.test.ts) — every effect is a
// benign async no-op; the prototype double-submit test only needs the handle's state machine to
// reach a held pendingPrototype gate, then spies on the handle's refinePrototype method directly.
function makeOrchDeps(): OrchestratorDeps {
  return {
    startSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    writePlanTreeFile: vi.fn(async (_cwd, name) => `/abs/.plan-tree/${name}`),
    writeAgentPlan: vi.fn(async (_plan, _treeId, nn) => `/p/${nn}.md`),
    resetPlanTreeDir: vi.fn(async () => {}),
  };
}

// Install a fresh orchestrator handle, boot, and drive it to a held visual-prototype gate (root
// open/clarifying-intent → prototype-review, holding pendingPrototype). main.ts's onSnapshot puts the
// review bar into PROTOTYPE mode, where Approve ("Approve visual") is ALWAYS enabled and Submit
// ("Request changes") enables on non-empty feedback. Returns the handle so the test can spy on it.
async function bootToPrototypeGate(): Promise<OrchestratorHandle> {
  const h = createOrchestrator(makeOrchDeps());
  __setOrchestratorForTest(h); // main.ts's getOrchestrator() subscribes to OUR handle at boot
  bootDom();
  await flush();
  await h.start({ cwd: "/work", request: "build a widget" });
  await flush();
  const gate: PrototypeGate = {
    kind: "ascii",
    paths: [],
    screenshot: null,
    inlinePreview: "preview body",
    variants: [],
    round: 1,
    cwd: "/work",
  };
  await h.dispatch({ type: "PROTOTYPE_READY", gate });
  await flush();
  return h;
}

// Build a minimal standalone PlanRecord row for list_plans so renderSidebar emits a [data-path] row.
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
      <button id="theme-toggle"></button>
    </div></div>
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

// Fire a synthetic plan-review-requested event through the captured listener (the real wiring runs).
// `planFilePath` defaults to a real plans-dir path; tests push the matching list_plans row first.
async function fireReviewRequested(
  reviewId: string,
  planFilePath: string,
  planText = "# plan\n\nselect this phrase here\n",
): Promise<void> {
  H.listeners["plan-review-requested"]?.({
    payload: { review_id: reviewId, plan_text: planText, plan_file_path: planFilePath },
  });
  await flush();
}

// Fire a synthetic plan-review-cancelled event.
async function fireReviewCancelled(reviewId: string): Promise<void> {
  H.listeners["plan-review-cancelled"]?.({ payload: { review_id: reviewId } });
  await flush();
}

// Select the occurrence-th match of `needle` inside `block` as the live window selection.
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

// Add an inline comment to whatever is currently rendered in the pane via the REAL popover flow.
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
  // Module state (pendingReviews) persists across tests in a vitest file and re-booting the DOM does
  // not reset it. Clear it so each test starts clean.
  __resetReviewStateForTest();
  // Reset the shared orchestrator singleton to a fresh inactive default so a prior test's installed
  // handle (the prototype double-submit test installs one) cannot leak into the next test.
  __resetOrchestratorForTest();
});

// ---------------------------------------------------------------------------------------------
// INVARIANT (the bug we're fixing): a review OPENS + SELECTS the real plan file in the sidebar.
// ---------------------------------------------------------------------------------------------
describe("review-opens-real-file invariant — the reviewed plan is selected in the sidebar", () => {
  it("after plan-review-requested with a plan_file_path that has a sidebar row: pane shows that plan AND its row is active", async () => {
    const path = "/home/u/.claude/plans/Feature-X.md";
    H.rows = [planRow(path, "Feature-X")];
    bootDom();
    await flush();

    await fireReviewRequested("rev-inv", path);
    await flush();

    // The reading pane shows the REAL plan (its header filename = the file's basename).
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Feature-X.md");
    // INVARIANT: the sidebar row for that plan is SELECTED (.active). This is what was BROKEN before
    // (a detached render had no selected row). Inverting the open/select in main.ts makes this RED.
    const row = document.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
    expect(row).not.toBeNull();
    expect(row.classList.contains("active")).toBe(true);
    // The bar is in VIEWING mode (the open plan IS the pending review).
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// CORE FIX — navigation is NEVER trapped by a pending review.
// ---------------------------------------------------------------------------------------------
describe("navigation-unstick — opening another plan while a review is pending does NOT trap or resolve", () => {
  it("shows the other plan, leaves the review pending, drops the bar to SUMMARY, and Resume reopens + reselects it", async () => {
    const reviewPath = "/home/u/.claude/plans/Reviewed.md";
    H.rows = [planRow(reviewPath, "Reviewed"), planRow("/home/u/.claude/plans/Other.md", "Other")];
    bootDom();
    await flush();

    // A review arrives while nothing is being viewed → opens + selects the real reviewed plan.
    await fireReviewRequested("rev-nav", reviewPath);
    await flush();
    const bar = document.querySelector<HTMLElement>("#review-bar")!;
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    const resume = document.querySelector<HTMLButtonElement>("#review-resume")!;
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(false); // viewing mode → Submit visible

    // Navigate to ANOTHER plan. The plan renders, the review stays pending, the bar enters SUMMARY.
    await openPlan(asAbsPath("/home/u/.claude/plans/Other.md"), asStem("Other"));
    await flush();

    expect(document.querySelector("#doc-filename")!.textContent).toBe("Other.md");
    // The OTHER plan's row is active; the reviewed plan's row is NOT.
    expect(document.querySelector<HTMLElement>(`[data-path="/home/u/.claude/plans/Other.md"]`)!.classList.contains("active")).toBe(true);
    expect(document.querySelector<HTMLElement>(`[data-path="${reviewPath}"]`)!.classList.contains("active")).toBe(false);
    // No respond_to_review was sent — the hook is untouched.
    expect(H.responses).toHaveLength(0);
    // Bar is in SUMMARY mode.
    expect(bar.classList.contains("hidden")).toBe(false);
    expect(submit.classList.contains("hidden")).toBe(true);
    expect(resume.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#review-bar-label")!.textContent).toBe("1 plan awaiting review");

    // RESUME re-opens + reselects the still-pending reviewed plan (back to viewing mode).
    resume.click();
    await flush();
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Reviewed.md");
    expect(document.querySelector<HTMLElement>(`[data-path="${reviewPath}"]`)!.classList.contains("active")).toBe(true);
    expect(submit.classList.contains("hidden")).toBe(false);
    expect(resume.classList.contains("hidden")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Submit (deny) decision + removal from pending.
// ---------------------------------------------------------------------------------------------
describe("review action bar — Submit (deny) decision", () => {
  it("Submit sends decision 'deny' with the buildFeedbackPrompt reason (from the OPEN plan's comments), removes it from pending, hides the bar", async () => {
    const path = "/home/u/.claude/plans/Submit-Me.md";
    H.rows = [planRow(path, "Submit-Me")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-submit", path);

    addCommentViaPopover("please rename this section");
    await flush();
    expect(reviewCommentCount()).toBe(1);
    // The comment persisted to the REAL plan path (review comments are normal comments now).
    expect(H.store[path]).toBeDefined();
    expect(H.store[path]).toHaveLength(1);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(false); // enabled on the first comment
    submit.click();
    await flush();

    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].reviewId).toBe("rev-submit");
    expect(H.responses[0].decision).toBe("deny");
    // The reason was built from the comments BEFORE they were cleared — the feedback carries them.
    expect(H.responses[0].reason).toContain("please rename this section");
    expect(H.responses[0].reason).toContain("Please revise the plan based on this feedback:");
    // Removed from pending → bar hidden (no other reviews).
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Submit-Me.md");
  });

  // ---------------------------------------------------------------------------------------------
  // CHANGE 1 (FALSIFIABLE): Submit CLEARS the submitted plan's comments AFTER the deny lands.
  // ---------------------------------------------------------------------------------------------
  it("Submit clears the submitted plan's comments (clear_comments invoked for openPath; store + pane highlights emptied) AFTER the deny", async () => {
    const path = "/home/u/.claude/plans/Clear-On-Submit.md";
    H.rows = [planRow(path, "Clear-On-Submit")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-clear-submit", path);

    addCommentViaPopover("consume this comment");
    await flush();
    expect(H.store[path]).toHaveLength(1);
    // The highlight is present in the pane before submit.
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBeGreaterThan(0);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    submit.click();
    await flush();

    // The deny was sent with the comment in the reason (reason built BEFORE the clear).
    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].decision).toBe("deny");
    expect(H.responses[0].reason).toContain("consume this comment");

    // FALSIFIABLE assertion: clear_comments was invoked for the submitted plan's path, the backend
    // store for that path is empty, and the pane has no comment highlights. (Inverting the on-submit
    // clear in main.ts — i.e. not calling clearAllComments — turns all three of these RED.)
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(H.store[path]).toBeUndefined();
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBe(0);
    // The count/bar reflect zero (bar hidden because the only review was removed).
    expect(reviewCommentCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // CHANGE 2 (FALSIFIABLE): the MANUAL #review-clear button — two-click confirm clears, single arms.
  // ---------------------------------------------------------------------------------------------
  it("#review-clear: a SINGLE click only arms (does NOT clear); a SECOND click clears the plan's comments", async () => {
    const path = "/home/u/.claude/plans/Manual-Clear.md";
    H.rows = [planRow(path, "Manual-Clear")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-manual-clear", path);

    addCommentViaPopover("a comment to clear manually");
    await flush();
    expect(H.store[path]).toHaveLength(1);

    const clearBtn = document.querySelector<HTMLButtonElement>("#review-clear")!;
    // The button is visible in viewing mode with >=1 comment.
    expect(clearBtn.classList.contains("hidden")).toBe(false);

    // FIRST click: arms only — NO clear_comments invoke, comments still present.
    clearBtn.click();
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(false);
    expect(H.store[path]).toHaveLength(1);
    expect(clearBtn.classList.contains("confirming")).toBe(true);

    // SECOND click: confirms — clear_comments invoked for the plan, store emptied, highlights gone.
    clearBtn.click();
    await flush();
    expect(H.invokeCalls.some((c) => c.cmd === "clear_comments" && c.path === path)).toBe(true);
    expect(H.store[path]).toBeUndefined();
    expect(document.querySelectorAll("#reading-pane .cmt-hl").length).toBe(0);
    // No respond_to_review was sent — manual clear is independent of Submit.
    expect(H.responses).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------------------------
// First-comment Submit-enable (on the real plan's comment count).
// ---------------------------------------------------------------------------------------------
describe("review Submit button — enables on the FIRST inline comment", () => {
  it("Submit is disabled at 0 comments and ENABLES immediately after exactly one comment", async () => {
    const path = "/home/u/.claude/plans/First.md";
    H.rows = [planRow(path, "First")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-first", path);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(true); // 0 comments

    addCommentViaPopover("first and only comment");
    await flush();
    expect(reviewCommentCount()).toBe(1);
    expect(submit.disabled).toBe(false); // authoritative-count plumbing enables on the FIRST comment
  });
});

// ---------------------------------------------------------------------------------------------
// Cancellation — the open plan stays open; only the bar changes.
// ---------------------------------------------------------------------------------------------
describe("review cancellation — removes from pending, plan stays open", () => {
  it("a cancelled review is removed from pending and the bar hides if it was the only one; the plan stays open", async () => {
    const path = "/home/u/.claude/plans/Cancel.md";
    H.rows = [planRow(path, "Cancel")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-cancel", path);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Cancel.md");

    await fireReviewCancelled("rev-cancel");
    // Bar hides (no pending reviews) but the plan is STILL open + selected.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#doc-filename")!.textContent).toBe("Cancel.md");
    expect(document.querySelector<HTMLElement>(`[data-path="${path}"]`)!.classList.contains("active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Un-openable plan (empty plan_file_path) — REFUSE-and-surface, NOT a detached phantom.
// (The old "degraded detached render" left openPath null, so currentReviewId() stayed
// null → the bar fell to SUMMARY mode (Submit hidden, handlers bail on the null guards)
// while the dead review was STILL counted ("1 plan awaiting review"). It was un-actionable yet
// trapping. An un-openable review must be REFUSED — dropped from pending so it is not counted, with
// the failure surfaced on #hook-status — never rendered.)
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// a fast double-click on Submit must dispatch the deny EXACTLY once.
//
// The first click sets the bar to "submitting" (Submit visually disabled). But a disabled button is
// not a guarantee: a programmatically dispatched click still reaches the handler in jsdom (and a real
// fast double-click can land before the re-render). So the real invariant is an early-return guard in
// the handler keyed on an in-flight flag — NOT the disabled attribute. This test fires TWO synchronous
// clicks via dispatchEvent (which, unlike .click(), fires listeners even on a disabled button) BEFORE
// the first round-trip's awaited promise resolves, and asserts the underlying respond_to_review deny
// landed once. Exercises the EXTERNAL review submit path (the same path the "Submit (deny)" test uses).
// ---------------------------------------------------------------------------------------------
describe("review Submit — no double-submit on a fast double-click", () => {
  it("two synchronous #review-submit clicks dispatch the deny (respond_to_review) EXACTLY once", async () => {
    const path = "/home/u/.claude/plans/Double-Submit.md";
    H.rows = [planRow(path, "Double-Submit")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-double", path);

    addCommentViaPopover("a single comment");
    await flush();
    expect(reviewCommentCount()).toBe(1);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(false);

    // Two synchronous clicks BEFORE any awaited promise resolves. dispatchEvent (NOT .click()) is
    // deliberate: in jsdom .click() no-ops once the first click flips the button disabled, but
    // dispatchEvent still invokes listeners — isolating the submitInFlight early-return as the sole
    // defense (the visual disable cannot be what saves us).
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // EXACTLY ONE deny landed; the second click was swallowed by the in-flight guard.
    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].reviewId).toBe("rev-double");
    expect(H.responses[0].decision).toBe("deny");
  });

  // -------------------------------------------------------------------------------------------
  // FALSIFIABILITY-CLEAN PATH: the PROTOTYPE submit ("Request changes" → refinePrototype). Unlike
  // the external/viewing paths, PROTOTYPE mode is rendered by applyPrototypeBar, which derives the
  // Submit button's `disabled` SOLELY from the feedback textarea — it IGNORES submitInFlight, so the
  // button stays ENABLED while the first refine round-trips. That makes the top-of-handler early
  // return the ONLY thing preventing a second dispatch (the per-branch `reviewSubmitEl?.disabled`
  // guard cannot help here). Removing the early return makes this test fail with two dispatches —
  // i.e. it is a clean falsification target for the guard itself.
  it("two synchronous #review-submit clicks in PROTOTYPE mode call refinePrototype EXACTLY once", async () => {
    const h = createOrchestrator(makeOrchDeps());
    __setOrchestratorForTest(h); // main.ts's getOrchestrator() subscribes to OUR handle at boot
    bootDom();
    await flush();

    // Drive the handle to a held visual-prototype gate (root open/clarifying-intent → prototype-
    // review, holding pendingPrototype). main.ts's onSnapshot puts the bar into PROTOTYPE mode.
    await h.start({ cwd: "/work", request: "build a widget" });
    await flush();
    const gate: PrototypeGate = {
      kind: "ascii",
      paths: [],
      screenshot: null,
      inlinePreview: "preview body",
      variants: [],
      round: 1,
      cwd: "/work",
    };
    await h.dispatch({ type: "PROTOTYPE_READY", gate });
    await flush();

    // Spy on the handle's refinePrototype — the underlying action the prototype Submit dispatches.
    // Mock it to a no-op resolve so it does NOT advance the state machine (pendingPrototype stays
    // held, the textarea/button stay live), isolating the handler's exactly-once behavior.
    const refineSpy = vi.spyOn(h, "refinePrototype").mockResolvedValue(undefined);

    // Type non-empty feedback and re-derive so applyPrototypeBar enables Submit ("Request changes").
    const feedbackEl = document.querySelector<HTMLTextAreaElement>("#prototype-feedback")!;
    feedbackEl.value = "make it blue";
    feedbackEl.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    expect(submit.disabled).toBe(false);

    // Two synchronous clicks BEFORE the first refine round-trip resolves (dispatchEvent fires the
    // listener even on a disabled button — and here the button is not even disabled).
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // EXACTLY ONE refinePrototype dispatched; the second click hit the in-flight early return.
    expect(refineSpy).toHaveBeenCalledTimes(1);
    expect(refineSpy).toHaveBeenCalledWith("make it blue");

    await h.cancel();
  });

  // -------------------------------------------------------------------------------------------
  // A guard-REJECTED click must NOT leave submit stuck disabled. The in-flight flag is set only
  // AFTER each branch's validation guard, and reset in a finally on every exit — so a click that
  // bails on a guard (here: 0 comments → Submit disabled → the per-branch guard returns BEFORE the
  // flag is set) leaves submitInFlight false. We prove it by then submitting for real: if the
  // rejected click had stuck the flag true, the top-of-handler early return would swallow this
  // valid submit and zero denies would land.
  it("a guard-rejected (0-comment) click does NOT stick the in-flight lock — a later valid submit still fires", async () => {
    const path = "/home/u/.claude/plans/Not-Stuck.md";
    H.rows = [planRow(path, "Not-Stuck")];
    bootDom();
    await flush();
    await fireReviewRequested("rev-stuck", path);

    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    // 0 comments → Submit disabled. A click here is rejected by the per-branch guard.
    expect(submit.disabled).toBe(true);
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(H.responses).toHaveLength(0); // nothing dispatched (rejected) …

    // … and the lock did not stick: a real submit (after a comment enables it) lands exactly one deny.
    addCommentViaPopover("now there is a comment");
    await flush();
    expect(submit.disabled).toBe(false);
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(H.responses).toHaveLength(1);
    expect(H.responses[0].reviewId).toBe("rev-stuck");
  });

  // -------------------------------------------------------------------------------------------
  // SIBLING DEFECT (DA finding): the same fast-double-click defect class applies to #review-approve.
  // Empirically the unguarded handler double-DISPATCHES approvePrototype (the second call reaches the
  // handle and only throws "no pending gate" AFTER its first await — the gate/acceptance approve paths
  // have no such internal backstop, so a real second allow could land). We mock approvePrototype to a
  // no-op resolve so the gate stays held (isolating the HANDLER's exactly-once behavior), fire two
  // synchronous Approve clicks, and assert the action fired once. Removing the approve early-return
  // makes this RED with two calls — a clean falsification target for the approve guard.
  it("two synchronous #review-approve clicks in PROTOTYPE mode call approvePrototype EXACTLY once", async () => {
    const h = await bootToPrototypeGate();
    // Mock approvePrototype so it does NOT advance the state machine (pendingPrototype stays held, the
    // bar stays in PROTOTYPE mode with Approve enabled), isolating the handler's exactly-once guard.
    const approveSpy = vi.spyOn(h, "approvePrototype").mockResolvedValue(undefined);

    const approve = document.querySelector<HTMLButtonElement>("#review-approve")!;
    // PROTOTYPE-mode Approve ("Approve visual") is ALWAYS enabled and visible — no per-branch guard.
    expect(approve.classList.contains("hidden")).toBe(false);

    // Two synchronous clicks BEFORE the first approve round-trip resolves.
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // EXACTLY ONE approvePrototype dispatched; the second click hit the in-flight early return.
    expect(approveSpy).toHaveBeenCalledTimes(1);

    await h.cancel();
  });

  // -------------------------------------------------------------------------------------------
  // CROSS-BUTTON: Submit and Approve act on the SAME gate with OPPOSITE decisions. A fast Approve
  // (sets the lock) followed by a Submit must NOT both dispatch — the shared in-flight guard blocks
  // the second action regardless of which sibling button fired first.
  it("an Approve already in flight blocks a following #review-submit dispatch (no cross-button double-action)", async () => {
    const h = await bootToPrototypeGate();
    // With feedback present, BOTH the prototype Approve (combined apply-and-approve) and Submit
    // ("Request changes") route into refinePrototype. Make it never resolve so the lock the Approve
    // click sets is still held when the Submit click fires. The shared in-flight guard must swallow
    // the Submit so only ONE dispatch (the Approve's) lands.
    const refineSpy = vi
      .spyOn(h, "refinePrototype")
      .mockImplementation(() => new Promise<void>(() => {}));

    // Type feedback so Submit is enabled and Approve takes the apply-and-approve (refinePrototype) arc.
    const feedbackEl = document.querySelector<HTMLTextAreaElement>("#prototype-feedback")!;
    feedbackEl.value = "make it blue";
    feedbackEl.dispatchEvent(new Event("input", { bubbles: true }));

    const approve = document.querySelector<HTMLButtonElement>("#review-approve")!;
    const submit = document.querySelector<HTMLButtonElement>("#review-submit")!;
    approve.dispatchEvent(new MouseEvent("click", { bubbles: true })); // starts approve (lock held)
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true })); // must be swallowed by the lock
    await flush();

    // Only the Approve click's refinePrototype dispatched; the Submit was blocked by the shared lock.
    expect(refineSpy).toHaveBeenCalledTimes(1);

    await h.cancel();
  });
});

describe("un-openable review — empty plan_file_path refuses and surfaces (no unactionable phantom)", () => {
  it("with an empty plan_file_path the review is NOT rendered, NOT counted, and shows a #hook-status error", async () => {
    bootDom();
    await flush();

    await fireReviewRequested("rev-fallback", "", "# fallback plan\n\nselect this phrase here\n");
    await flush();

    // NOT rendered as a phantom: no "Plan review" header, the plan text is not shown in the pane.
    expect(document.querySelector("#doc-filename")!.textContent).not.toBe("Plan review");
    const pane = document.querySelector<HTMLElement>("#reading-pane")!;
    expect(pane.textContent ?? "").not.toContain("fallback plan");
    // NOT counted: the bar is fully hidden (pendingCount === 0). A counted phantom would show SUMMARY.
    expect(document.querySelector("#review-bar")!.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#review-bar-label")!.textContent).not.toContain("awaiting review");
    // The failure is surfaced on the existing #hook-status error affordance.
    const status = document.querySelector<HTMLElement>("#hook-status")!;
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.classList.contains("error")).toBe(true);
    expect(status.textContent!.length).toBeGreaterThan(0);
  });
});
