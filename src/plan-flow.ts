// The plan-flow SINK: opening a plan into the reading pane, live-reloading it, and the plan-review /
// gate open flows that route through it. Only `main` imports this module (re-exported via the shim);
// these functions pull the main-resident DOM-handle table (K2) and compose sites (K3) through an
// injection seam so nothing here reaches back into `./main` — imports stay one-directional
// (`main → controller → app-state`/leaf; controllers never import `./main`).

import { invoke } from "@tauri-apps/api/core";
import {
  initial,
  fromNullable,
  failure,
  success,
  match as foldRemoteData,
  matchScalar,
  type RemoteData,
  type ScalarRemoteData,
} from "./remote-data";
import { renderInto, settle, applyComments, loadCommentsFor, invalidatePopover } from "./render";
import { captureAnchor, applyDelta } from "./render/scroll";
import { rebuildTocFromPane } from "./render/toc";
import { resolvedCwdFor, dirOf, stemFromPath } from "./cwd";
import { isResumeSentinel, resumeSentinelTreeId } from "./resume-banner";
import { renderModelBar } from "./model-bar";
import { refreshCommentCount, setHookStatus } from "./review-bar";
import { RenderGuard } from "./render-guard";
import {
  setSelection,
  openPath,
  pendingReviews,
  type PendingReview,
  type PendingSurface,
} from "./app-state";
import { asAbsPath, type AbsPath, type PlanRecord, type Stem } from "./types";

// ---- init-injection seam ----------------------------------------------------------------------
// The main-resident state, DOM handles, and cross-domain entry points the moved plan-flow logic
// reaches through, supplied once by `main` via `initPlanFlow`. Injected as LIVE GETTER CLOSURES (never
// by value): `getLoadPlanHistory` in particular reads a main `let` that is assigned ASYNCHRONOUSLY
// after initPlanFlow runs, so a by-value capture would freeze `null` forever and silently kill history
// reconstruction. Default to null/no-op closures so a unit test that never calls initPlanFlow still
// gets well-defined behavior.
export interface PlanFlowDeps {
  // Late-bound / shared: read live at the call site, never captured by value.
  getLoadPlanHistory: () => ((stem: Stem) => void) | null;
  getRenderGuard: () => RenderGuard;
  getHookStatusEl: () => HTMLElement | null;
  // K2 DOM handles (assigned once in DOMContentLoaded; read via getters).
  getReadingPaneEl: () => HTMLElement | null;
  getReaderScrollEl: () => HTMLElement | null;
  getPlanListEl: () => HTMLElement | null;
  getDocHeaderEl: () => HTMLElement | null;
  getDocFilenameEl: () => HTMLElement | null;
  getTocListEl: () => HTMLElement | null;
  // Main-resident functions the movers call.
  patchDocSrc: () => void;
  markViewed: (path: AbsPath) => Promise<void>;
  refreshList: () => Promise<void>;
  resolveReview: (reviewId: string, decision: "allow" | "deny", reason: string) => Promise<boolean>;
  switchToPlanTab: () => void;
  refreshReviewBar: (countOverride?: number) => void;
  refreshAffordances: () => void;
  pendingSurfaces: () => PendingSurface[];
  currentRecords: () => PlanRecord[];
  hookStatusMs: number;
}

let deps: PlanFlowDeps = {
  getLoadPlanHistory: () => null,
  getRenderGuard: () => new RenderGuard(),
  getHookStatusEl: () => null,
  getReadingPaneEl: () => null,
  getReaderScrollEl: () => null,
  getPlanListEl: () => null,
  getDocHeaderEl: () => null,
  getDocFilenameEl: () => null,
  getTocListEl: () => null,
  patchDocSrc: () => {},
  markViewed: async () => {},
  refreshList: async () => {},
  resolveReview: async () => false,
  switchToPlanTab: () => {},
  refreshReviewBar: () => {},
  refreshAffordances: () => {},
  pendingSurfaces: () => [],
  currentRecords: () => [],
  hookStatusMs: 0,
};

export function initPlanFlow(d: PlanFlowDeps): void {
  deps = d;
}

