// Impure SVG-overlay drawing surface for the annotation stage. Pointer-capture drawing appends SVG
// elements to a transparent <svg> sized to the stage rect; each shape's coords are stored NORMALIZED
// (0..1, via overlay-model) so a modal resize re-projects them without loss.

import {
  type NormPoint,
  type Shape,
  normalizePoint,
  denormPoint,
  ellipseBBox,
  arrowPoints,
} from "./overlay-model";

const SVG_NS = "http://www.w3.org/2000/svg";

export type Tool = Shape["tool"];

export const TOOLS: readonly Tool[] = ["arrow", "ellipse", "freehand", "text"];

const STROKE = "#ff2d55";
const STROKE_W = 3;
const BUBBLE_FILL = "#16161a";
const BUBBLE_TEXT = "#ffffff";

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

// One rendered shape: the normalized model plus the SVG node(s) that draw it. Kept together so undo
// removes both the record and the DOM, and a resize can re-denormalize the same record.
interface DrawnShape {
  shape: Shape;
  node: SVGElement;
}

export interface OverlayHandle {
  readonly svg: SVGSVGElement;
  setTool(tool: Tool): void;
  getTool(): Tool;
  undo(): void;
  clear(): void;
  // Re-denormalize every stored shape to the current stage size (call after a resize).
  reproject(): void;
  // Synchronously commit any open text editor so a live <textarea> can't be rasterized by Capture.
  finalizePendingText(): void;
  // Live shape count for wiring/teardown decisions — not a hook for tests to read internals.
  shapeCount(): number;
  destroy(): void;
}

