import { describe, it, expect, beforeEach } from "vitest";
import { createOverlay, type OverlayHandle } from "./overlay-tools";

// jsdom has no layout, so getBoundingClientRect is zero'd. We stub the overlay's own rect + the stage
// size getter so pointer coords normalize deterministically against a known 200x100 stage.
function mountOverlay(): { stage: HTMLElement; overlay: OverlayHandle } {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const overlay = createOverlay(stage, () => ({ w: 200, h: 100 }));
  stage.appendChild(overlay.svg);
  overlay.svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { stage, overlay };
}

function drag(svg: SVGSVGElement, from: [number, number], to: [number, number]): void {
  const down = new Event("pointerdown") as PointerEvent;
  Object.assign(down, { clientX: from[0], clientY: from[1], pointerId: 1 });
  svg.dispatchEvent(down);
  const move = new Event("pointermove") as PointerEvent;
  Object.assign(move, { clientX: to[0], clientY: to[1], pointerId: 1 });
  svg.dispatchEvent(move);
  const up = new Event("pointerup") as PointerEvent;
  Object.assign(up, { clientX: to[0], clientY: to[1], pointerId: 1 });
  svg.dispatchEvent(up);
}

describe("overlay tools", () => {
  let stage: HTMLElement;
  let overlay: OverlayHandle;

  beforeEach(() => {
    document.body.innerHTML = "";
    ({ stage, overlay } = mountOverlay());
  });

  it("arrow drag appends a <line> and arrowhead <polygon>", () => {
    overlay.setTool("arrow");
    drag(overlay.svg, [10, 10], [100, 50]);
    expect(overlay.svg.querySelectorAll("line")).toHaveLength(1);
    expect(overlay.svg.querySelectorAll("polygon")).toHaveLength(1);
    expect(overlay.shapeCount()).toBe(1);
  });

  it("ellipse drag appends an <ellipse>", () => {
    overlay.setTool("ellipse");
    drag(overlay.svg, [20, 20], [120, 80]);
    expect(overlay.svg.querySelectorAll("ellipse")).toHaveLength(1);
  });

  it("freehand drag appends a <polyline> accumulating points", () => {
    overlay.setTool("freehand");
    const down = new Event("pointerdown") as PointerEvent;
    Object.assign(down, { clientX: 0, clientY: 0, pointerId: 1 });
    overlay.svg.dispatchEvent(down);
    for (const x of [10, 20, 30]) {
      const move = new Event("pointermove") as PointerEvent;
      Object.assign(move, { clientX: x, clientY: 5, pointerId: 1 });
      overlay.svg.dispatchEvent(move);
    }
    const up = new Event("pointerup") as PointerEvent;
    Object.assign(up, { clientX: 30, clientY: 5, pointerId: 1 });
    overlay.svg.dispatchEvent(up);
    const poly = overlay.svg.querySelector("polyline");
    expect(poly).not.toBeNull();
    // start + 3 moves = 4 points
    expect(poly!.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(4);
  });

  it("undo removes the last shape only", () => {
    overlay.setTool("arrow");
    drag(overlay.svg, [10, 10], [50, 50]);
    drag(overlay.svg, [60, 10], [90, 50]);
    expect(overlay.shapeCount()).toBe(2);
    overlay.undo();
    expect(overlay.shapeCount()).toBe(1);
    expect(overlay.svg.querySelectorAll("line")).toHaveLength(1);
  });

  it("clear removes all shapes", () => {
    overlay.setTool("ellipse");
    drag(overlay.svg, [10, 10], [50, 50]);
    drag(overlay.svg, [60, 10], [90, 50]);
    overlay.clear();
    expect(overlay.shapeCount()).toBe(0);
    expect(overlay.svg.querySelectorAll("ellipse")).toHaveLength(0);
  });

  it("text tool commits an SVG <text> bubble on Enter", () => {
    overlay.setTool("text");
    const down = new Event("pointerdown") as PointerEvent;
    Object.assign(down, { clientX: 40, clientY: 30, pointerId: 1 });
    overlay.svg.dispatchEvent(down);
    const input = stage.querySelector("textarea.proto-annotate-textinput") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    input.value = "hello";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input.dispatchEvent(enter);
    const text = overlay.svg.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toBe("hello");
    expect(overlay.svg.querySelector("rect")).not.toBeNull();
    // The transient editor is torn down after commit.
    expect(stage.querySelector("textarea.proto-annotate-textinput")).toBeNull();
  });

  it("finalizePendingText commits an open editor (textarea removed, SVG text committed)", () => {
    overlay.setTool("text");
    const down = new Event("pointerdown") as PointerEvent;
    Object.assign(down, { clientX: 40, clientY: 30, pointerId: 1 });
    overlay.svg.dispatchEvent(down);
    const input = stage.querySelector("textarea.proto-annotate-textinput") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    input.value = "captured";
    // Simulate the Capture flow finalizing the pending text WITHOUT a blur event.
    overlay.finalizePendingText();
    expect(stage.querySelector("textarea.proto-annotate-textinput")).toBeNull();
    const text = overlay.svg.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toBe("captured");
    expect(overlay.shapeCount()).toBe(1);
  });

  it("empty text commit adds no shape", () => {
    overlay.setTool("text");
    const down = new Event("pointerdown") as PointerEvent;
    Object.assign(down, { clientX: 40, clientY: 30, pointerId: 1 });
    overlay.svg.dispatchEvent(down);
    const input = stage.querySelector("textarea.proto-annotate-textinput") as HTMLTextAreaElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(overlay.svg.querySelector("text")).toBeNull();
    expect(overlay.shapeCount()).toBe(0);
  });
});
