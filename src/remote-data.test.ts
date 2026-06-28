import { describe, it, expect } from "vitest";
import {
  initial,
  fetching,
  zeroResults,
  success,
  failure,
  fromArray,
  fromNullable,
  match,
  matchScalar,
  mapData,
  unwrapOr,
  isInitial,
  isFetching,
  isZeroResults,
  isSuccess,
  isError,
  type RemoteData,
  type ScalarRemoteData,
} from "./remote-data";

describe("constructors produce the exact tagged shape", () => {
  it("initial/fetching/zeroResults are payload-free", () => {
    expect(initial()).toEqual({ kind: "initial" });
    expect(fetching()).toEqual({ kind: "fetching" });
    expect(zeroResults()).toEqual({ kind: "zeroResults" });
  });

  it("success carries data; failure carries message under the `error` discriminant", () => {
    expect(success(42)).toEqual({ kind: "success", data: 42 });
    expect(success([1, 2])).toEqual({ kind: "success", data: [1, 2] });
    // `failure` is the constructor name, but the discriminant value is "error" (not "failure").
    expect(failure("boom")).toEqual({ kind: "error", message: "boom" });
  });

  it("each constructor returns its EXACT singleton variant (not the whole union)", () => {
    // These annotations only typecheck because the constructor return type is narrowed to the one
    // variant. If a constructor returned the whole `RemoteData<...>` union, the assignment would be
    // a compile error — so this pins the narrowing falsifiably (verified by tsc, not vitest).
    const i: { kind: "initial" } = initial();
    const f: { kind: "fetching" } = fetching();
    const z: { kind: "zeroResults" } = zeroResults();
    const s: { kind: "success"; data: number } = success(42);
    const e: { kind: "error"; message: string } = failure("boom");
    expect([i, f, z, s, e]).toEqual([
      { kind: "initial" },
      { kind: "fetching" },
      { kind: "zeroResults" },
      { kind: "success", data: 42 },
      { kind: "error", message: "boom" },
    ]);
  });
});

describe("fromArray boundary producer", () => {
  it("maps [] to zeroResults", () => {
    expect(fromArray([])).toEqual({ kind: "zeroResults" });
  });

  it("maps a non-empty array to success carrying that array", () => {
    expect(fromArray([1])).toEqual({ kind: "success", data: [1] });
    expect(fromArray(["a", "b"])).toEqual({ kind: "success", data: ["a", "b"] });
  });

  it("keeps the array MUTABLE (T[], not readonly T[])", () => {
    const rd = fromArray([1, 2, 3]);
    // The `.push` below only typechecks because `data` is a mutable `number[]`. If `fromArray`
    // returned `readonly T[]`, this would be a compile error — so the mutability is pinned by tsc.
    if (rd.kind === "success") {
      rd.data.push(4);
      expect(rd.data).toEqual([1, 2, 3, 4]);
    } else {
      throw new Error("expected success");
    }
  });
});

describe("fromNullable boundary producer", () => {
  it("maps null and undefined to zeroResults", () => {
    expect(fromNullable(null)).toEqual({ kind: "zeroResults" });
    expect(fromNullable(undefined)).toEqual({ kind: "zeroResults" });
  });

  it("treats falsy-but-present values as real data (NOT zeroResults)", () => {
    // The easy bug: `x ? success : zeroResults` would wrongly drop 0 / "" / false.
    expect(fromNullable(0)).toEqual({ kind: "success", data: 0 });
    expect(fromNullable("")).toEqual({ kind: "success", data: "" });
    expect(fromNullable(false)).toEqual({ kind: "success", data: false });
    expect(fromNullable(NaN)).toEqual({ kind: "success", data: NaN });
  });
});

describe("match invokes exactly the handler for the present variant", () => {
  const cases = {
    initial: () => "I",
    fetching: () => "F",
    zeroResults: () => "Z",
    success: (data: number) => `S:${data}`,
    error: (message: string) => `E:${message}`,
  };

  it("routes each of the five states to its handler", () => {
    expect(match(initial() as RemoteData<number>, cases)).toBe("I");
    expect(match(fetching() as RemoteData<number>, cases)).toBe("F");
    expect(match(zeroResults() as RemoteData<number>, cases)).toBe("Z");
    expect(match(success(7), cases)).toBe("S:7");
    expect(match(failure("nope") as RemoteData<number>, cases)).toBe("E:nope");
  });

  it("passes the payload through to success/error handlers", () => {
    const seen: unknown[] = [];
    match(success(99), {
      initial: () => undefined,
      fetching: () => undefined,
      zeroResults: () => undefined,
      success: (data) => {
        seen.push(data);
        return undefined;
      },
      error: () => undefined,
    });
    match(failure("kaboom") as RemoteData<number>, {
      initial: () => undefined,
      fetching: () => undefined,
      zeroResults: () => undefined,
      success: () => undefined,
      error: (message) => {
        seen.push(message);
        return undefined;
      },
    });
    expect(seen).toEqual([99, "kaboom"]);
  });
});

