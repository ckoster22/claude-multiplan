// CSS class strings are LOAD-BEARING — pinned by contract.test.ts golden snapshots; do not rename.
// The sidebar and reading-pane domains never import each other (CLAUDE.md keeps them disjoint —
// they converge at main.ts only).

import { invoke } from "@tauri-apps/api/core";
import { asAbsPath, type PlanRecord, type SidebarCtx, type AbsPath, type Stem } from "./types";
import {
  currentRecords,
  orchSnapshot,
  getSelection,
  setSelection,
  openPath,
  getRunPlaceholder,
  planListEl,
  planCountEl,
  filterQuery,
  type Selection,
} from "./app-state";
import { isResumeSentinel } from "./resume-banner";
import { planSrcText } from "./cwd";
import { presetClassForModel, friendlyModelName, type ModelOptions } from "./model-picker";
import { resolveNodeByNnPath, approvalGateOf } from "./conversation/plan-tree";
import { nodeExecutionModel } from "./conversation/plan-tree/triage";
import { filterRecords, planCountText, highlightInto } from "./filter";

// Two cross-domain reading-pane callbacks (open a plan, flip to the Conversation tab) supplied by `main`
// via initSidebar, so the sidebar never imports `./main` and the two domains stay disjoint. Defaults are
// no-op so a test that never calls initSidebar stays well-defined.
let openPlanCb: (path: AbsPath, stem: Stem) => void = () => {};
let switchToConversationTabCb: () => void = () => {};

export function initSidebar(deps: {
  openPlan: (path: AbsPath, stem: Stem) => void;
  switchToConversationTab: () => void;
}): void {
  openPlanCb = deps.openPlan;
  switchToConversationTabCb = deps.switchToConversationTab;
}