// Open a plan: read raw text into #reading-pane, mark the row active, update the header.
// Mutates the module singletons selection / commentCount / renderGuard and the reading-pane
// DOM-handle lets.
export async function openPlan(path: AbsPath, stem: Stem): Promise<void> {
  const readingPaneEl = deps.getReadingPaneEl();
  if (!readingPaneEl) return;
  const renderGuard = deps.getRenderGuard();
  const planListEl = deps.getPlanListEl();
  const docHeaderEl = deps.getDocHeaderEl();
  const docFilenameEl = deps.getDocFilenameEl();
  const readerScrollEl = deps.getReaderScrollEl();
  const tocListEl = deps.getTocListEl();

  // Navigation is FREE and never touches pendingReviews. "Viewing a review" is derived from
  // openPath (see currentReviewId), so simply opening a plan flips the bar to VIEWING (if this is a
  // reviewed plan's file) or SUMMARY (if a review is pending elsewhere) via the refreshReviewBar()
  // call at the end of this function — no teardown/auto-resurface logic. Set the selection union
  // SYNCHRONOUSLY up front (so openPath() reflects it before any await): a sentinel path becomes the
  // `sentinel` variant (no real file — its cwd rides the synthetic record); any other path is `plan`.
  // INVARIANT[selection-set-synchronously-before-await-in-openPlan] (runtime-guard): openPlan assigns `selection` synchronously at the top, before any await, so openPath() reflects the new target throughout.
  //   prevents: a post-await derivation reading a stale selection mid-open
  setSelection(
    isResumeSentinel(path)
      ? {
          k: "sentinel",
          treeId: resumeSentinelTreeId(path),
          cwd: deps.currentRecords().find((r) => r.absolute_path === path)?.cwd ?? null,
        }
      : { k: "plan", path },
  );

  // Take a render generation: any later open/reload bumps the guard and supersedes this
  // render, so its post-await pane mutations are skipped (no stale content landing late).
  const gen = renderGuard.begin();

  // A synthetic resume-sentinel row has NO real file behind it: never route its path through the
  // plans channel (read_plan_contents / set_open_plan / mark_viewed all reject a sentinel — Rust
  // canonicalize fails on the scheme string). Detect once up front so every file-touching step below
  // is skipped for it; the reading pane gets a graceful placeholder + the resume banner still fires.
  const sentinel = isResumeSentinel(path);

  // Record the open plan so the backend holds it read by fiat (live-edits won't re-bold it). Skipped
  // for a sentinel (set_open_plan would reject — no file).
  if (!sentinel) {
    try {
      await invoke("set_open_plan", { path });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // A newer open superseded us while set_open_plan was in flight — bail before mutating the
  // sidebar/header so a slow A-then-fast-B double click can't leave the header/active row on A
  // while the (correctly guarded) pane shows B. openPath is already set synchronously and the
  // newer call owns the header, so the stale call must do nothing here.
  if (!renderGuard.isCurrent(gen)) return;

  // Reflect .active selection in the sidebar without a full re-list, and locally clear the
  // unread marker on the just-opened row (it is read the moment it's opened).
  if (planListEl) {
    // While a rendered live-run placeholder holds `.active`, IT is the single active row — real
    // rows cede `.active` here too (mirrors renderSidebar's suppression so the two sites agree).
    // Sidebar clicks never hit this: ctx.onOpen strips the placeholder's selection before calling
    // openPlan. The unread clearing below is unconditional — opening a plan always reads it.
    const placeholderHoldsActive = planListEl.querySelector(".plan.placeholder.active") !== null;
    // Rows are no longer all direct children of #plan-list — subs live inside .master > .children.
    // Iterate every row by data-path so nested sub rows also get .active/.unread updated.
    for (const el of Array.from(planListEl.querySelectorAll<HTMLElement>("[data-path]"))) {
      const isThis = el.dataset.path === path;
      el.classList.toggle("active", isThis && !placeholderHoldsActive);
      if (isThis) el.classList.remove("unread");
    }
  }

  if (docHeaderEl) docHeaderEl.classList.remove("hidden");
  // A sentinel's `stem` is the tree_id (display-incidental, not a filename) — show the tree's title
  // (from its synthetic record's `h1s`) instead of an ugly `<tree_id>.md`. Real rows keep `<stem>.md`.
  const sentinelRec = sentinel ? deps.currentRecords().find((r) => r.absolute_path === path) ?? null : null;
  if (docFilenameEl) {
    docFilenameEl.textContent = sentinel
      ? sentinelRec?.h1s?.[0] ?? "Plan in progress"
      : `${stem}.md`;
  }
  // Late-patch the reader header cwd from the resolved cache (empty until resolved).
  deps.patchDocSrc();

  if (sentinel) {
    // SENTINEL PANE: there is no plan `.md` to read — render a graceful placeholder INSIDE the
    // render-generation guard (so a fast switch to/from this row can't land stale content). Prefer
    // the tree's INTENT.md (the original request, written under `.plan-tree/`) when readable, else a
    // static "in progress" note. The resume banner (fired below) carries the actual forward action.
    // The tree's INTENT.md is an OPTIONAL `.plan-tree/` read modeled as RemoteData via fromNullable:
    // an ABSENT file (null) → zeroResults, present → success, a thrown read → error, and "cwd not yet
    // resolved" → initial (the read never fires). The match (all five arms) collapses to the markdown
    // to paint — only a present, NON-BLANK INTENT renders; every other arm falls back to the static
    // in-progress note. The render block below is byte-for-byte unchanged (same gen gating); only the
    // present/absent/blank decision moved into the RemoteData fold.
    let intentRead: RemoteData<string> = initial();
    const cwd = sentinelRec ? resolvedCwdFor(sentinelRec) : null;
    if (cwd !== null) {
      try {
        intentRead = fromNullable(
          await invoke<string | null>("read_plan_tree_file", { cwd, name: "INTENT.md" }),
        );
      } catch (e) {
        console.debug("openPlan: sentinel INTENT.md read failed", e);
        intentRead = failure(String(e)); // missing/IO-error ⇒ fall back to the static placeholder.
      }
    }
    // A newer open superseded us while reading INTENT.md — drop this stale render.
    if (!renderGuard.isCurrent(gen)) return;
    const STATIC_PLACEHOLDER = "_This plan is in progress. Use **Resume** above to continue it._";
    const intentMd = foldRemoteData(intentRead, {
      initial: () => STATIC_PLACEHOLDER,
      fetching: () => STATIC_PLACEHOLDER,
      zeroResults: () => STATIC_PLACEHOLDER,
      // A present-but-blank INTENT.md (success("") / whitespace) is treated as no intent.
      success: (text) => (text.trim() !== "" ? text : STATIC_PLACEHOLDER),
      error: () => STATIC_PLACEHOLDER,
    });
    readingPaneEl.classList.remove("raw");
    renderInto(readingPaneEl, intentMd, cwd ?? dirOf(path));
    // switching to a sentinel is a genuine plan change (openPath now reads the sentinel
    // scheme) — discard any draft owned by the previously-open real plan. See openPlan's plan-text
    // site for the full rationale.
    invalidatePopover(readingPaneEl);
    readerScrollEl?.scrollTo({ top: 0 });
    await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
    if (!renderGuard.isCurrent(gen)) return;
    rebuildTocFromPane();
  } else {
    const pane = readingPaneEl; // non-null past the guard at the top of openPlan (for the error arm)
    // The reading-pane content read modeled as a ScalarRemoteData<string>: a resolved read is
    // success(text) — an EMPTY plan is success(""), NEVER zeroResults — and a rejected read is
    // error(message). Only the local representation changes to RemoteData; the render-generation
    // gating below stays byte-for-byte (the post-read isCurrent gate still fences the write before it
    // can land in the pane). Do NOT fold freshness INTO the RemoteData — the seq/gen guard is the
    // supersession authority and is left untouched.
    let content: ScalarRemoteData<string>;
    try {
      content = success(await invoke<string>("read_plan_contents", { path }));
    } catch (e) {
      console.error("read_plan_contents failed", e);
      // String(e) (not e.message) preserves the EXACT pane text rendered today.
      content = failure(String(e));
    }
    // A newer open/reload superseded us while reading — drop this stale render. THIS is the freshness
    // gate the new RemoteData write must pass before it lands in the pane (it also fences the error-arm
    // write, exactly as the original catch's own isCurrent check did). Removing it lets a slow older
    // read clobber a newer render — see src/main.reading-pane-remote-data.test.ts.
    if (!renderGuard.isCurrent(gen)) return;
    // Fold the four reachable scalar states. success → the markdown to render; error → paint the
    // failure pane (a side effect) and yield null; initial/fetching are unreachable for a just-awaited
    // read and yield null (no render). md === null means "skip the success pipeline" — the trailing
    // affordance refresh still runs (matching the original error-path fallthrough).
    const md = matchScalar<string, string | null>(content, {
      initial: () => null,
      fetching: () => null,
      success: (text) => text,
      error: (message) => {
        pane.classList.add("raw");
        pane.textContent = `Could not read plan: ${message}`;
        // Read failed — clear the ToC so no stale entries point at headings that no
        // longer rendered. (Cleared, not "No headings": there is no valid ToC here.)
        tocListEl?.replaceChildren();
        return null;
      },
    });
    if (md !== null) {
      // render full-fidelity markdown into #reading-pane. New opens
      // start at the top.
      renderInto(readingPaneEl, md, dirOf(path));
      // the popover lives OUTSIDE #reading-pane, so it SURVIVES this innerHTML wipe. Now that
      // the fresh DOM is in place and openPath() (== getPlanPath) reflects this plan, invalidate it: a
      // genuine plan switch (draft.planPath !== openPath()) DISCARDS the stale draft; a same-plan
      // re-open PRESERVES it and re-anchors its range against these fresh nodes. MUST run AFTER
      // renderInto (re-anchor needs the new nodes) and AFTER the synchronous selection flip up top (so
      // a switch is seen as a path change). renderInto only runs for the current render (it sits inside
      // the post-read isCurrent guard), so a superseded open never reaches this call.
      // INVARIANT[popover-draft-discarded-on-plan-switch-preserved-on-reopen] (runtime-guard): invalidatePopover compares the draft's planPath against the just-set openPath() — a genuine switch discards the draft, a same-plan reopen re-anchors it.
      //   prevents: a cross-plan draft surviving a switch and re-anchoring against the wrong document
      invalidatePopover(readingPaneEl);
      readerScrollEl?.scrollTo({ top: 0 });
      // INVARIANT[render-generation-guard-cancels-superseded-settles] (runtime-guard): settle is handed `() => renderGuard.isCurrent(gen)`, so a superseded render's settle is cancelled the moment a newer render takes the generation.
      //   prevents: a late settle from a stale render mutating the pane after a newer plan opened
      await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
      // settle() is async; a newer render may have begun while it ran. Bail so a late
      // settle from a superseded render does not touch the pane.
      if (!renderGuard.isCurrent(gen)) return;
      // Rebuild the ToC INSIDE the guarded region (this render won) so a superseded
      // render can never clobber it with stale entries. Does not change the active tab.
      rebuildTocFromPane();
      // re-apply persisted highlights. loadCommentsFor is cached per-path (a
      // cache-miss is the only real IPC window). The post-await isCurrent re-check is MANDATORY:
      // it mirrors every other awaited mutation here, so a fast A→B switch can't let A's late
      // load resolve and applyComments mutate B's pane.
      const recs = await loadCommentsFor(readingPaneEl, path);
      if (!renderGuard.isCurrent(gen)) return;
      applyComments(readingPaneEl, recs);
      // Cold-read the authoritative count for the just-opened plan.
      void refreshCommentCount();
    }
  }

  // Persist the view: clears the unread state for this plan (backend stamps
  // viewed = max(now, mtime+1)). Belt-and-suspenders alongside the open-path fiat. Skipped for a
  // sentinel (mark_viewed would reject — no file).
  if (!sentinel) await deps.markViewed(path);

  // openPath is now set + the plan rendered: re-derive BOTH affordances. The bar flips to
  // VIEWING (this plan is a pending review's file) / SUMMARY (a review pending elsewhere) / hidden, and
  // the resume banner re-evaluates the open plan's `.plan-tree/state.json` — but only when nothing
  // higher occupies the bar (precedence prototype > acceptance > review > resume). NOT guarded by
  // renderGuard — the affordances reflect pending-review state + openPath, not the rendered pane
  // content. refreshCommentCount (fired un-awaited above) re-refreshes the bar once the count lands.
  // refreshAffordances is fire-and-forget for the resume read and guards a fast A→B switch internally.
  deps.refreshAffordances();

  // Reading-pane execution-model picker: visible only when this plan maps to a live node.
  renderModelBar();

  // Conversation-history reconstruction (silent populate): replay this plan's PAST conversation into
  // the CONVERSATION tab without switching tabs — the user stays on PLAN; the reconstruction is ready
  // when they click over. Fire-and-forget like refreshResumeBanner. A NO-OP whenever a live session
  // or an orchestration owns the conversation pane (guarded inside loadHistoryForPlan), so it can
  // never disturb an in-progress run; supersession of a fast A→B switch is guarded via historyGen.
  // SKIPPED for a sentinel: its `stem` is the tree_id (NOT a transcript-resolvable filename stem), so
  // loadPlanHistory would fire a full read_plan_transcript corpus scan that always misses and paints a
  // misleading empty Conversation tab. The live run (if any) owns that pane via the orchestrator.
  if (!sentinel) deps.getLoadPlanHistory()?.(stem);
}

// Live-reload the currently-open plan, preserving the reading position with an
// element/source-line anchor that survives async render height changes. We
// capture the anchored block BEFORE re-render, apply the delta once after the
// synchronous text lands, then re-apply after settle() so mermaid/image height
// shifts don't drift the viewport.
export async function reloadOpenPlan(): Promise<void> {
  const path = openPath();
  const readingPaneEl = deps.getReadingPaneEl();
  const readerScrollEl = deps.getReaderScrollEl();
  if (!readingPaneEl || !readerScrollEl || path === null) return;
  // A reviewed plan is now a REAL file, so a live edit to it reloads normally (Claude revising the
  // plan after a deny updates the file in place — the user sees the revision live).
  // A synthetic resume sentinel has no file to reload (read_plan_contents would reject). Its pane is
  // a static placeholder painted in openPlan; a live `.plan-tree/state.json` edit re-surfaces via the
  // banner, not a pane reload. Bail before the read so no spurious "reload failed" is logged.
  if (isResumeSentinel(path)) return;
  const renderGuard = deps.getRenderGuard();
  // Take a render generation BEFORE the read: a newer open/reload supersedes us and our
  // post-await pane mutations (renderInto + the two applyDelta calls) are skipped, so an
  // older reload can never clobber a newer one.
  const gen = renderGuard.begin();
  const anchor = captureAnchor(readerScrollEl);
  // The reload's content read modeled as a ScalarRemoteData<string>: success(text) on a resolved read
  // (an empty plan is success(""), never zeroResults), error(message) on a rejected one (logged in the
  // catch). Only the representation changes; the render-generation gating below stays byte-for-byte.
  let content: ScalarRemoteData<string>;
  try {
    content = success(await invoke<string>("read_plan_contents", { path }));
  } catch (e) {
    console.error("reload failed (plan may have been removed)", e);
    content = failure(String(e));
  }
  // Superseded while reading — drop this stale reload entirely (the freshness gate the new RemoteData
  // write must pass before it lands; a failed read leaves the pane untouched either way).
  if (!renderGuard.isCurrent(gen)) return;
  const md = matchScalar<string, string | null>(content, {
    initial: () => null,
    fetching: () => null,
    success: (text) => text,
    error: () => null, // the throw was already logged in the catch; a failed reload leaves the pane as-is
  });
  if (md === null) return;
  renderInto(readingPaneEl, md, dirOf(path));
  // a live reload keeps the SAME open plan (openPath unchanged), so this PRESERVES the
  // user's in-progress draft and re-anchors its range against the freshly-rendered nodes — the app
  // auto-reloads a plan WHILE it is being built, so hiding the draft on every reload would be a
  // regression. MUST run after renderInto (re-anchor needs the new DOM). See render/comments.ts.
  invalidatePopover(readingPaneEl);
  applyDelta(readerScrollEl, anchor);
  await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));
  // settle() is async; bail so a superseded reload's second applyDelta never runs.
  if (!renderGuard.isCurrent(gen)) return;
  applyDelta(readerScrollEl, anchor);
  // Rebuild the ToC INSIDE the guarded region so a live edit that adds/removes a
  // heading updates the Contents tab in place. Never changes the active tab.
  rebuildTocFromPane();
  // on a live reload the cache for this path is invalidated and re-read from the
  // backend (loadCommentsFor re-invokes io.load), then highlights re-apply. The post-await
  // isCurrent re-check is MANDATORY (see openPlan) so a superseded reload never wraps
  // highlights into a newer plan's pane.
  const recs = await loadCommentsFor(readingPaneEl, path);
  if (!renderGuard.isCurrent(gen)) return;
  applyComments(readingPaneEl, recs);
  void refreshCommentCount();
}

