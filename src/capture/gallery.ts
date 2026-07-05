// PURE in-session gallery model + reducer (NO DOM, NO invoke). Ids are minted deterministically
// from the existing state, never from a clock/RNG, so add/delete are total functions unit-testable
// without mocking time.

// Fields shared by every capture regardless of lifecycle state.
interface CaptureCommon {
  readonly id: string;
  readonly dataUrl: string;
  readonly w: number;
  readonly h: number;
  readonly createdAt: number;
}

// INVARIANT[capture-persist-requires-path] (type-level): a capture is either "pending" (no on-disk file) or "persisted" with a non-optional `path`; the path lives ONLY on the persisted variant.
//   prevents: a persisted/attached capture that carries no real path (e.g. persistedPath === "" or undefined), or a "pending" capture masquerading as attached
//   test: src/capture/gallery.test.ts "persistCapture" (pending has no path field; persisted always exposes a non-empty path)
export type Capture =
  | (CaptureCommon & { readonly status: "pending" })
  | (CaptureCommon & { readonly status: "persisted"; readonly path: string });

// A capture that has been written to disk — the only kind attachable to a conversation.
export type PersistedCapture = Extract<Capture, { status: "persisted" }>;

// The highest `capN` index currently in use, or 0 if none. Ids are minted `cap1, cap2, …`; a
// fresh id is always `nextId(state)` so it never collides with a surviving capture even after
// intervening deletes.
function highestCapIndex(state: readonly Capture[]): number {
  let max = 0;
  for (const c of state) {
    const m = /^cap(\d+)$/.exec(c.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

// Append a fresh "pending" capture with a sequential id. `createdAt` is supplied by the caller
// (not read from a clock) to keep this pure. Returns a new array; the input is not mutated.
export function addCapture(
  state: readonly Capture[],
  cap: { dataUrl: string; w: number; h: number; createdAt: number },
): Capture[] {
  const id = `cap${highestCapIndex(state) + 1}`;
  return [...state, { status: "pending", id, ...cap }];
}

// Remove exactly the capture with `id`. Deleting a missing id is a no-op that returns an
// equal-length copy. Returns a new array; the input is not mutated.
export function deleteCapture(state: readonly Capture[], id: string): Capture[] {
  return state.filter((c) => c.id !== id);
}

// Transition the capture with `id` from pending → persisted, recording its on-disk `path` (set
// after write_capture_png). A missing id is a no-op. Returns a new array; the input is not mutated.
export function persistCapture(state: readonly Capture[], id: string, path: string): Capture[] {
  return state.map((c): Capture =>
    c.id === id
      ? { status: "persisted", id: c.id, dataUrl: c.dataUrl, w: c.w, h: c.h, createdAt: c.createdAt, path }
      : c,
  );
}