export function relativeTime(mtimeMs: number): string {
  const now = Date.now();
  const diff = now - mtimeMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const d = new Date(mtimeMs);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function applyRowState(row: HTMLElement, rec: PlanRecord, ctx: SidebarCtx): void {
  row.dataset.path = rec.absolute_path;
  if (rec.unread) row.classList.add("unread");
  if (rec.absolute_path === ctx.openPath) row.classList.add("active");
  row.addEventListener("click", () => {
    ctx.onOpen(rec.absolute_path, rec.filename_stem);
  });
}

// Compact sub row: seq label derives from `nn_path` (e.g. "02.01"), NEVER from `nn`
// (using `nn` for a "02.01" child would collide with the "02" master row). Null nn_path → "00".
function buildSub(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan sub";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const seq = document.createElement("span");
  seq.className = "seq";
  seq.textContent = rec.nn_path ?? "00";

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(seq);
  planRow.appendChild(title);
  planRow.appendChild(dot);
  row.appendChild(planRow);

  return row;
}

// SESSION-ONLY collapse key (tree_id + nn_path, NUL-joined). Not persisted (disjoint from set_tree_collapsed).
function subCollapseKey(treeId: string, nnPath: string): string {
  return treeId + "\u0000" + nnPath;
}

// Sub row with nested dotted children: `.sub-node` wrapper + `.twirl` + `.child-count` (direct children only)
// + nested `.children`. Collapse is session-only — twirl mutates ctx.subCollapse and flips wrapper class directly.
function buildInternalSub(
  rec: PlanRecord,
  directCount: number,
  ctx: SidebarCtx,
): { wrapper: HTMLElement; children: HTMLElement } {
  const key = subCollapseKey(rec.tree_id ?? "", rec.nn_path ?? "");

  const wrapper = document.createElement("div");
  wrapper.className = "sub-node";
  wrapper.dataset.nnPath = rec.nn_path ?? "";
  if (ctx.subCollapse.get(key) ?? false) wrapper.classList.add("collapsed");

  const row = buildSub(rec, ctx);
  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the sub.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾";
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !(ctx.subCollapse.get(key) ?? false);
    ctx.subCollapse.set(key, next);
    wrapper.classList.toggle("collapsed", next);
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // "N sub-plan(s)" label — DIRECT children only, not all descendants.
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${directCount} sub-plan${directCount === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// Sub-tree node; `kids` filled by the prefix-stack walk. A node is INTERNAL only if it has kids
// (a duplicate dotted id whose extensions attached to a later duplicate stays a plain leaf).
export interface SubTreeNode {
  rec: PlanRecord;
  kids: SubTreeNode[];
}

export function renderSubTree(node: SubTreeNode, container: HTMLElement, ctx: SidebarCtx): void {
  if (node.kids.length === 0) {
    container.appendChild(buildSub(node.rec, ctx));
    return;
  }
  const { wrapper, children } = buildInternalSub(node.rec, node.kids.length, ctx);
  container.appendChild(wrapper);
  for (const kid of node.kids) {
    renderSubTree(kid, children, ctx);
  }
}

// Placeholder row for a live run with no sidebar file yet. `.plan`-shaped but NO `data-path`
// (so openPlan's `[data-path]` loop structurally cannot touch it). Click → ctx.onPlaceholderOpen.
export function buildPlaceholderRow(
  ph: { treeId: string; label: string; selected: boolean },
  ctx: SidebarCtx,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan placeholder";
  row.dataset.treeId = ph.treeId;
  if (ph.selected) row.classList.add("active");

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const dot = document.createElement("span");
  dot.className = "placeholder-dot";

  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = ph.label;

  planRow.appendChild(dot);
  planRow.appendChild(title);
  row.appendChild(planRow);

  row.addEventListener("click", () => {
    ctx.onPlaceholderOpen?.();
  });
  return row;
}

// Shared by renderSidebar AND applyFilterAndRender so both sites cannot drift.
export function placeholderVisible(
  ph: { treeId: string } | null,
  records: PlanRecord[],
): boolean {
  return ph !== null && !records.some((r) => r.tree_id === ph.treeId);
}

// Pure view switch — activating a `.tab` toggles its matching `.tab-pane`; never rebuilds pane content.
export function initTabs(tabRowEl: HTMLElement, paneEls: HTMLElement[]): void {
  const tabs = Array.from(tabRowEl.querySelectorAll<HTMLElement>(".tab"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const pane of paneEls) {
        pane.classList.toggle("active", pane.id === `tab-${target}`);
      }
    });
  }
}

// INVARIANT[placeholder-selected-folded-into-selection] (type-level): the placeholder is "selected" iff `selection.k === "placeholder"` for the current run — read off the union, with no parallel boolean.
//   prevents: a "placeholder selected AND a real plan open" double-active state
function placeholderSelected(): boolean {
  const sel = getSelection();
  return sel.k === "placeholder" && sel.treeId === (getRunPlaceholder()?.treeId ?? null);
}

// The execution-model a sidebar row displays, and whether that state is a LIVE user override.
//   - Live node (the row is in the active tree AND its nn_path resolves in the snapshot): the node's
//     PERSISTED per-node model (execution_model, else the derived nodeExecutionModel), with the
//     auto/override affordance read off model_source.
//   - Persisted / inactive row: the wire `execution_model` (chip only — the source is unknowable
//     off-wire). Null (legacy/pre-feature) ⇒ no model ⇒ no badge.
// `model_source` is never on the PlanRecord wire, so override state is only knowable for a live node.
function rowModelState(rec: PlanRecord): { model: ModelOptions; overridden: boolean; live: boolean } | null {
  const snap = orchSnapshot();
  if (snap && rec.tree_id && rec.tree_id === snap.treeId) {
    const hit = resolveNodeByNnPath(snap.root, rec.nn_path);
    if (hit) {
      return {
        model: hit.node.execution_model ?? nodeExecutionModel(hit.node).options,
        overridden: hit.node.model_source === "override",
        live: true,
      };
    }
  }
  const persisted = rec.execution_model ?? null;
  return persisted ? { model: persisted, overridden: false, live: false } : null;
}

// Append the trailing `.mbadge` model chip to a row's `.plan-row` (the last child). Omitted entirely
// when the row has no known model (legacy row) or an unrecognized model id.
function appendModelBadge(planRow: HTMLElement, rec: PlanRecord): void {
  const state = rowModelState(rec);
  if (!state) return;
  const cls = presetClassForModel(state.model.model);
  if (!cls) return;
  const badge = document.createElement("span");
  badge.className = `mbadge ${cls}`;
  badge.textContent = friendlyModelName(state.model.model) ?? state.model.model;
  // The auto/override affordance rides ONLY on a live node (model_source is off-wire): a live auto
  // node gets the "auto" suffix, a live override gets the `.override` accent dot, a persisted chip
  // gets neither.
  if (state.live) {
    if (state.overridden) {
      badge.classList.add("override");
    } else {
      const rec_ = document.createElement("span");
      rec_.className = "rec";
      rec_.textContent = "auto";
      badge.appendChild(rec_);
    }
  }
  planRow.appendChild(badge);
}

// Build a flat row matching the documented per-row template:
//   .plan[.active][.unread] data-path  >  .plan-row > .plan-title + .unread-dot + .mbadge
//                                          .plan-src (dimmed cwd; filled by 03)
//                                          .plan-meta (.when)
// Standalone rows and 0-child masters use this shape. A 0-child master keeps flavor=master
// semantics internally and opens normally (see the "0-child master ⇒ flat row" decision).
function buildFlatRow(rec: PlanRecord, ctx: SidebarCtx): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan";
  applyRowState(row, rec, ctx);

  const planRow = document.createElement("div");
  planRow.className = "plan-row";

  const title = document.createElement("span");
  title.className = "plan-title";
  // A synthetic resume-sentinel row's `filename_stem` is the tree_id (display-incidental) — show the
  // tree's title instead, which rides `h1s[0]` (synthetic resume-sentinel rows). Real rows
  // keep the existing `filename_stem` title. A sentinel with no h1s falls back to the stem.
  title.textContent = isResumeSentinel(rec.absolute_path)
    ? rec.h1s[0] ?? rec.filename_stem
    : rec.filename_stem;

  const dot = document.createElement("span");
  dot.className = "unread-dot";

  planRow.appendChild(title);
  planRow.appendChild(dot);
  appendModelBadge(planRow, rec);

  const src = document.createElement("div");
  src.className = "plan-src";
  src.textContent = planSrcText(rec);

  const meta = document.createElement("div");
  meta.className = "plan-meta";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.mtime_ms);
  meta.appendChild(when);

  row.appendChild(planRow);
  row.appendChild(src);
  row.appendChild(meta);

  return row;
}