// Filename stem from an absolute plan path (no `.md`). Reuses stemFromPath for the basename rule.
function stemFromBasename(absPath: string): Stem {
  return stemFromPath(asAbsPath(absPath));
}

// REFUSE-and-surface: a pending review whose REAL plan file cannot be opened (empty planFilePath, or
// openPlan threw — file missing / outside plans dir) is UN-ACTIONABLE. Faking a detached render here
// would leave openPath untouched, so currentReviewId() returns null → the bar falls to SUMMARY mode
// (Submit/Dismiss hidden; their handlers bail on the null guards) while the dead review is STILL
// counted ("N plans awaiting review") — a phantom that traps navigation but can never be acted on.
//
// An un-openable plan can never be reviewed, so we RELEASE the held producer with a DENY before
// dropping the review — leaving it held would hang the agent. The release is SOURCE-AWARE (delegated
// to resolveReview, which dispatches per source AND already drops the review + refreshes the bar):
//   • in-process — resolveReview denies via resolve_tool_permission(allow:false), freeing the SDK
//     canUseTool seam (mirrors the write_agent_plan-failure path in handleToolPermissionRequested,
//     which auto-denies the same way). There is NO terminal for an in-process review.
//   • external   — resolveReview denies via respond_to_review("deny"), freeing the terminal hook so
//     Claude stays in plan mode and can retry, instead of leaving it blocked until its ~570s timeout.
// resolveReview surfaces #hook-status only on failure; we set the source-appropriate refuse message
// AFTER it so our message wins on the success path, and we belt-and-suspenders the drop + refresh in
// case resolveReview short-circuited (e.g. the entry was already gone under the chained-event race).
async function refuseUnopenableReview(review: PendingReview): Promise<void> {
  console.error("plan review: the review's plan file could not be opened; refusing", review.reviewId);
  await deps.resolveReview(review.reviewId, "deny", "Could not open the plan for review; aborting.");
  pendingReviews.delete(review.reviewId);
  // Surface removal can un-suppress the resume banner — re-derive both surfaces.
  deps.refreshAffordances();
  setHookStatus(
    deps.getHookStatusEl(),
    review.source === "in-process"
      ? "Couldn't open the plan for review — asked the agent to re-plan."
      : "Couldn't open the plan for review — released the hook so Claude can re-plan.",
    "error",
  );
  setTimeout(() => setHookStatus(deps.getHookStatusEl(), ""), deps.hookStatusMs);
}

