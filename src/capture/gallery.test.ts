import { describe, it, expect } from "vitest";
import { addCapture, deleteCapture, type Capture } from "./gallery";

function cap(overrides: Partial<Omit<Capture, "id">> = {}): Omit<Capture, "id"> {
  return { dataUrl: "data:image/png;base64,AAAA", w: 100, h: 80, createdAt: 0, ...overrides };
}

describe("addCapture", () => {
  it("appends to empty state with id cap1", () => {
    const next = addCapture([], cap({ createdAt: 5 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ id: "cap1", dataUrl: "data:image/png;base64,AAAA", w: 100, h: 80, createdAt: 5 });
  });

  it("mints sequential unique ids across successive adds", () => {
    let state: Capture[] = [];
    state = addCapture(state, cap());
    state = addCapture(state, cap());
    state = addCapture(state, cap());
    expect(state.map((c) => c.id)).toEqual(["cap1", "cap2", "cap3"]);
    // Ids are unique.
    expect(new Set(state.map((c) => c.id)).size).toBe(3);
  });

  it("does not reuse an id of a surviving capture after an intervening delete", () => {
    let state: Capture[] = [];
    state = addCapture(state, cap()); // cap1
    state = addCapture(state, cap()); // cap2
    state = deleteCapture(state, "cap1"); // survivor: cap2
    state = addCapture(state, cap()); // must NOT be cap2 again
    const ids = state.map((c) => c.id);
    expect(ids).toEqual(["cap2", "cap3"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not mutate the input array", () => {
    const state: Capture[] = [];
    addCapture(state, cap());
    expect(state).toHaveLength(0);
  });
});

describe("deleteCapture", () => {
  it("removes exactly one matching capture", () => {
    let state: Capture[] = [];
    state = addCapture(state, cap()); // cap1
    state = addCapture(state, cap()); // cap2
    state = addCapture(state, cap()); // cap3
    const next = deleteCapture(state, "cap2");
    expect(next.map((c) => c.id)).toEqual(["cap1", "cap3"]);
    expect(next).toHaveLength(2);
  });

  it("deleting a missing id is a no-op of equal length", () => {
    let state: Capture[] = [];
    state = addCapture(state, cap());
    state = addCapture(state, cap());
    const next = deleteCapture(state, "cap999");
    expect(next).toHaveLength(2);
    expect(next.map((c) => c.id)).toEqual(["cap1", "cap2"]);
  });

  it("deleting from empty state returns empty", () => {
    expect(deleteCapture([], "cap1")).toEqual([]);
  });
});