// Build an expandable master: a `.master` wrapper holding a `.plan.master-row` (flat-row shape
// PLUS a leading `.twirl` and a trailing `.child-count`) and a `.children` container. Only built
// when child_count >= 1 (0-child masters render flat via buildFlatRow). Returns the wrapper and
// its `.children` box (the walk threads subs into the latter).
function buildMaster(rec: PlanRecord, ctx: SidebarCtx): { wrapper: HTMLElement; children: HTMLElement } {
  const treeId = rec.tree_id ?? "";
  const effectiveCollapsed = ctx.collapseOverride.get(treeId) ?? rec.collapsed;

  const wrapper = document.createElement("div");
  wrapper.className = "master";
  wrapper.dataset.treeId = treeId; // lets onToggleCollapse find this wrapper for instant feedback
  if (effectiveCollapsed) wrapper.classList.add("collapsed");

  const row = buildFlatRow(rec, ctx);
  row.classList.add("master-row");

  const planRow = row.querySelector(".plan-row") as HTMLElement;

  // Disclosure twirl — its OWN listener stops propagation so toggling never also opens the
  // master plan. Prepend it before the title.
  const twirl = document.createElement("span");
  twirl.className = "twirl";
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.onToggleCollapse(treeId, !(ctx.collapseOverride.get(treeId) ?? rec.collapsed));
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // "N sub-plans" count (singular at 1) appended after the title/dot.
  const n = rec.child_count ?? 0;
  const count = document.createElement("span");
  count.className = "child-count";
  count.textContent = `${n} sub-plan${n === 1 ? "" : "s"}`;
  planRow.appendChild(count);

  // buildFlatRow appended the model badge before the count; keep it the LAST child so the far-right
  // chip position is stable across flat + master rows (its margin-left:auto anchors it right).
  const badge = planRow.querySelector(".mbadge");
  if (badge) planRow.appendChild(badge);

  const children = document.createElement("div");
  children.className = "children";

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return { wrapper, children };
}