// Open a pending review's REAL plan file through the NORMAL plan-open flow (Option A). Refresh the
// sidebar list FIRST so the just-written plan's `[data-path]` row exists, then openPlan(...) — which
// selects that row, persists/loads its comments on its real path, and live-reloads. The bar then
// derives VIEWING from openPath. If planFilePath is empty or the open fails (file missing / outside
// plans dir) the review is REFUSED (refuseUnopenableReview) rather than rendered as an unactionable
// phantom. `review` MUST already be tracked in pendingReviews (the caller adds it).
export async function openReviewPlanFile(review: PendingReview): Promise<void> {
  if (!review.planFilePath) {
    await refuseUnopenableReview(review);
    return;
  }
  // Refresh the sidebar so the just-written plan row exists before we select it. (openPlan applies
  // .active by data-path; the row must be present at/after open for the selection invariant to hold.)
  await deps.refreshList();
  try {
    await openPlan(asAbsPath(review.planFilePath), stemFromBasename(review.planFilePath));
  } catch (e) {
    console.error("plan review: openPlan of the real file failed", e);
    await refuseUnopenableReview(review);
    return;
  }
  deps.refreshReviewBar();
}

// Pick the NEWEST pending review (max createdMs). Tie-break MUST favor the LATER-INSERTED review on
// equal createdMs: two reviews can arrive within the same millisecond (createdMs falls back to
// Date.now()), and `pendingReviews` is a Map iterated in INSERTION order, so the last-inserted entry
// is the genuinely most-recent arrival. `>=` picks the later-inserted entry, making this deterministic.
export function newestPendingReview(): PendingReview | null {
  let newest: PendingReview | null = null;
  for (const r of pendingReviews.values()) {
    if (newest === null || r.createdMs >= newest.createdMs) newest = r;
  }
  return newest;
}

