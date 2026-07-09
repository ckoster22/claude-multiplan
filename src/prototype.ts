// Visual-prototype review gate — PURE, DOM-free, invoke-free helpers.
//
// Mirrors review.ts's discipline: no imports from main.ts, no DOM, no Tauri. main.ts consumes
// these to (a) compose the detached reading-pane preview for a held PrototypeGate, (b) derive the
// review bar's PROTOTYPE mode (labels + precedence), and (c) pick the file the "Open in browser"
// button hands to the `open_prototype` Rust command. Everything here is unit-testable in
// isolation exactly like review.ts / feedback.ts.
//
// ROUND SEMANTICS (driver-owned — see orchestrator.ts's prototypeRound discipline): gates carry a
// 1-BASED round ("which prototype round produced this gate"); the driver mints round 1 first and
// increments ONLY on refinePrototype. The UI's loop-escape threshold is round >= 3: from the third
// round on, the approve affordance relabels to "Proceed as-is" so the loop always has an exit.

import type { PrototypeGate, AcceptanceGate, PendingGate, TreeNode } from "./conversation/plan-tree";
import { pathKey } from "./conversation/plan-tree";

// The displayed round ceiling (the loop-escape threshold). Display-only: the orchestrator never
// hard-stops the loop; the bar just stops counting past 3 and offers "Proceed as-is".
export const PROTOTYPE_MAX_ROUNDS = 3;

// Fence `body` as a markdown code block. `lang` "" yields a plain fence. If the body itself
// contains a triple-backtick run, the fence widens to one backtick more than the longest run so
// the preview can never be broken out of (standard CommonMark longer-fence rule).
function fence(lang: string, body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 2);
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${body}\n${f}`;
}

// The fence language for a gate kind: mermaid previews render through the existing mermaid fence
// pipeline; ascii/table previews are plain fenced blocks (monospace, no highlighting surprises).
function fenceLangFor(kind: PrototypeGate["kind"]): string {
  return kind === "mermaid" ? "mermaid" : "";
}

/**
 * PURE: compose the markdown the reading pane renders (detached — never written to disk, never
 * opening a plan path) for a held visual-prototype gate.
 *   - kind "mermaid"        → the inlinePreview in a ```mermaid fence (the pane's existing
 *                             mermaid pipeline renders it).
 *   - kind "ascii"/"table"  → the inlinePreview in a plain fence.
 *   - kind "html"           → a short notice (HTML cannot render inline) listing the on-disk
 *                             paths and pointing at the bar's "Open in browser" button.
 *   - variants (any kind)   → each appended under a `### <label>` heading with its own fenced
 *                             inlinePreview (or its path when no inline preview exists).
 */
