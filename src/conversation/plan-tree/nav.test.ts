import { describe, it, expect } from "vitest";
import { parseNn, pathKey } from "./ids";
import type { NodeState, TreeNode } from "./model";
import { resolveNodeByNnPath } from "./nav";

// Minimal split/leaf tree: root [] is a split with children 01 and 02; 01 is itself a split with a
// child 01.01. Children are stored OUT of nn order (02 before 01) so a positional walk would diverge
// from the nn-keyed one — resolveNodeByNnPath must match by nn value.
const leaf = (nn: number, title: string): TreeNode => ({
  nn: parseNn(nn),
  title,
  redraftCount: 0,
  lastFeedback: null,
  state: { stage: "leaf", phase: "drafting", planPath: null, summaryPath: null, plansDirPath: null } as NodeState,
});

const split = (nn: number, title: string, children: TreeNode[]): TreeNode => ({
  nn: parseNn(nn),
  title,
  redraftCount: 0,
  lastFeedback: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: { stage: "split", phase: "running-children", children: children as any, planPath: null, summaryPath: null, plansDirPath: null },
});

const child0101 = leaf(1, "grandchild 01.01");
const child01 = split(1, "child 01", [child0101]);
const child02 = leaf(2, "child 02");
const root = split(1, "root", [child02, child01]); // deliberately out of nn order

describe("resolveNodeByNnPath", () => {
  it("empty nn_path → the root itself, path []", () => {
    const hit = resolveNodeByNnPath(root, "");
    expect(hit?.node).toBe(root);
    expect(hit?.path).toEqual([]);
  });
  it("null nn_path → the root (persisted-record fallback)", () => {
    expect(resolveNodeByNnPath(root, null)?.node).toBe(root);
  });
  it("'01' → child 01 with path [1], matched by nn (not position)", () => {
    const hit = resolveNodeByNnPath(root, "01");
    // FALSIFY: match children positionally (children[0]) → this returns child02 and goes RED.
    expect(hit?.node).toBe(child01);
    expect(hit?.path.map((n) => pathKey([n]))).toEqual(["01"]);
  });
  it("'01.01' → the nested grandchild with path [1,1]", () => {
    const hit = resolveNodeByNnPath(root, "01.01");
    expect(hit?.node).toBe(child0101);
    expect(pathKey(hit!.path)).toBe("01.01");
  });
  it("'02' → child 02", () => {
    expect(resolveNodeByNnPath(root, "02")?.node).toBe(child02);
  });
  it("a path that walks off the tree → null", () => {
    expect(resolveNodeByNnPath(root, "03")).toBeNull(); // no child 03
    expect(resolveNodeByNnPath(root, "02.01")).toBeNull(); // 02 is a leaf, no children
  });
  it("a non-canonical/legacy nn_path (parsePathKey throws) → null, never a throw", () => {
    // FALSIFY: drop the try/catch → parsePathKey throws and these go RED (uncaught).
    expect(resolveNodeByNnPath(root, "2.1")).toBeNull(); // unpadded
    expect(resolveNodeByNnPath(root, "abc")).toBeNull(); // non-digits
    expect(resolveNodeByNnPath(root, "001")).toBeNull(); // 3-digit
  });
});