// Mount the drawing overlay into `stage`. `getSize` returns the current stage pixel size (the overlay
// tracks resize by re-denormalizing). Text authoring mounts a transient <textarea> into `stage`.
export function createOverlay(stage: HTMLElement, getSize: () => { w: number; h: number }): OverlayHandle {
  const root = svg("svg");
  root.classList.add("proto-annotate-svg");
  root.setAttribute("xmlns", SVG_NS);

  const shapes: DrawnShape[] = [];
  let tool: Tool = "arrow";
  let drawing: DrawnShape | null = null;
  let startNorm: NormPoint | null = null;
  let pendingText: HTMLTextAreaElement | null = null;
  // Commit/cancel handler for the currently-open text editor (null when none is open). Held in the
  // outer scope so `finalizePendingText` can drive it without reaching into `openTextEditor`.
  let finishPendingText: ((commit: boolean) => void) | null = null;

  const localPoint = (e: PointerEvent): { px: number; py: number } => {
    const rect = root.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  // Repaint the SVG node of an in-progress arrow/ellipse/freehand from its (updated) normalized model.
  const paint = (drawn: DrawnShape): void => {
    const { w, h } = getSize();
    const s = drawn.shape;
    if (s.tool === "arrow") {
      const a = arrowPoints(s.start, s.end);
      const start = denormPoint(a.start, w, h);
      const end = denormPoint(a.end, w, h);
      const left = denormPoint(a.left, w, h);
      const right = denormPoint(a.right, w, h);
      const line = drawn.node.querySelector("line") as SVGLineElement;
      const head = drawn.node.querySelector("polygon") as SVGPolygonElement;
      line.setAttribute("x1", String(start.x));
      line.setAttribute("y1", String(start.y));
      line.setAttribute("x2", String(end.x));
      line.setAttribute("y2", String(end.y));
      head.setAttribute("points", `${end.x},${end.y} ${left.x},${left.y} ${right.x},${right.y}`);
    } else if (s.tool === "ellipse") {
      const bb = ellipseBBox(s.start, s.end);
      const cx = denormPoint({ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }, w, h);
      const el = drawn.node as SVGEllipseElement;
      el.setAttribute("cx", String(cx.x));
      el.setAttribute("cy", String(cx.y));
      el.setAttribute("rx", String((bb.width * w) / 2));
      el.setAttribute("ry", String((bb.height * h) / 2));
    } else if (s.tool === "freehand") {
      const pts = s.points.map((p) => denormPoint(p, w, h));
      (drawn.node as SVGPolylineElement).setAttribute(
        "points",
        pts.map((p) => `${p.x},${p.y}`).join(" "),
      );
    }
  };

  const reproject = (): void => {
    for (const d of shapes) {
      if (d.shape.tool === "text") paintText(d);
      else paint(d);
    }
  };

  const paintText = (drawn: DrawnShape): void => {
    if (drawn.shape.tool !== "text") return;
    const { w, h } = getSize();
    const at = denormPoint(drawn.shape.start, w, h);
    const rect = drawn.node.querySelector("rect") as SVGRectElement;
    const text = drawn.node.querySelector("text") as SVGTextElement;
    const label = drawn.shape.text;
    const textW = Math.max(24, label.length * 7 + 12);
    rect.setAttribute("x", String(at.x));
    rect.setAttribute("y", String(at.y));
    rect.setAttribute("width", String(textW));
    rect.setAttribute("height", "22");
    text.setAttribute("x", String(at.x + 6));
    text.setAttribute("y", String(at.y + 15));
    text.textContent = label;
  };

  const beginArrow = (start: NormPoint): DrawnShape => {
    const g = svg("g");
    const line = svg("line");
    line.setAttribute("stroke", STROKE);
    line.setAttribute("stroke-width", String(STROKE_W));
    const head = svg("polygon");
    head.setAttribute("fill", STROKE);
    g.append(line, head);
    return { shape: { tool: "arrow", start, end: start }, node: g };
  };

  const beginEllipse = (start: NormPoint): DrawnShape => {
    const el = svg("ellipse");
    el.setAttribute("stroke", STROKE);
    el.setAttribute("stroke-width", String(STROKE_W));
    el.setAttribute("fill", "none");
    return { shape: { tool: "ellipse", start, end: start }, node: el };
  };

  const beginFreehand = (start: NormPoint): DrawnShape => {
    const poly = svg("polyline");
    poly.setAttribute("stroke", STROKE);
    poly.setAttribute("stroke-width", String(STROKE_W));
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke-linejoin", "round");
    poly.setAttribute("stroke-linecap", "round");
    return { shape: { tool: "freehand", points: [start] }, node: poly };
  };

  const commitText = (anchor: NormPoint, value: string): void => {
    const label = value.trim();
    if (label.length === 0) return;
    const g = svg("g");
    const rect = svg("rect");
    rect.setAttribute("rx", "5");
    rect.setAttribute("fill", BUBBLE_FILL);
    const text = svg("text");
    text.setAttribute("fill", BUBBLE_TEXT);
    text.setAttribute("font-size", "12");
    text.setAttribute("font-family", "-apple-system, sans-serif");
    g.append(rect, text);
    root.appendChild(g);
    const drawn: DrawnShape = { shape: { tool: "text", start: anchor, text: label }, node: g };
    shapes.push(drawn);
    paintText(drawn);
  };

  const openTextEditor = (anchor: NormPoint, px: number, py: number): void => {
    if (pendingText) return;
    const input = document.createElement("textarea");
    input.className = "proto-annotate-textinput";
    input.style.left = `${px}px`;
    input.style.top = `${py}px`;
    stage.appendChild(input);
    pendingText = input;
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value;
      input.remove();
      pendingText = null;
      finishPendingText = null;
      if (commit) commitText(anchor, value);
    };
    finishPendingText = finish;
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (pendingText) return;
    const { w, h } = getSize();
    const { px, py } = localPoint(e);
    const norm = normalizePoint(px, py, w, h);
    if (tool === "text") {
      openTextEditor(norm, px, py);
      return;
    }
    root.setPointerCapture?.(e.pointerId);
    startNorm = norm;
    if (tool === "arrow") drawing = beginArrow(norm);
    else if (tool === "ellipse") drawing = beginEllipse(norm);
    else drawing = beginFreehand(norm);
    root.appendChild(drawing.node);
    shapes.push(drawing);
    paint(drawing);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!drawing || !startNorm) return;
    const { w, h } = getSize();
    const { px, py } = localPoint(e);
    const norm = normalizePoint(px, py, w, h);
    const s = drawing.shape;
    if (s.tool === "arrow" || s.tool === "ellipse") s.end = norm;
    else if (s.tool === "freehand") s.points.push(norm);
    paint(drawing);
  };

  const endDraw = (e: PointerEvent): void => {
    if (!drawing) return;
    root.releasePointerCapture?.(e.pointerId);
    drawing = null;
    startNorm = null;
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", endDraw);
  root.addEventListener("pointercancel", endDraw);

  return {
    svg: root,
    setTool(t: Tool): void {
      tool = t;
    },
    getTool(): Tool {
      return tool;
    },
    undo(): void {
      const last = shapes.pop();
      if (last) last.node.remove();
    },
    clear(): void {
      for (const d of shapes) d.node.remove();
      shapes.length = 0;
    },
    reproject,
    finalizePendingText(): void {
      finishPendingText?.(true);
    },
    shapeCount(): number {
      return shapes.length;
    },
    destroy(): void {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", endDraw);
      root.removeEventListener("pointercancel", endDraw);
      pendingText?.remove();
      root.remove();
    },
  };
}
