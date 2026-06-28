// ---- RemoteData: a five-state model for an asynchronous read ----------------------------------
//
// Replaces the classic `{ loading: bool; data: T | null; error: string | null }` bag — which is
// representable in 8 ways (2³) but only 4 of those combinations are coherent — with a tagged union
// whose ONLY inhabitable states are the legal ones. "Empty result" is promoted to its own state
// (`zeroResults`) so a successful-but-empty read is not confused with `initial`/`null`.
//
// INVARIANT[remote-data-exhaustive-five-state] (type-level): folding a RemoteData via match() (all five states) or matchScalar() (the four reachable states) is exhaustive — the cases object requires every handler key, so a missing case is a compile error and each fold ends in assertNever; matchScalar accepts only ScalarRemoteData (zeroResults excluded by type), so a possibly-empty source cannot bypass the empty state.
//   prevents: a consumer routed through match()/matchScalar() silently ignoring the loading/empty/error states — stale data mid-fetch or a missing empty-state UI — and a collection read mis-routed through the scalar fold turning a legitimate empty result into a false error. (It does NOT prevent swallowed errors at leaf reads: unwrapOr is the sanctioned escape hatch that deliberately collapses error→fallback.)
export type RemoteData<T> =
  | { kind: "initial" }
  | { kind: "fetching" }
  | { kind: "zeroResults" }
  | { kind: "success"; data: T }
  | { kind: "error"; message: string };

// The five-state model minus the empty state. `matchScalar` accepts ONLY this type, so a
// possibly-empty source (anything typed as the full `RemoteData<T>`, e.g. the result of
// `fromArray`) is not assignable and cannot be routed through the scalar fold — the empty case
// cannot be bypassed.
export type ScalarRemoteData<T> = Exclude<RemoteData<T>, { kind: "zeroResults" }>;

// ---- Constructors -----------------------------------------------------------------------------
//
// Each constructor returns its EXACT singleton variant (not the whole union). That keeps the result
// assignable to `RemoteData<T>` (it is one of its members) AND — for the four non-empty variants —
// to `ScalarRemoteData<T>`, so `initial()`/`fetching()`/`success()`/`failure()` flow into
// `matchScalar` while `zeroResults()` does not. `failure` is named (not `error`) to avoid shadowing
// `catch (error)` locals and for readability; its discriminant value stays `"error"`.
export const initial = (): { kind: "initial" } => ({ kind: "initial" });
export const fetching = (): { kind: "fetching" } => ({ kind: "fetching" });
export const zeroResults = (): { kind: "zeroResults" } => ({ kind: "zeroResults" });
export const success = <T>(data: T): { kind: "success"; data: T } => ({ kind: "success", data });
export const failure = (message: string): { kind: "error"; message: string } => ({
  kind: "error",
  message,
});

// ---- Boundary producers -----------------------------------------------------------------------
//
// The ONLY emitters of `zeroResults`. Parse at the boundary (a collection read / a nullable read)
// into the five-state model so internal code never re-checks `.length === 0` or `=== null`.
// `fromArray` keeps the array MUTABLE (`T[]`, not `readonly T[]`) so downstream collection consumers
// (`PlanRecord[]`, `CommentRecord[]`) are not forced to ripple `readonly` through their types.
export function fromArray<T>(xs: T[]): RemoteData<T[]> {
  return xs.length === 0 ? zeroResults() : success(xs);
}

// NOTE: only `null`/`undefined` map to `zeroResults`. Falsy-but-present values (`0`, `""`, `false`,
// `NaN`) are real data and map to `success` — an `x ? ... : ...` check here would be a bug.
export const fromNullable = <T>(x: T | null | undefined): RemoteData<T> =>
  x === null || x === undefined ? zeroResults() : success(x);

