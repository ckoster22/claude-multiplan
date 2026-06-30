// Sidebar PURE row-builders — nested-hierarchy render leaves. Side-effect-free at import time.
// CSS class strings are LOAD-BEARING — pinned by contract.test.ts golden snapshots; do not rename.
// CONTRACT.md forbids sidebar ↔ reading-pane imports (converge at main.ts only).
// main.ts re-exports `placeholderVisible` + `initTabs` so their `./main` importers keep resolving unchanged.

import type { PlanRecord, SidebarCtx } from "./types";

// Human-friendly relative time for the sidebar `.plan-meta .when` slot.
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

// Recursively render the sub-tree: leaves via buildSub, internal nodes via buildInternalSub with kids into nested `.children`.
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
// Placeholder is visible only while no rendered record carries its tree_id. Exported for unit tests.
export function placeholderVisible(
  ph: { treeId: string } | null,
  records: PlanRecord[],
): boolean {
  return ph !== null && !records.some((r) => r.tree_id === ph.treeId);
}

// Wire tab switching: click on `.tab` activates it + matching `.tab-pane`. Pure view switch — never rebuilds pane content. Exported for unit tests.
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