describe("matchScalar folds a ScalarRemoteData value (zeroResults excluded by type)", () => {
  const scalarCases = {
    initial: () => "I",
    fetching: () => "F",
    success: (data: number) => `S:${data}`,
    error: (message: string) => `E:${message}`,
  };

  it("routes each of the four reachable states to its handler", () => {
    // Each value is typed as ScalarRemoteData<number>; the constructors' singleton return types are
    // assignable to it, so no cast is needed (and a `zeroResults()` value would NOT be assignable).
    const i: ScalarRemoteData<number> = initial();
    const f: ScalarRemoteData<number> = fetching();
    const s: ScalarRemoteData<number> = success(3);
    const e: ScalarRemoteData<number> = failure("bad");

    expect(matchScalar(i, scalarCases)).toBe("I");
    expect(matchScalar(f, scalarCases)).toBe("F");
    expect(matchScalar(s, scalarCases)).toBe("S:3");
    expect(matchScalar(e, scalarCases)).toBe("E:bad");
  });

  it("passes the payload through to the success/error handlers", () => {
    const seen: unknown[] = [];
    matchScalar(success(123) as ScalarRemoteData<number>, {
      initial: () => undefined,
      fetching: () => undefined,
      success: (data) => {
        seen.push(data);
        return undefined;
      },
      error: () => undefined,
    });
    matchScalar(failure("detail") as ScalarRemoteData<number>, {
      initial: () => undefined,
      fetching: () => undefined,
      success: () => undefined,
      error: (message) => {
        seen.push(message);
        return undefined;
      },
    });
    expect(seen).toEqual([123, "detail"]);
  });
});

describe("mapData transforms success only", () => {
  it("applies f to the success payload", () => {
    expect(mapData(success(4), (n) => n * 10)).toEqual({ kind: "success", data: 40 });
  });

  it("is identity (same reference) on the other four states and never calls f", () => {
    let called = false;
    const f = (n: number) => {
      called = true;
      return n + 1;
    };
    const init = initial();
    const fetchState = fetching();
    const zero = zeroResults();
    const fail = failure("x") as RemoteData<number>;

    expect(mapData(init, f)).toBe(init);
    expect(mapData(fetchState, f)).toBe(fetchState);
    expect(mapData(zero, f)).toBe(zero);
    expect(mapData(fail, f)).toBe(fail);
    expect(called).toBe(false);
  });
});

describe("unwrapOr returns the success payload or the fallback", () => {
  it("returns the data on success", () => {
    expect(unwrapOr(success(7), 0)).toBe(7);
    expect(unwrapOr(success(0), 99)).toBe(0); // falsy success data is still real data
  });

  it("returns the fallback for initial / fetching / zeroResults / error", () => {
    expect(unwrapOr(initial() as RemoteData<number>, -1)).toBe(-1);
    expect(unwrapOr(fetching() as RemoteData<number>, -1)).toBe(-1);
    expect(unwrapOr(zeroResults() as RemoteData<number>, -1)).toBe(-1);
    expect(unwrapOr(failure("nope") as RemoteData<number>, -1)).toBe(-1);
  });
});

describe("type guards", () => {
  it("each guard is true for its own state and false for the others", () => {
    expect(isInitial(initial())).toBe(true);
    expect(isInitial(fetching())).toBe(false);

    expect(isFetching(fetching())).toBe(true);
    expect(isFetching(initial())).toBe(false);

    expect(isZeroResults(zeroResults())).toBe(true);
    expect(isZeroResults(success(1))).toBe(false);

    expect(isSuccess(success(1))).toBe(true);
    expect(isSuccess(failure("e"))).toBe(false);

    expect(isError(failure("e"))).toBe(true);
    expect(isError(success(1))).toBe(false);
  });

  it("isInitial / isFetching / isZeroResults narrow to their singleton variant", () => {
    // The narrowed assignment below only typechecks because the guard is a type predicate. If any
    // guard returned plain `boolean`, `rd` would stay `RemoteData<number>` inside the `if` and the
    // assignment to the singleton type would be a compile error — pinning the predicate behavior.
    const a: RemoteData<number> = initial();
    if (isInitial(a)) {
      const only: { kind: "initial" } = a;
      expect(only.kind).toBe("initial");
    } else {
      throw new Error("guard should have narrowed to initial");
    }

    const b: RemoteData<number> = fetching();
    if (isFetching(b)) {
      const only: { kind: "fetching" } = b;
      expect(only.kind).toBe("fetching");
    } else {
      throw new Error("guard should have narrowed to fetching");
    }

    const c: RemoteData<number> = zeroResults();
    if (isZeroResults(c)) {
      const only: { kind: "zeroResults" } = c;
      expect(only.kind).toBe("zeroResults");
    } else {
      throw new Error("guard should have narrowed to zeroResults");
    }
  });

  it("isSuccess / isError narrow the payload at the type level (and at runtime)", () => {
    const rd: RemoteData<number> = success(123);
    if (isSuccess(rd)) {
      // `rd.data` is reachable only because the guard narrowed `rd` to the success variant.
      expect(rd.data).toBe(123);
    } else {
      throw new Error("guard should have narrowed to success");
    }

    const er: RemoteData<number> = failure("detail");
    if (isError(er)) {
      expect(er.message).toBe("detail");
    } else {
      throw new Error("guard should have narrowed to error");
    }
  });
});
