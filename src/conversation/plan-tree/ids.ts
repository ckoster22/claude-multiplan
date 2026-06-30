// Multiplan plan-tree package — LEAF: branded id/path primitives (the lowest leaf; no internal deps).
//
// Branded domain primitives that make the invalid representations uncompilable, plus the typed
// recoverable plan-validation error. PURE — no I/O, no Tauri, no DOM. Every other leaf in the
// package depends on this one; this leaf depends on nothing internal.

// ---- branded domain primitives (make the invalid representations uncompilable) ---------------

// An absolute path PROVEN to come from a real plan-tree write — minted ONLY by the driver's wrapper
// around the write command's returned path (orchestrator.ts). There is deliberately NO exported cast
// helper: prose/summary TEXT can never flow into a `summaryPath` slot without failing tsc (the
// text-as-path bug this brand eliminates).
export type PlanTreeFilePath = string & { __brand: "PlanTreeFilePath" };

// A sub-plan number, PROVEN to be an integer in 1–99 (the `NN-(plan|summary).md` two-digit on-disk
// shape). Minted ONLY by parseNn — the single validation boundary — so a 3-digit header can never be
// silently truncated or carried into summaryName.
export type Nn = number & { __brand: "Nn" };

// THE single Nn boundary: every raw number entering the domain (parsed headers, UI gate clicks)
// passes through here. Throws LOUDLY on anything outside the representable 1–99 range — never a
// silent drop.
export function parseNn(n: number): Nn {
  if (!Number.isInteger(n) || n < 1 || n > 99) {
    throw new Error(`invalid sub-plan number ${n}: must be an integer in 1-99`);
  }
  return n as Nn;
}

// ---- gen-2 branded path primitives ------------------------------------------------------------

// A node's address in the tree: the Nn segments from the root down (root itself is `[]`). Nodes
// store only their OWN segment (`TreeNode.nn`); full paths derive from nesting.
export type NodePath = readonly Nn[];

// The canonical string form of a NodePath, branded so a bare string can never be used as a path
// Map key — minted ONLY by pathKey() (zero-padded dotted, e.g. "02.01"; root [] → "").
export type PathKey = string & { __brand: "PathKey" };

// THE sole PathKey mint: zero-pad each segment to exactly two digits and join with ".". The root
// path [] mints the empty string. Total over NodePath — Nn's 1-99 brand guarantees two digits.
export function pathKey(path: NodePath): PathKey {
  return path.map((nn) => String(nn).padStart(2, "0")).join(".") as PathKey;
}

// THE sole PathKey inverse. Accepts ONLY the canonical padded form pathKey produces: "" (root) or
// two-digit segments joined by "." ("02", "02.01", ...). Anything else throws LOUDLY — an empty
// segment ("02..01"), non-digits, an UNPADDED segment ("2.1" — canonical-form-only is deliberate:
// accepting "2.1" would make two distinct strings denote one path and silently split Map keys),
// a 3+-digit segment ("002", "100"), or "00" (parseNn rejects 0).
export function parsePathKey(s: string): NodePath {
  if (s === "") return [];
  return s.split(".").map((seg) => {
    if (!/^\d{2}$/.test(seg)) {
      throw new Error(
        `invalid PathKey segment "${seg}" in "${s}": must be exactly two digits (canonical padded form)`,
      );
    }
    return parseNn(Number.parseInt(seg, 10));
  });
}

// ---- INV-2: typed plan-validation error -------------------------------------------------------

// A RECOVERABLE decomposition-plan validation failure — a malformed master/decomposition DRAFT that
// the user can fix by redrafting (zero `### Sub-Plan` headers, a header outside the 1-99 range, or an
// empty children list reaching the nonEmpty boundary). Thrown by parseSubPlanHeaders (orchestrator)
// and nonEmpty (here), discriminated by the orchestrator's `instanceof PlanValidationError` catch so
// the held ExitPlanMode is DENIED for a redraft (the run stays active) instead of dispatching FATAL.
// This is a TYPED discriminator, never a `message.startsWith(...)` string match: both the throwers
// and the catch live in the same Vite frontend bundle, so the class identity is reliable.
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
    // Restore the prototype chain so `instanceof PlanValidationError` holds even after TS downlevels
    // `extends Error` (the classic TS-extends-builtin trap).
    Object.setPrototypeOf(this, PlanValidationError.prototype);
  }
}

// ---- gen-2 non-empty array --------------------------------------------------------------------

// An array PROVEN non-empty at the type level — `children` on a split node uses this so an empty
// children list is unrepresentable at rest.
export type NonEmptyArray<T> = readonly [T, ...T[]];

// THE NonEmptyArray boundary: throws LOUDLY on an empty input (e.g. a decomposition that parsed
// zero children) instead of letting an empty split exist. INV-2: this is a PlanValidationError — a
// header-less decomposition that slips past parseSubPlanHeaders to here still denies-for-redraft (the
// orchestrator's instanceof catch covers it) rather than FATALing the whole run.
export function nonEmpty<T>(arr: readonly T[]): NonEmptyArray<T> {
  if (arr.length === 0) {
    throw new PlanValidationError("nonEmpty: array is empty — a split node must have at least one child");
  }
  return arr as unknown as NonEmptyArray<T>;
}