// Render the full nested sidebar from pre-ordered records into `listEl`. `arrange_plans` groups
// each master's subs contiguously in depth-first dotted order; VISUAL depth is built here from
// `nn_path` prefixes with a prefix-keyed stack: a sub whose nn_path extends the top frame's
// nn_path by exactly one segment nests inside it; otherwise frames pop until its parent prefix
// matches. The stack carries SubTreeNodes (not DOM) so "internal" = actually-accumulated kids.
export function renderSidebar(listEl: HTMLElement, records: PlanRecord[], ctx: SidebarCtx): void {
  listEl.replaceChildren();

  // Live-run placeholder: when the ctx carries one AND no rendered record has its
  // tree_id (the agent hasn't written its plan file yet, or list_plans lags the write), prepend
  // the `.plan.placeholder` row as the FIRST entry. Once the real row exists the placeholder is
  // omitted — the real row takes over.
  const ph = ctx.placeholder ?? null;
  const phShown = placeholderVisible(ph, records);
  if (ph && phShown) {
    listEl.appendChild(buildPlaceholderRow(ph, ctx));
  }

  // The open master's children container + its parse state; null between masters.
  let currentChildren: HTMLElement | null = null;
  let roots: SubTreeNode[] = [];
  // Prefix stack over the open master's subs. nnPath "" is the master-level base (never pops).
  let stack: { nnPath: string; kids: SubTreeNode[] }[] = [];

  // Flush the open master's parsed sub-tree into its `.children` container.
  const flush = (): void => {
    if (!currentChildren) return;
    for (const root of roots) {
      renderSubTree(root, currentChildren, ctx);
    }
    currentChildren = null;
    roots = [];
    stack = [];
  };

  for (const rec of records) {
    if (rec.flavor === "master" && (rec.child_count ?? 0) >= 1) {
      flush();
      const { wrapper, children } = buildMaster(rec, ctx);
      listEl.appendChild(wrapper);
      currentChildren = children;
      roots = [];
      stack = [{ nnPath: "", kids: roots }];
    } else if (rec.flavor === "sub") {
      // Trust the contract (a sub always follows its master), but be LOUD not silent: a sub with
      // no open children container is a backend contract violation — log it and append flat so
      // the sidebar still renders (a visible diagnostic, never a quiet re-classification).
      if (!currentChildren) {
        console.error("renderSidebar: orphan sub with no master container", rec.absolute_path);
        listEl.appendChild(buildFlatRow(rec, ctx));
        continue;
      }
      const nnPath = rec.nn_path ?? "";
      const parentPrefix = nnPath.split(".").slice(0, -1).join("."); // "" for depth-1 subs
      // Pop deeper/sibling frames until the top frame IS this sub's parent (base never pops).
      while (stack.length > 1 && stack[stack.length - 1].nnPath !== parentPrefix) {
        stack.pop();
      }

      const node: SubTreeNode = { rec, kids: [] };
      if (stack[stack.length - 1].nnPath === parentPrefix) {
        stack[stack.length - 1].kids.push(node);
        // Only a properly-parented sub opens a frame; extensions of an ORPHAN stay orphans too
        // (each contract-violating row is individually loud rather than quietly re-grouped).
        stack.push({ nnPath, kids: node.kids });
      } else {
        // Generalized loud orphan: the dotted parent prefix has no preceding row in this tree —
        // a backend contract violation (arrange_plans orders a parent before its extensions).
        // Render FLAT at the master's depth-1 level, never silently re-parent.
        console.error(
          "renderSidebar: orphan dotted sub — parent prefix has no preceding row",
          rec.absolute_path,
          nnPath,
        );
        roots.push(node);
      }
    } else {
      // standalone, or a 0-child master ⇒ flat row.
      flush();
      listEl.appendChild(buildFlatRow(rec, ctx));
    }
  }
  flush();

  // While a rendered placeholder is SELECTED it is THE single active row (the user has been
  // flipped to the Conversation tab to watch the run) — real rows cede `.active` even when one
  // matches ctx.openPath, so a run start can never paint two active rows (the placeholder AND
  // the still-open prior plan). Applies only while the placeholder is actually rendered: once
  // the real row supersedes it, ctx.openPath drives `.active` normally again.
  if (ph && phShown && ph.selected) {
    for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".plan.active[data-path]"))) {
      el.classList.remove("active");
    }
  }
}

