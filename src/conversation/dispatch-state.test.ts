import { describe, it, expect } from "vitest";
import type { DispatchState } from "./index";

// PERMANENT compile-time falsifiability fixture for INVARIANT[sending-carries-its-restore-payload].
// This file is under `src/`, which tsconfig.json type-checks (`"include": ["src"]`), so the
// `// @ts-expect-error` line below is ENFORCED by `npx tsc --noEmit`: if the `sending` variant ever
// stopped REQUIRING `text` + `images`, tsc would flag the now-unused `@ts-expect-error` (TS2578)
// and fail.
//
// FALSIFIED IF: make `text`/`images` optional on the `sending` variant -> the construction below
// compiles -> the `@ts-expect-error` is unused -> tsc goes red. (Verified by doing exactly that and
// confirming tsc fails, then reverting.)
//
// The point this pins: DispatchState's `sending` arm is NOT a generic RemoteData "loading" state —
// it MUST ride the user's typed text+images so a rejected send hands the exact input back. A 5-state
// RemoteData data union could not carry that payload, which is why DispatchState is excepted from the
// migration (a deliberate design rationale documented next to the type definition — intentionally NOT
// a catalogued invariant).

// @ts-expect-error a `sending` DispatchState without its `text`+`images` restore payload must not compile
const missingPayload: DispatchState = { t: "sending" };

describe("DispatchState — sending carries its restore payload (compile-time)", () => {
  it("requires text+images on the sending variant (the @ts-expect-error above is the real assertion)", () => {
    // Runtime: types are erased, so this object is just `{ t: "sending" }`. The real assertion is
    // the `@ts-expect-error` line above, enforced by tsc.
    expect(missingPayload.t).toBe("sending");
  });

  it("a well-formed sending state carries the typed text + images back", () => {
    const text = "draft message the user typed";
    const sending: DispatchState = { t: "sending", text, images: [] };

    // Narrow and confirm the payload is recoverable from the dispatch state itself.
    expect(sending.t).toBe("sending");
    if (sending.t === "sending") {
      expect(sending.text).toBe(text);
      expect(Array.isArray(sending.images)).toBe(true);
    }
  });
});