// Open a held gate's plan via the SAME flow onAwaitingApproval uses: flip to the Plan tab
// synchronously (before any await), refresh the list so the plan's row exists, open it (selecting the
// row + driving viewingGate), then re-assert the tab + bar. Shared by the gate observer and the
// "Resume newest" path so both re-open a gate identically.
// INVARIANT[openGatePlanFile-shared-by-both-gate-paths] (convention): the gate observer and the Resume path both re-open a held gate's plan through this one sequence.
//   prevents: the two gate-open paths diverging
export async function openGatePlanFile(planPath: string): Promise<void> {
  deps.switchToPlanTab();
  await deps.refreshList();
  try {
    await openPlan(asAbsPath(planPath), stemFromBasename(planPath));
  } catch (e) {
    console.error("gate: openPlan of the pointed-at plan failed", e);
  }
  deps.switchToPlanTab();
  deps.refreshReviewBar();
}

// resume the NEWEST pending SURFACE (derived from pendingSurfaces(), so it agrees with the
// SUMMARY-mode count). A held orchestrator gate is the live, most-immediate surface: re-open its plan
// via the SAME open path onAwaitingApproval uses (switching the bar back to VIEWING). Otherwise resume
// the newest pending review's real plan file. No-op if nothing is pending. The hook/gate is untouched.
export function resumeNewestReview(): void {
  const surfaces = deps.pendingSurfaces();
  if (surfaces.length === 0) return;
  // INVARIANT[gate-preferred-over-newer-external-review] (precedence): a held orchestrator gate is found first among the pending surfaces, so Resume re-opens it regardless of a newer external review.
  //   prevents: a newer external review opening instead of the live held gate
  const gateSurface = surfaces.find((s) => s.kind === "orchestrator-gate");
  if (gateSurface && gateSurface.kind === "orchestrator-gate") {
    void openGatePlanFile(gateSurface.gate.planPath);
    return;
  }
  const newest = newestPendingReview();
  if (newest !== null) void openReviewPlanFile(newest);
}