// Session record of the user's collapse intent for trees toggled THIS session. Resolved as
// `collapseOverride.get(tree_id) ?? rec.collapsed` in `buildMaster`, so an in-flight refreshList
// reading a not-yet-persisted (stale) `collapsed` value cannot revert the user's toggle — the
// override wins until the backend converges; the empty map on restart cedes to the persisted value.
export const collapseOverride = new Map<string, boolean>();

// Session-ONLY collapse state for INTERNAL sub nodes (keyed by subCollapseKey). Never persisted
// and never routed through set_tree_collapsed — restarting the app re-expands all internal nodes
// while masters keep their persisted collapse exactly as before.
export const subCollapse = new Map<string, boolean>();

// Optimistic collapse toggle: record intent, toggle `.collapsed` on the master wrapper instantly
// for feedback, then fire-and-forget the persist (errors logged, non-fatal). No re-list.
function onToggleCollapse(treeId: string, next: boolean): void {
  collapseOverride.set(treeId, next);
  const listEl = planListEl();
  if (listEl) {
    for (const wrapper of Array.from(listEl.querySelectorAll<HTMLElement>(".master"))) {
      if (wrapper.dataset.treeId === treeId) {
        wrapper.classList.toggle("collapsed", next);
      }
    }
  }
  void invoke("set_tree_collapsed", { treeId, collapsed: next }).catch((e) =>
    console.error("set_tree_collapsed failed", e),
  );
}

// PURE selection reducer: given the prior selection, the PRIOR records list, and the
// fresh records list, return the selection that should survive. The ONLY collapse is a `plan`
// selection that GENUINELY VANISHED — it was in the prior list and is gone from the new one — falling
// to `none` (closing the ghost reading pane). Everything else is EXEMPT and returned unchanged:
//   • placeholder — a live run has no real row until its plan lands; blanking it would drop the run.
//   • sentinel    — a synthetic resume row is kept alive by the dedicated stale-sentinel cleanup below
//                   (which also honors the placeholder-stands-in takeover); this reducer must not
//                   pre-empt that nuance.
//   • a `plan` that was NEVER listed — a freshly-opened/not-yet-indexed plan, a held gate whose row
//                   lags the write, or the __setOpenPathForMock in-process review demo (whose
//                   plan is intentionally absent from list_plans). "Absent from the new list" alone is
//                   NOT a vanish — it must have been PRESENT before, so a not-yet-indexed open is safe.
//   • the held orchestrator gate's plan — exempt even if it WAS listed then dropped (the row can lag
//                   mid-hold; the placeholder stands in), via the explicit `heldGatePlan` guard.
// INVARIANT[selection-collapse-only-on-genuine-vanish] (runtime-guard): a `plan` selection collapses to none only when it was in the prior list AND is absent from the new one.
//   prevents: blanking a freshly-opened / not-yet-indexed plan that was simply never listed
export function resolveSelection(
  prev: Selection,
  records: PlanRecord[],
  prevRecords: PlanRecord[],
  heldGatePlan: AbsPath | null,
): Selection {
  if (prev.k !== "plan") return prev;
  // INVARIANT[held-gate-plan-exempt-from-collapse] (runtime-guard): the held orchestrator gate's plan is returned unchanged even if its row drops from list_plans mid-hold.
  //   prevents: a churning gate row collapsing the selection and vanishing the in-process Approve bar
  if (heldGatePlan !== null && prev.path === heldGatePlan) return prev;
  const wasListed = prevRecords.some((r) => r.absolute_path === prev.path);
  const stillListed = records.some((r) => r.absolute_path === prev.path);
  return wasListed && !stillListed ? { k: "none" } : prev;
}

