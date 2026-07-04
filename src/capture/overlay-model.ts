// PURE annotation-shape model + geometry (NO DOM). Shapes store coordinates NORMALIZED to the
// annotation stage rect (0..1) so they track modal resize; the impure overlay denormalizes them
// for a given stage size at paint time. `cropRegion` derives its scale from the returned PNG's
// natural dimensions, NOT `devicePixelRatio` (they diverge on multi-monitor / mixed-DPI).

// A normalized 2D point, each component in [0, 1].
export type NormPoint = { x: number; y: number };

// One authored annotation. `arrow`/`ellipse` use `[start, end]`; `freehand` is a polyline through
// all `points`; `text` anchors a comment bubble at `start` (`end` unused). Discriminated on `tool`
// so an invalid tool is unconstructable.
export type Shape =
  | { tool: "arrow"; start: NormPoint; end: NormPoint }
  | { tool: "ellipse"; start: NormPoint; end: NormPoint }
  | { tool: "freehand"; points: NormPoint[] }
  | { tool: "text"; start: NormPoint; text: string };

export type Stroke = Shape;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Map a pixel point within a `w`×`h` stage to normalized [0,1] coords, clamped to the stage.
export function normalizePoint(px: number, py: number, w: number, h: number): NormPoint {
  return {
    x: w === 0 ? 0 : clamp01(px / w),
    y: h === 0 ? 0 : clamp01(py / h),
  };
}

// Map a normalized point back to pixels for a `w`×`h` stage. Clamps the input to [0,1] first so
// a denorm of an out-of-range point never escapes the stage.
export function denormPoint(pt: NormPoint, w: number, h: number): { x: number; y: number } {
  return { x: clamp01(pt.x) * w, y: clamp01(pt.y) * h };
}

// Normalized bounding box (top-left + size) of the ellipse spanning `[start, end]`, order-agnostic.
export function ellipseBBox(
  start: NormPoint,
  end: NormPoint,
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

// Arrow geometry: the shaft `[start, end]` plus the two barb points of the arrowhead at `end`.
// `headLen`/`headWidth` are in normalized units. Pure trig — no DOM.
export function arrowPoints(
  start: NormPoint,
  end: NormPoint,
  headLen = 0.04,
  headWidth = 0.03,
): { start: NormPoint; end: NormPoint; left: NormPoint; right: NormPoint } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  // Degenerate (zero-length) arrow: barbs collapse onto the tip.
  if (len === 0) {
    return { start, end, left: end, right: end };
  }
  const ux = dx / len;
  const uy = dy / len;
  // Base of the head, back along the shaft from the tip; barbs are ±perpendicular from there.
  const baseX = end.x - ux * headLen;
  const baseY = end.y - uy * headLen;
  const px = -uy * (headWidth / 2);
  const py = ux * (headWidth / 2);
  return {
    start,
    end,
    left: { x: baseX + px, y: baseY + py },
    right: { x: baseX - px, y: baseY - py },
  };
}

// PURE crop math for the webview snapshot. `png` is the returned PNG's natural pixel dims;
// `cssRect` is the annotation stage's CSS-pixel rect; `webviewCss` is the webview's CSS size.
// X and Y are scaled independently (`png.w/webviewCss.width`, `png.h/webviewCss.height`) so a
// non-square PNG never inherits the X scale on its Y axis. Scales are derived from the actual
// returned image, NOT assumed equal to `devicePixelRatio` (which diverges on mixed-DPI setups).
// Returns the source crop rect (in PNG pixels) to pass to `ctx.drawImage`.
export function cropRegion(
  png: { w: number; h: number },
  cssRect: { left: number; top: number; width: number; height: number },
  webviewCss: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } {
  const scaleX = png.w / webviewCss.width;
  const scaleY = png.h / webviewCss.height;
  return {
    sx: cssRect.left * scaleX,
    sy: cssRect.top * scaleY,
    sw: cssRect.width * scaleX,
    sh: cssRect.height * scaleY,
  };
}
