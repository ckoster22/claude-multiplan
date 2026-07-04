// PURE in-session gallery model + reducer (NO DOM, NO invoke). Ids are minted deterministically
// from the existing state, never from a clock/RNG, so add/delete are total functions unit-testable
// without mocking time.

export interface Capture {
  id: string;
  dataUrl: string;
  w: number;
  h: number;
  createdAt: number;
  // Absolute path returned by write_capture_png once the capture has been persisted (attached to a
  // message). Absent for in-session-only captures. Its presence is what makes gallery-delete also
  // unlink the on-disk file.
  persistedPath?: string;
}

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

// Append a capture with a freshly-minted sequential id. `createdAt` is supplied by the caller
// (not read from a clock) to keep this pure. Returns a new array; the input is not mutated.
export function addCapture(state: readonly Capture[], cap: Omit<Capture, "id">): Capture[] {
  const id = `cap${highestCapIndex(state) + 1}`;
  return [...state, { id, ...cap }];
}

// Remove exactly the capture with `id`. Deleting a missing id is a no-op that returns an
// equal-length copy. Returns a new array; the input is not mutated.
export function deleteCapture(state: readonly Capture[], id: string): Capture[] {
  return state.filter((c) => c.id !== id);
}

// Record the persisted on-disk path for the capture with `id` (set after write_capture_png). A
// missing id is a no-op. Returns a new array; the input is not mutated.
export function setPersistedPath(state: readonly Capture[], id: string, path: string): Capture[] {
  return state.map((c) => (c.id === id ? { ...c, persistedPath: path } : c));
}
