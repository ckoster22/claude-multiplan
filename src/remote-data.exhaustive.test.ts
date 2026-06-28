import { describe, it, expect } from "vitest";
import { match, matchScalar, success, fromArray } from "./remote-data";

// PERMANENT compile-time exhaustiveness fixture for RemoteData. This file is under `src/`, which
// tsconfig.json type-checks (`"include": ["src"]`), so the `// @ts-expect-error` lines below are
// ENFORCED by `npx tsc --noEmit` (NOT by vitest — vitest's esbuild transform strips types and
// never sees them). If `match`/`matchScalar` stopped requiring every handler key — or if
// `matchScalar` widened its parameter back to the full `RemoteData<T>` — tsc would flag the now-
// unused `@ts-expect-error` and fail. (Verified by deleting a line and confirming tsc goes red,
// then restoring it.)
//
// Runtime safety: every call below resolves to the `success` handler (each value is `success(1)` or
// a non-empty `fromArray([1])`), so the deliberately-omitted handlers are never invoked at runtime.

// All five handlers present → compiles cleanly. Asserted at runtime so the file is also a live test.
const allFive: string = match<number, string>(success(1), {
  initial: () => "initial",
  fetching: () => "fetching",
  zeroResults: () => "zeroResults",
  success: (data) => `success:${data}`,
  error: (message) => `error:${message}`,
});

// FALSIFIED: make RemoteCases.zeroResults optional -> this @ts-expect-error becomes unused -> tsc red.
// @ts-expect-error omitting `zeroResults` violates RemoteCases — all five handler keys are required.
const missingZeroResults: string = match<number, string>(success(1), {
  initial: () => "initial",
  fetching: () => "fetching",
  success: (data) => `success:${data}`,
  error: (message) => `error:${message}`,
});

// `success(1)` returns the success singleton, which is assignable to `ScalarRemoteData<number>`, so
// this call satisfies matchScalar's parameter type.
// FALSIFIED: make ScalarCases.error optional -> this @ts-expect-error becomes unused -> tsc red.
// @ts-expect-error omitting `error` violates ScalarCases — all four reachable handler keys are required.
const missingError: string = matchScalar<number, string>(success(1), {
  initial: () => "initial",
  fetching: () => "fetching",
  success: (data) => `success:${data}`,
});

// A possibly-empty source is REJECTED by matchScalar at the type level: `fromArray([1])` is typed
// `RemoteData<number[]>` (it COULD be `zeroResults`), which is not assignable to the
// `ScalarRemoteData<number[]>` parameter — so empty cannot be silently turned into a false error.
// FALSIFIED: widen matchScalar's param back to RemoteData<T> -> this compiles -> @ts-expect-error unused -> tsc red.
// @ts-expect-error a possibly-empty RemoteData source is not a ScalarRemoteData — matchScalar rejects it by type.
const rejectsPossiblyEmpty: string = matchScalar(fromArray([1]), {
  initial: () => "initial",
  fetching: () => "fetching",
  success: (data) => `success:${data.length}`,
  error: (message) => `error:${message}`,
});

describe("RemoteData exhaustiveness (compile-time)", () => {
  it("a fully-handled match compiles and runs", () => {
    // The real assertions are the `@ts-expect-error` lines above, enforced by tsc. These runtime
    // checks just keep the locals live and confirm the success path runs as expected.
    expect(allFive).toBe("success:1");
    expect(missingZeroResults).toBe("success:1");
    expect(missingError).toBe("success:1");
    expect(rejectsPossiblyEmpty).toBe("success:1");
  });
});