// One serialized `plan-changed` handler body. Runs to completion before the next queued
// event begins (chained on `pending` in the listener) so refreshList/reloadOpenPlan from
// different events never interleave.
export async function handlePlanChanged(changedPath: AbsPath): Promise<void> {
  // INVARIANT[sentinel-touches-no-file-io] (runtime-guard): a synthetic resume sentinel is guarded out of every file-backed IPC (set_open_plan / mark_viewed) in this handler.
  //   prevents: backend rejections / "reload failed" logs for a row with no real file
  // Keep the backend's notion of the open plan current (belt-and-suspenders; the open
  // plan is also held read by fiat backend-side). A synthetic resume sentinel has no real file —
  // set_open_plan would reject — so skip it (a sentinel's read-state is not tracked backend-side).
  const op = openPath();
  if (op !== null && !isResumeSentinel(op)) {
    try {
      await invoke("set_open_plan", { path: op });
    } catch (e) {
      console.error("set_open_plan failed", e);
    }
  }

  // INVARIANT[open-plan-stamped-viewed-before-relist] (runtime-guard): when the open plan is the changed file, markViewed runs before refreshList / list_plans.
  //   prevents: the sidebar momentarily bolding the plan the user is actively watching
  // If the OPEN plan changed, stamp it viewed BEFORE re-listing so list_plans never
  // momentarily bolds it (in addition to the open-path fiat). A sentinel is never a real
  // `changedPath` (no file watched), so this branch never runs for one — guard regardless.
  if (op !== null && changedPath === op && !isResumeSentinel(op)) {
    await deps.markViewed(op);
  }

  await deps.refreshList();

  // INVARIANT[reload-target-re-read-after-relist] (runtime-guard): the reload target is re-read from openPath() AFTER refreshList, so a collapsed selection yields nothing to reload.
  //   prevents: a reload firing against a path the same refresh just collapsed
  // Re-read openPath AFTER refreshList: a `plan` selection whose file just vanished has collapsed to
  // `none` (resolveSelection), so there is nothing to reload.
  const opAfter = openPath();
  if (opAfter !== null && changedPath === opAfter) {
    await reloadOpenPlan();
  }
}
