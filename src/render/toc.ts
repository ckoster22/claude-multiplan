// Table-of-contents extraction from the rendered reading pane.
//
// This is the ONE sanctioned read-only data flow from the reading-pane domain to
// the sidebar domain (CLAUDE.md keeps those domains disjoint). The
// render layer PRODUCES a plain `TocEntry[]`; the sidebar CONSUMES it to build
// `#toc-list`. The sidebar never queries `#reading-pane` itself.
//
// Anchoring reuses the existing `data-source-line` attribute that markdown.ts
// already stamps on every heading (the SAME anchor key captureAnchor/applyDelta
// use). `extractToc` is strictly READ-ONLY on the pane — it mints no new id or
// attribute, so it never becomes a second writer of `#reading-pane` and never
// creates positionally-stale keys across live reloads.
//
// `buildToc`/`rebuildTocFromPane` are the DOM-writing half. They reach the reading-pane / ToC handles
// through this module's OWN injection seam (`initToc`) rather than `../app-state`: the render facade
// re-exports this module, so importing app-state here would close a src/render ↔ app-state module cycle
// that deadlocks vite's module runner.

import { scrollToHeading } from "./scroll";

// Injected once by `main`; defaults null-yielding for unit tests.
let getTocListEl: () => HTMLElement | null = () => null;
let getReadingPaneEl: () => HTMLElement | null = () => null;
let getReaderScrollEl: () => HTMLElement | null = () => null;

export function initToc(deps: {
  tocListEl: () => HTMLElement | null;
  readingPaneEl: () => HTMLElement | null;
  readerScrollEl: () => HTMLElement | null;
}): void {
  getTocListEl = deps.tocListEl;
  getReadingPaneEl = deps.readingPaneEl;
  getReaderScrollEl = deps.readerScrollEl;
}

/** A single ToC row: an H1 or H2 from the rendered pane. */
export interface TocEntry {
  /** Heading depth — only H1 and H2 are surfaced. */
  level: 1 | 2;
  /** Visible heading text (trimmed); `"(untitled)"` when the heading is empty. */
  text: string;
  /** The heading's existing `data-source-line` value (the scroll anchor key). */
  line: number;
}

/** Placeholder text for a heading with no visible text (e.g. image-only). */
const UNTITLED = "(untitled)";

/**
 * Walk the rendered pane for `h1, h2` in document order and return a plain
 * `TocEntry[]`. Read-only: records each heading's existing `data-source-line`
 * and trimmed `textContent` (falling back to `"(untitled)"` when empty). H3–H6
 * are excluded. Mints NO attributes on the pane.
 */
export function extractToc(paneEl: HTMLElement): TocEntry[] {
  const entries: TocEntry[] = [];
  const headings = paneEl.querySelectorAll<HTMLElement>("h1, h2");
  for (const el of Array.from(headings)) {
    const level: 1 | 2 = el.tagName === "H1" ? 1 : 2;
    const raw = el.textContent?.trim();
    const text = raw && raw.length > 0 ? raw : UNTITLED;
    const line = Number(el.getAttribute("data-source-line"));
    entries.push({ level, text, line });
  }
  return entries;
}

// Render a ToC into `listEl` from a plain entry list. One `.toc-item.toc-h1|.toc-h2` per entry
// carrying `data-line`; a click smooth-scrolls the reader to that heading and flashes the
// clicked row only (transient affordance — NOT scroll-spy). An EMPTY list renders the
// `.toc-empty` "No headings" affordance (caller only passes [] when a plan IS open — the
// nothing-open state clears the list instead). MUST NOT touch any `.tab`/`.tab-pane` `.active`
// class: the active tab is preserved across both open and live reload (no auto-switch).
export function buildToc(listEl: HTMLElement, entries: TocEntry[]): void {
  listEl.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "No headings";
    listEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("a");
    item.className = `toc-item toc-h${entry.level}`;
    item.dataset.line = String(entry.line);
    item.textContent = entry.text;
    item.addEventListener("click", () => {
      const scrollEl = getReaderScrollEl();
      const paneEl = getReadingPaneEl();
      if (scrollEl && paneEl) {
        scrollToHeading(scrollEl, paneEl, entry.line);
      }
      // Flash the clicked row only, then clear (transient click affordance, no scroll-spy).
      for (const el of Array.from(listEl.querySelectorAll(".toc-item.flash"))) {
        el.classList.remove("flash");
      }
      item.classList.add("flash");
      setTimeout(() => item.classList.remove("flash"), 600);
    });
    listEl.appendChild(item);
  }
}

// Rebuild the ToC from the current rendered pane. Called ONLY from inside the render-generation
// guarded region in openPlan/reloadOpenPlan (after the final isCurrent check passes) so a
// superseded render can never clobber a newer render's ToC. Never changes the active tab.
export function rebuildTocFromPane(): void {
  const listEl = getTocListEl();
  const paneEl = getReadingPaneEl();
  if (!listEl || !paneEl) return;
  buildToc(listEl, extractToc(paneEl));
}
