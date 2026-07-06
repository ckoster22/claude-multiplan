import { asStem, cwdState, type AbsPath, type PlanRecord, type Stem } from "./types";

// pure display helper for the resolved cwd subtitle.
//
// The resolved cwd comes back from the backend as an ABSOLUTE path. For display we collapse
// a leading `$HOME` into `~` (the CSS `.plan-src` rule then left-truncates, keeping the tail
// dir visible). Kept pure + dependency-free so it is unit-testable in isolation; `main.ts`
// resolves the actual home directory once via Tauri's `homeDir()` and passes it in.

/**
 * Replace a leading `home` segment of `path` with `~`. If `home` is empty or `path` is not
 * under `home` at a path boundary, returns `path` unchanged. Mirrors the Rust `collapse_home`
 * reference in `src-tauri/src/lib.rs`.
 *
 * The boundary check (next char is `/` or end-of-string) prevents `/Users/bobby` collapsing
 * under home `/Users/bob`. A trailing slash on `home` is normalized away first.
 */
export function collapseHome(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === h) return "~";
  if (path.startsWith(h + "/")) {
    return "~" + path.slice(h.length);
  }
  return path;
}

/**
 * The exact inverse of `collapseHome`: replace a leading `~` segment of `path` with `home`, so a
 * display-collapsed cwd round-trips back to the ABSOLUTE path the Rust backend expects. Only a bare
 * `~` or a `~/`-prefixed path is expanded (the boundary mirrors `collapseHome`); any other path —
 * including one already absolute, or a `~user`-style prefix we never emit — is returned unchanged.
 * Returns `path` unchanged when `home` is empty (no home to expand into).
 *
 * Load-bearing for the resume read path: `resolvedCwdFor` runs a record's cwd through this before
 * handing it to `read_plan_tree_file`, which does NOT expand `~` (a `~`-path would `is_dir()`-fail).
 */
export function expandHome(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === "~") return h;
  if (path.startsWith("~/")) {
    return h + path.slice(1);
  }
  return path;
}

// ---- cwd resolution state (sidebar-only) ------------------------------------------------------

// The user's home dir, fetched once at startup. Used to collapse a resolved absolute cwd
// into a `~/…` display path. Null until fetched (then we render the absolute path verbatim).
// Owned via get/set — ESM cannot reassign an imported binding, so `main` mutates through setHomePath.
let homePath: string | null = null;

export function getHomePath(): string | null {
  return homePath;
}

export function setHomePath(next: string | null): void {
  homePath = next;
}

// filename_stem -> resolved cwd display string. Mirrors the backend cwd cache once a
// `resolve_cwds` call returns. `null` means "resolved but unknown" (show "unknown");
// an ABSENT key means "not yet resolved" (show empty — no "unknown" flash).
export const cwdByStem = new Map<Stem, string | null>();

// filename_stem of every stem currently in-flight to the backend (or terminally resolved), so
// a stream of `plan-changed` events never re-triggers a full corpus rescan for a stem while one
// is in flight. A `null` (unknown) result under the attempt cap is RELEASED from this set so a
// later event can re-attempt it (see `resolve.ts`); once it hits the cap it stays here.
export const attemptedStems = new Set<Stem>();

// Per-stem count of how many times we have asked the backend to resolve it. A stem that keeps
// resolving to `null` ("unknown") is re-attempted up to `MAX_RESOLVE_ATTEMPTS` times so a
// transcript written shortly after the plan file is eventually picked up; past the cap it is
// pinned "unknown" (no unbounded rescans).
export const resolveAttemptCounts = new Map<Stem, number>();

// Map a resolved cwd (absolute) to its sidebar display form (home-collapsed, else verbatim).
export function displayCwd(absCwd: string): string {
  return homePath ? collapseHome(absCwd, homePath) : absCwd;
}

// Parent directory of an absolute path — used as the base for resolving a plan's
// relative image srcs. Strips the trailing `/<filename>`; falls back to the path
// itself if it has no separator.
export function dirOf(absPath: AbsPath): string {
  const idx = absPath.lastIndexOf("/");
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}

// Decide the `.plan-src` text for a record. Precedence: backend-cached `rec.cwd` (absolute)
// wins; otherwise consult `cwdByStem` (populated by a completed `resolve_cwds`). The two
// states a row can be in before/after resolution:
//   - not yet resolved (no cache hit, stem absent from cwdByStem) ⇒ "" (empty — no flash)
//   - resolved to a path ⇒ home-collapsed display
//   - resolved but unknown (cwdByStem has null) ⇒ "unknown"
export function planSrcText(rec: PlanRecord): string {
  // Prior gate (NOT part of the three-state machine): a backend-cached absolute cwd wins.
  if (rec.cwd) return displayCwd(rec.cwd);
  const s = cwdState(cwdByStem, rec.filename_stem);
  switch (s.state) {
    case "unresolved":
      return ""; // not yet resolved → empty (no "unknown" flash)
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// The `.plan-src` / `#doc-src` text for a stem from the resolved cache alone (empty until
// resolved; "unknown" once resolved-but-null; home-collapsed path once resolved).
export function cwdDisplayForStem(stem: Stem): string {
  const s = cwdState(cwdByStem, stem);
  switch (s.state) {
    case "unresolved":
      return "";
    case "unknown":
      return "unknown";
    case "resolved":
      return displayCwd(s.path);
    default: {
      const _x: never = s;
      return _x;
    }
  }
}

// Filename stem (no `.md`) from an absolute plan path. Mirrors the backend stem.
export function stemFromPath(absPath: AbsPath): Stem {
  const base = absPath.slice(absPath.lastIndexOf("/") + 1);
  return asStem(base.endsWith(".md") ? base.slice(0, -3) : base);
}

// Resolve a plan record's originating cwd for the resume read path. Mirrors planSrcText's
// precedence (backend-cached absolute cwd wins; else the resolved cwdByStem path) but returns the
// ABSOLUTE path (never the home-collapsed display form) — the resume reads the real `.plan-tree/`.
// Returns null when the cwd is not yet resolved or resolved-but-unknown: with no real directory
// there is nothing to read, so detectResumable returns null (no banner).
export function resolvedCwdFor(rec: PlanRecord): string | null {
  // BELT-AND-SUSPENDERS: expand a leading `~/` (or bare `~`) back to the absolute home path before
  // the resume read. `patchAllCwds` syncs the home-COLLAPSED display string onto `rec.cwd` (so the
  // sidebar filter matches the visible `~`-form); but `read_plan_tree_file` does NOT expand `~`, so a
  // `~`-path would `is_dir()`-fail in Rust and silently kill the Resume banner. expandHome is a no-op
  // on an already-absolute path, so resolved-from-cache (absolute) cwds are unaffected.
  const raw = rec.cwd ? rec.cwd : cwdStateResolvedPath(rec);
  if (raw === null) return null;
  const home = getHomePath();
  return home ? expandHome(raw, home) : raw;
}

// The resolved (absolute) cwd for a record from the resolve cache alone, or null when it is not yet
// resolved or resolved-but-unknown. Split out of resolvedCwdFor so the `~`-expansion above applies
// uniformly to both the backend-cached cwd and the cache-resolved path.
function cwdStateResolvedPath(rec: PlanRecord): string | null {
  const s = cwdState(cwdByStem, rec.filename_stem);
  return s.state === "resolved" ? s.path : null;
}