// ---- Exhaustiveness sentinel ------------------------------------------------------------------
//
// Reached only if a discriminated-union case is missing from a fold's switch. Because every case
// `return`s, a missing branch leaves the discriminant non-`never` at this call — a compile-time
// error — and, defensively at runtime, throws. (Mirrors the orchestrator's `assertNever`; defined
// locally rather than imported across domains.)
function assertNever(x: never): never {
  throw new Error(`unreachable RemoteData state: ${String(x)}`);
}

// ---- Exhaustive match -------------------------------------------------------------------------
//
// All five handler keys are REQUIRED — there is no `default`/optional arm. A missing case is a
// compile error (the cases object is not assignable); a future sixth state breaks the switch's
// exhaustiveness, failing `assertNever`.
export interface RemoteCases<T, R> {
  initial: () => R;
  fetching: () => R;
  zeroResults: () => R;
  success: (data: T) => R;
  error: (message: string) => R;
}

export function match<T, R>(rd: RemoteData<T>, cases: RemoteCases<T, R>): R {
  switch (rd.kind) {
    case "initial":
      return cases.initial();
    case "fetching":
      return cases.fetching();
    case "zeroResults":
      return cases.zeroResults();
    case "success":
      return cases.success(rd.data);
    case "error":
      return cases.error(rd.message);
    default:
      return assertNever(rd);
  }
}

// ---- Scalar match -----------------------------------------------------------------------------
//
// For reads whose producer never emits `zeroResults` (a scalar/single-value read, not a collection
// or nullable). Its input is `ScalarRemoteData<T>`, so the empty state is excluded BY TYPE: a
// possibly-empty source cannot be routed here at all (it fails to compile) — there is no runtime
// "unexpected empty" routing because the state is unreachable. Only the 4 reachable handlers are
// required; the switch still ends in `assertNever`, catching a future sixth state.
export interface ScalarCases<T, R> {
  initial: () => R;
  fetching: () => R;
  success: (data: T) => R;
  error: (message: string) => R;
}

export function matchScalar<T, R>(rd: ScalarRemoteData<T>, cases: ScalarCases<T, R>): R {
  switch (rd.kind) {
    case "initial":
      return cases.initial();
    case "fetching":
      return cases.fetching();
    case "success":
      return cases.success(rd.data);
    case "error":
      return cases.error(rd.message);
    default:
      return assertNever(rd);
  }
}

// ---- Transform --------------------------------------------------------------------------------
//
// Maps over the `success` payload only; the other four states pass through unchanged (and, being
// payload-free or T-independent, are reference-identical on the way out).
export function mapData<T, U>(rd: RemoteData<T>, f: (data: T) => U): RemoteData<U> {
  return rd.kind === "success" ? { kind: "success", data: f(rd.data) } : rd;
}

// ---- Unwrap -----------------------------------------------------------------------------------
//
// Returns the `success` payload, or `fallback` for every other state (initial/fetching/zeroResults/
// error). A leaf escape hatch out of the model — prefer `match`/`matchScalar` where a state-specific
// response is needed.
export function unwrapOr<T>(rd: RemoteData<T>, fallback: T): T {
  return rd.kind === "success" ? rd.data : fallback;
}

// ---- Type guards ------------------------------------------------------------------------------
//
// All five are type predicates: a truthy guard narrows `rd` to the matching variant at the call
// site (the success/error guards additionally surface `.data`/`.message`).
export const isInitial = <T>(rd: RemoteData<T>): rd is { kind: "initial" } => rd.kind === "initial";
export const isFetching = <T>(rd: RemoteData<T>): rd is { kind: "fetching" } =>
  rd.kind === "fetching";
export const isZeroResults = <T>(rd: RemoteData<T>): rd is { kind: "zeroResults" } =>
  rd.kind === "zeroResults";
export const isSuccess = <T>(rd: RemoteData<T>): rd is { kind: "success"; data: T } =>
  rd.kind === "success";
export const isError = <T>(rd: RemoteData<T>): rd is { kind: "error"; message: string } =>
  rd.kind === "error";