// Build the FRESH sidebar render context (openPath read live, never a stale closure — keeps
// `.active` correct across re-lists). Shared by the filter render path.
function makeSidebarCtx(): SidebarCtx {
  // The placeholder's `.active` derivation (computed LIVE each render): the folded selected flag
  // (placeholderSelected() — selection.k === "placeholder" for this tree) OR "the gate plan is open
  // but its row is missing" — when a held gate's plan IS the open plan, openPlan's [data-path] loop
  // may have found no row to mark `.active`, so the placeholder stands in as the active row
  // (renderSidebar omits it once the row exists, at which point that row carries `.active` via
  // ctx.openPath instead).
  const gate = approvalGateOf(orchSnapshot());
  const standsInForOpenGatePlan = gate != null && openPath() === asAbsPath(gate.planPath);
  const ph = getRunPlaceholder();
  return {
    openPath: openPath(),
    collapseOverride,
    subCollapse,
    onOpen: (path, stem) => {
      // Opening any real plan from the sidebar deselects the placeholder. openPlan sets
      // selection=plan (so the folded placeholderSelected goes false), but it does NOT re-render the
      // sidebar and its [data-path] loop only touches real rows — clear the placeholder's stale
      // `.active` here directly.
      const listEl = planListEl();
      if (listEl) {
        for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".plan.placeholder"))) {
          el.classList.remove("active");
        }
      }
      openPlanCb(path, stem);
    },
    onToggleCollapse,
    placeholder: ph
      ? {
          treeId: ph.treeId,
          label: ph.label,
          selected: placeholderSelected() || standsInForOpenGatePlan,
        }
      : null,
    onPlaceholderOpen: () => {
      // Clicking the placeholder makes it the active selection (the user wants to watch the run).
      switchToConversationTabCb();
      const cur = getRunPlaceholder();
      if (cur) setSelection({ k: "placeholder", treeId: cur.treeId });
      applyFilterAndRender();
    },
  };
}

// Filter the in-memory records by the live query and render the PLANS TAB only (never the
// Contents/ToC tab — buildToc is not called here). Updates `#plan-count` to the "N of M" form
// while filtering (N = shown files, M = total files), or the plain "M file(s)" form when the
// query is empty. An empty result under a non-empty query shows the `.filter-empty` affordance.
// After rendering, matched substrings are highlighted in the visible `.plan-title` / `.plan-src`
// (a heading-only match still shows its row, un-highlighted).
export function applyFilterAndRender(): void {
  const listEl = planListEl();
  if (!listEl) return;
  const q = filterQuery();
  // Collapse the sidebar plan-list RemoteData to the records to render. Only `success` carries rows; the
  // other four states render the same empty sidebar this app has always shown for the pre-load / empty /
  // failed-initial states (no separate loading or error UI exists). `currentRecords()` is exactly that
  // collapse (unwrapOr(listState, [])) — the same array the cwd late-patch mutates and every other reader
  // in this file goes through, so the sidebar render and the by-path lookups cannot drift.
  const records = currentRecords();
  const total = records.length;
  const shown = filterRecords(records, q);

  if (shown.length === 0 && q.trim() !== "") {
    // Non-empty query with no matches ⇒ empty-state affordance (NOT an empty list).
    listEl.replaceChildren();
    // The live-run placeholder is ALWAYS visible regardless of the filter query (it represents
    // live work, not a record the filter can match) — prepend it above the empty-state note.
    // SAME visibility predicate as renderSidebar (checked against the rendered records — here
    // the empty `shown` set, so a set placeholder always passes) so the two sites cannot drift.
    const ctx = makeSidebarCtx();
    const ph = ctx.placeholder ?? null;
    if (ph && placeholderVisible(ph, shown)) listEl.appendChild(buildPlaceholderRow(ph, ctx));
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No matching plans";
    listEl.appendChild(empty);
  } else {
    renderSidebar(listEl, shown, makeSidebarCtx());
    highlightVisibleRows(q);
  }

  const countEl = planCountEl();
  if (countEl) {
    countEl.textContent = planCountText(shown.length, total, q);
  }
}

// Re-wrap the matched substring in a `<mark>` across every rendered `.plan-title` / `.plan-src`
// in #plan-list, reading each element's current text. Re-applied on every filter render and
// after a late cwd patch, so highlights survive a cwd arriving after the initial render. An
// empty query clears any marks (highlightInto emits plain text).
function highlightVisibleRows(query: string): void {
  const listEl = planListEl();
  if (!listEl) return;
  for (const el of Array.from(listEl.querySelectorAll<HTMLElement>(".plan-title, .plan-src"))) {
    highlightInto(el, el.textContent ?? "", query);
  }
}
