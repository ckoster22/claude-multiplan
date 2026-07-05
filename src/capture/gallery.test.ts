import { describe, it, expect } from "vitest";
import { addCapture, deleteCapture, persistCapture, type Capture } from "./gallery";

function cap(overrides: Partial<{ dataUrl: string; w: number; h: number; createdAt: number }> = {}): {
  dataUrl: string;
  w: number;
  h: number;
  createdAt: number;
} {
  return { dataUrl: "data:image/png;base64,AAAA", w: 100, h: 80, createdAt: 0, ...overrides };
}

describe("addCapture", () => {
  it("appends to empty state as a PENDING capture with id cap1", () => {
    const next = addCapture([], cap({ createdAt: 5 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({
      status: "pending",
      id: "cap1",
      dataUrl: "data:image/png;base64,AAAA",
      w: 100,
      h: 80,
      createdAt: 5,
    });
    // A freshly-added capture carries no path — the field lives only on the persisted variant.
    expect("path" in next[0]).toBe(false);
  });

  it("mints sequential unique ids across successive adds", () => {
    let state: Capture[] = [];
    state = addCapture(state, cap());
    state = addCapture(state, cap());
    state = addCapture(state, cap());
    expect(state.map((c) => c.id)).toEqual(["cap1", "cap2", "cap3"]);
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

describe("persistCapture", () => {
  it("transitions the matching capture pending → persisted with a non-empty path", () => {
    let state: Capture[] = addCapture([], cap()); // cap1, pending
    expect(state[0].status).toBe("pending");

    state = persistCapture(state, "cap1", "/cwd/.plan-tree/prototype/captures/cap1.png");

    const c = state[0];
    expect(c.status).toBe("persisted");
    // The discriminant genuinely narrows: `path` is reachable ONLY on the persisted variant.
    if (c.status === "persisted") {
      expect(c.path).toBe("/cwd/.plan-tree/prototype/captures/cap1.png");
      expect(c.path.length).toBeGreaterThan(0);
    }
  });

  it("a persisted capture ALWAYS exposes a non-empty path (impossible to persist without one)", () => {
    let state: Capture[] = addCapture([], cap());
    state = persistCapture(state, "cap1", "/some/real/path.png");
    for (const c of state) {
      if (c.status === "persisted") {
        // Falsifiability: invert persistCapture to drop/blank the path and this assertion goes red.
        expect(typeof c.path).toBe("string");
        expect(c.path).not.toBe("");
      }
    }
  });

  it("leaves non-matching captures untouched and does not mutate the input", () => {
    let s: Capture[] = addCapture([], cap());
    s = addCapture(s, cap()); // cap1, cap2 both pending
    const next = persistCapture(s, "cap2", "/p/cap2.png");
    expect(next[0].status).toBe("pending"); // cap1 unchanged
    expect(next[1].status).toBe("persisted"); // cap2 transitioned
    expect(s[1].status).toBe("pending"); // input not mutated
  });

  it("persisting a missing id is a no-op", () => {
    let s: Capture[] = addCapture([], cap());
    const next = persistCapture(s, "cap999", "/p/x.png");
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("pending");
  });
});
