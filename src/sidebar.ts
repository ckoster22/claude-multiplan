// Sidebar PURE row-builders — the nested-hierarchy render leaves.
//
// Side-effect-free at import time (only function / interface declarations; no DOM-handle closure, no
// module singleton). These pure builders depend only on their params + each other + `SidebarCtx` /
// `PlanRecord` from `./types`. They emit LOAD-BEARING CSS class strings — copied verbatim from
// main.ts (`contract.test.ts` / the golden snapshots pin them). The STATEFUL sidebar core
// (`renderSidebar`, `buildFlatRow`, `buildMaster`, `applyFilterAndRender`, `makeSidebarCtx`,
// `refreshList`, `resolveSelection`, `onToggleCollapse`, `currentRecords`, `highlightVisibleRows`,
// `resetToEmptyPane`, `buildToc`) stays in main.ts — it reads `listState` / `selection` /
// `collapseOverride` / `subCollapse` / the cwd subsystem / DOM handles, and `CONTRACT.md` forbids the
// sidebar and reading-pane domains from importing each other (convergence only at main.ts).
//
// `SubTreeNode` is `export interface` here — the staying `renderSidebar` constructs `SubTreeNode`
// literals, so main imports the type back (it was never in main's public export surface). main.ts
// re-exports `placeholderVisible` + `initTabs` so their existing `./main` importers keep resolving
// unchanged; the other movers main still uses (`applyRowState`, `relativeTime`, `buildPlaceholderRow`,
// `renderSubTree`, `SubTreeNode`) are plain-imported back.

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

// Apply the shared per-row classes/state and click → onOpen wiring to a `.plan` row.
export function applyRowState(row: HTMLElement, rec: PlanRecord, ctx: SidebarCtx): void {
  row.dataset.path = rec.absolute_path;
  if (rec.unread) row.classList.add("unread");
  if (rec.absolute_path === ctx.openPath) row.classList.add("active");
  row.addEventListener("click", () => {
    ctx.onOpen(rec.absolute_path, rec.filename_stem);
  });
}

// Build a compact sub row: `.plan.sub[data-path]` > `.plan-row` = `.seq`(FULL dotted nn_path,
// e.g. "02.01") + title + unread dot ONLY (no cwd/timestamp). The seq label derives EXCLUSIVELY
// from `nn_path` — NEVER from first-segment `nn` (labelling a "02.01" child by `nn` would render
// a colliding duplicate "02" row). A null nn_path (legacy sub with no frontmatter nn) keeps the
// pre-existing "00" placeholder.
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

// Key for the SESSION-ONLY internal-node collapse map: tree_id + nn_path, NUL-joined so the two
// segments can never collide with each other's content. Deliberately disjoint from the persisted
// master collapse store (set_tree_collapsed) — internal-node collapse is never persisted.
function subCollapseKey(treeId: string, nnPath: string): string {
  return treeId + "\u0000" + nnPath;
}

// Build an INTERNAL sub node — a sub with nested dotted children. Mirrors buildMaster's
// affordances on the compact sub row: a `.sub-node` wrapper holding the `.plan.sub` row (PLUS a
// leading `.twirl` and a trailing per-node `.child-count` of its DIRECT children) and a nested
// `.children` container. Collapse is session-only: the twirl mutates ctx.subCollapse and flips
// the wrapper class directly (instant feedback, no backend call, no re-list).
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
  twirl.textContent = "▾"; // ▾
  twirl.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !(ctx.subCollapse.get(key) ?? false);
    ctx.subCollapse.set(key, next);
    wrapper.classList.toggle("collapsed", next);
  });
  planRow.insertBefore(twirl, planRow.firstChild);

  // Per-node "N sub-plans" count of DIRECT children only (singular at 1).
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

// A parsed sub-tree node for one master's run of sub records. `kids` is filled by the
// prefix-stack walk below; a node renders INTERNAL iff it actually accumulated kids (so a
// duplicate dotted id whose extensions attached to a LATER duplicate stays a plain leaf).
export interface SubTreeNode {
  rec: PlanRecord;
  kids: SubTreeNode[];
}

// Render one parsed sub-tree into `container`: leaves via buildSub (byte-identical to the flat
// legacy shape — affordances appear ONLY when children exist), internal nodes via buildInternalSub
// with their kids rendered recursively into the nested `.children`.
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

// Build the `.plan.placeholder` row for a live run with no real sidebar row yet (Bug A fix).
// `.plan`-shaped (so it inherits row styling) but carries data-tree-id and NO data-path: there is
// no file to open, so openPlan's `[data-path]` selection loop structurally cannot touch it. Click
// routes to ctx.onPlaceholderOpen (flip to the Conversation tab + select the placeholder).
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

// THE SINGLE placeholder-visibility predicate (shared by renderSidebar AND applyFilterAndRender's
// `.filter-empty` branch so the two sites cannot drift): the live-run placeholder renders only
// while NO rendered record carries its tree_id — once the real row exists it takes over. EXPORTED
// for unit tests.
export function placeholderVisible(
  ph: { treeId: string } | null,
  records: PlanRecord[],
): boolean {
  return ph !== null && !records.some((r) => r.tree_id === ph.treeId);
}

// Wire tab switching: a click on a `.tab` makes it (and the matching `.tab-pane`) the only
// active one. Toggling tabs is a pure view switch — it never rebuilds either pane's content.
// EXPORTED so the toggle wiring is unit-testable against the real code.
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