export function composePreviewMarkdown(gate: PrototypeGate): string {
  const sections: string[] = [];
  if (gate.kind === "html") {
    const list = gate.paths.map((p) => `- \`${p}\``).join("\n");
    sections.push(
      "HTML prototype ready — use **Preview in app** (or **Open in browser**) below." +
        (gate.paths.length > 0 ? `\n\n${list}` : ""),
    );
  } else if (gate.inlinePreview !== null && gate.inlinePreview !== "") {
    sections.push(fence(fenceLangFor(gate.kind), gate.inlinePreview));
  } else {
    // Non-HTML kinds are expected to carry an inline preview; degrade to the paths when absent.
    const list = gate.paths.map((p) => `- \`${p}\``).join("\n");
    sections.push(
      "_No inline preview was provided._" + (gate.paths.length > 0 ? `\n\n${list}` : ""),
    );
  }
  for (const v of gate.variants) {
    const lines = [`### ${v.label}`];
    if (v.inlinePreview !== null && v.inlinePreview !== "") {
      lines.push("", fence(fenceLangFor(gate.kind), v.inlinePreview));
    } else if (v.path !== null) {
      lines.push("", `\`${v.path}\``);
    }
    sections.push(lines.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * PURE: the review bar's PROTOTYPE-mode label. Rounds are 1-based; display clamps to the
 * [1, PROTOTYPE_MAX_ROUNDS] window (the driver can mint round 4+ after repeated refines — the
 * label keeps reading "round 3 of 3" while the approve label has already flipped to
 * "Proceed as-is").
 */
export function prototypeBarLabel(round: number): string {
  const n = Math.min(Math.max(round, 1), PROTOTYPE_MAX_ROUNDS);
  return `Visual prototype — round ${n} of ${PROTOTYPE_MAX_ROUNDS}`;
}

/**
 * PURE: the approve button's PROTOTYPE-mode label. Always enabled; from round 3 on it relabels to
 * "Proceed as-is" — the loop-escape affordance (the action is identical: approvePrototype()).
 */
export function prototypeApproveLabel(round: number): string {
  // INVARIANT[prototype-loop-always-has-an-escape] (runtime-guard): from round >= PROTOTYPE_MAX_ROUNDS the approve affordance relabels to "Proceed as-is", guaranteeing a loop exit.
  //   prevents: an unbounded refine loop with no as-is exit
  return round >= PROTOTYPE_MAX_ROUNDS ? "Proceed as-is" : "Approve visual";
}

/**
 * PURE: returns the prototype gate iff the currently-held gate (if any) is of kind "prototype";
 * returns null for any other kind or when orchestration is inactive. Derives STRICTLY from the
 * orchestrator SNAPSHOT (never module state) so the gate self-clears: the reducer nulls
 * `pendingGate` on PROTOTYPE_APPROVED/PROTOTYPE_REFINED and the next onSnapshot reverts the bar
 * with no bookkeeping.
 */
// INVARIANT[gate-self-clears-from-snapshot] (convention): the prototype/acceptance bar modes derive strictly from the orchestrator snapshot (never module state), so nulling the gate in the reducer reverts the bar on the next onSnapshot.
//   prevents: a stale held-gate flag keeping the bar in PROTOTYPE/ACCEPTANCE after the gate resolved
export function prototypeGateActive(
  snap: { pendingGate: PendingGate | null } | null,
  orchestrationActive: boolean,
): PrototypeGate | null {
  if (!orchestrationActive || snap === null) return null;
  return snap.pendingGate?.kind === "prototype" ? snap.pendingGate.gate : null;
}

/**
 * PURE: the file the "Open in browser" button targets — the gate's `index.html` path when one is
 * present, else the first path, else null (nothing to open; the caller no-ops). Paths may be
 * relative to the gate's cwd; the `open_prototype` Rust command resolves them.
 */
export function prototypeOpenTarget(gate: Pick<PrototypeGate, "paths">): string | null {
  const index = gate.paths.find((p) => p === "index.html" || p.endsWith("/index.html"));
  return index ?? gate.paths[0] ?? null;
}

// A reference is "external" (breaks under srcdoc) unless it is one of these self-resolving schemes.
// A leading `/` (root-relative) and a protocol-relative `//host/...` both break under srcdoc — the
// former has no document base URL, the latter resolves against the app scheme (tauri://) and fails
// to load — so neither is listed here; both are treated as external → flagged.
const SELF_RESOLVING = /^(?:https?:|data:|blob:|#|mailto:|tel:|javascript:|about:)/i;

function isRelativeRef(raw: string | null | undefined): boolean {
  const ref = (raw ?? "").trim();
  if (ref === "") return false;
  return !SELF_RESOLVING.test(ref);
}

// Split a `srcset` value ("a.png 1x, b.png 2x") into its candidate URLs (first token of each entry).
function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((u) => u !== "");
}

// Extract the URLs referenced by CSS text: `@import "..."`/`@import url(...)` and every `url(...)`.
function cssUrls(css: string): string[] {
  const urls: string[] = [];
  const urlFn = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlFn.exec(css)) !== null) urls.push(m[2]);
  const importBare = /@import\s+(['"])([^'"]+)\1/gi;
  while ((m = importBare.exec(css)) !== null) urls.push(m[2]);
  return urls;
}

/**
 * PURE: does this HTML reference any RELATIVE subresource that would 404 under a `srcdoc` iframe
 * (which has no base URL)? Parses with `DOMParser` (never a regex over unparsed HTML) and inspects
 * every subresource vector — `src`, `<link href>`, `srcset`, SVG `<use href>`/`xlink:href`,
 * `<object data>`/`<embed src>`, and `url(...)`/`@import` inside `<style>` and inline `style=""`.
 * Flags TRUE on ANY relative ref. We err toward over-flagging: a false positive routes a prototype
 * that would have worked to the browser (benign); a false negative renders a silently-broken iframe.
 */
export function referencesExternalFiles(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const el of doc.querySelectorAll<HTMLElement>("[src]")) {
    if (isRelativeRef(el.getAttribute("src"))) return true;
  }
  for (const link of doc.querySelectorAll("link[href]")) {
    if (isRelativeRef(link.getAttribute("href"))) return true;
  }
  for (const el of doc.querySelectorAll("[srcset]")) {
    if (srcsetUrls(el.getAttribute("srcset") ?? "").some(isRelativeRef)) return true;
  }
  for (const use of doc.querySelectorAll("use")) {
    if (isRelativeRef(use.getAttribute("href"))) return true;
    if (isRelativeRef(use.getAttribute("xlink:href"))) return true;
  }
  for (const obj of doc.querySelectorAll("object[data]")) {
    if (isRelativeRef(obj.getAttribute("data"))) return true;
  }
  for (const style of doc.querySelectorAll("style")) {
    if (cssUrls(style.textContent ?? "").some(isRelativeRef)) return true;
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[style]")) {
    if (cssUrls(el.getAttribute("style") ?? "").some(isRelativeRef)) return true;
  }
  return false;
}

/**
 * PURE: returns the acceptance gate iff the currently-held gate (if any) is of kind "acceptance";
 * returns null for any other kind or when orchestration is inactive. Derives STRICTLY from the
 * orchestrator SNAPSHOT (never module state) so the gate self-clears: the reducer nulls
 * `pendingGate` on ACCEPTANCE_APPROVED/DIVERGED and the next onSnapshot reverts the bar with no
 * bookkeeping.
 */
export function acceptanceGateActive(
  snap: { pendingGate: PendingGate | null } | null,
  orchestrationActive: boolean,
): AcceptanceGate | null {
  if (!orchestrationActive || snap === null) return null;
  return snap.pendingGate?.kind === "acceptance" ? snap.pendingGate.gate : null;
}

/**
 * PURE: the acceptance bar's label. The run is built; the user must record a verdict against the
 * frozen working-reference baseline before the run is reported done.
 */
export function acceptanceBarLabel(): string {
  return "Acceptance — does the build meet the baseline floor?";
}

/** PURE: the acceptance bar's Approve-button label (the build clears the floor). */
export function acceptanceApproveLabel(): string {
  return "Accept (meets baseline)";
}

/** PURE: the acceptance bar's diverge-button label (accept a result below the floor, with a reason). */
export function acceptanceDivergeLabel(): string {
  return "Accept divergence…";
}

/** PURE: the acceptance bar's REFINE-button label (re-plan a sub-plan — the third gate action). */
export function acceptanceRefineLabel(): string {
  return "Refine a sub-plan…";
}

/**
 * PURE: the refinable sub-plan TARGETS for the forced-acceptance refine action — the ROOT's DIRECT
 * children (the top-level sub-plans the gate surfaces). Each carries its canonical dotted pathKey
 * (the `target` refineAcceptance takes, parsed back via parsePathKey) and its human title (for the
 * picker). Returns [] when the root is not a split (e.g. a single-leaf run has no sub-plans to
 * refine). DERIVES from the tree alone so the picker self-updates with the snapshot.
 */
export function acceptanceRefineTargets(root: TreeNode): Array<{ pathKey: string; title: string }> {
  // INVARIANT[acceptance-refine-targets-from-root-children] (runtime-guard): refine targets are the root's direct children only, and [] unless the root is split — empty for a single-leaf run.
  //   prevents: offering refine targets that don't exist on a leaf-only tree
  if (root.state.stage !== "split") return [];
  return root.state.children.map((c) => ({ pathKey: pathKey([c.nn]), title: c.title }));
}
