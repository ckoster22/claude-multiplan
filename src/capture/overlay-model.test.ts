import { describe, it, expect } from "vitest";
import {
  normalizePoint,
  denormPoint,
  ellipseBBox,
  arrowPoints,
  cropRegion,
} from "./overlay-model";

describe("normalizePoint / denormPoint", () => {
  it("round-trips a mid-stage point", () => {
    const n = normalizePoint(50, 20, 200, 100);
    expect(n).toEqual({ x: 0.25, y: 0.2 });
    const p = denormPoint(n, 200, 100);
    expect(p).toEqual({ x: 50, y: 20 });
  });

  it("clamps out-of-range pixels into [0,1] on normalize", () => {
    expect(normalizePoint(-10, 250, 200, 100)).toEqual({ x: 0, y: 1 });
    expect(normalizePoint(400, -5, 200, 100)).toEqual({ x: 1, y: 0 });
  });

  it("clamps out-of-range normalized coords on denorm", () => {
    expect(denormPoint({ x: 2, y: -1 }, 200, 100)).toEqual({ x: 200, y: 0 });
  });

  it("guards a zero-size stage without NaN", () => {
    expect(normalizePoint(5, 5, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("ellipseBBox", () => {
  it("is order-agnostic (start/end swapped yields same box)", () => {
    const a = ellipseBBox({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 });
    const b = ellipseBBox({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.3 });
    expect(a.x).toBeCloseTo(0.2, 10);
    expect(a.y).toBeCloseTo(0.3, 10);
    expect(a.width).toBeCloseTo(0.4, 10);
    expect(a.height).toBeCloseTo(0.2, 10);
    expect(b).toEqual(a);
  });
});

describe("arrowPoints", () => {
  it("passes the shaft endpoints through unchanged", () => {
    const r = arrowPoints({ x: 0, y: 0 }, { x: 0.5, y: 0 });
    expect(r.start).toEqual({ x: 0, y: 0 });
    expect(r.end).toEqual({ x: 0.5, y: 0 });
  });

  it("places symmetric barbs behind the tip for a horizontal arrow", () => {
    const r = arrowPoints({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.1, 0.06);
    // Head base is headLen behind the tip along +x.
    expect(r.left.x).toBeCloseTo(0.9, 10);
    expect(r.right.x).toBeCloseTo(0.9, 10);
    // Barbs are ±headWidth/2 perpendicular (±y), symmetric about the shaft.
    expect(r.left.y).toBeCloseTo(0.03, 10);
    expect(r.right.y).toBeCloseTo(-0.03, 10);
  });

  it("collapses barbs onto the tip for a zero-length arrow", () => {
    const r = arrowPoints({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 });
    expect(r.left).toEqual({ x: 0.4, y: 0.4 });
    expect(r.right).toEqual({ x: 0.4, y: 0.4 });
  });
});

describe("cropRegion", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };

  it("scale=1: crop rect equals the css rect", () => {
    const c = cropRegion({ w: 1180, h: 800 }, rect, { width: 1180, height: 800 });
    expect(c).toEqual({ sx: 100, sy: 50, sw: 400, sh: 300 });
  });

  it("scale=2: multiplies the css rect by 2", () => {
    const c = cropRegion({ w: 2360, h: 1600 }, rect, { width: 1180, height: 800 });
    expect(c).toEqual({ sx: 200, sy: 100, sw: 800, sh: 600 });
  });

  it("non-square PNG with equal x/y scale still scales both axes by 2", () => {
    // png 2360×1600, webview 1180×800 → scaleX = scaleY = 2 (isotropic, but the h ratio is used).
    const c = cropRegion({ w: 2360, h: 1600 }, rect, { width: 1180, height: 800 });
    expect(c).toEqual({ sx: 200, sy: 100, sw: 800, sh: 600 });
  });

  it("anisotropic PNG scales Y by png.h/height, independent of X", () => {
    // png 2360×1500, webview 1180×800 → scaleX = 2, scaleY = 1.875.
    const c = cropRegion({ w: 2360, h: 1500 }, rect, { width: 1180, height: 800 });
    expect(c.sx).toBeCloseTo(200, 10);
    expect(c.sw).toBeCloseTo(800, 10);
    // Y axis uses scaleY = 1500/800 = 1.875, NOT scaleX.
    expect(c.sy).toBeCloseTo(50 * 1.875, 10);
    expect(c.sh).toBeCloseTo(300 * 1.875, 10);
  });

  it("derives scale from PNG natural width, NOT devicePixelRatio", () => {
    // png.w=2360, webview width=1180 → scale 2 regardless of any DPR.
    const c = cropRegion({ w: 2360, h: 1600 }, rect, { width: 1180, height: 800 });
    expect(c.sw).toBe(800);
    expect(c.sx).toBe(200);
  });
});
