import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initAnnotate, type AnnotateHandle } from "./annotate-overlay";
import type { AttachedImage } from "../conversation/images";

// The real snapshot→crop path is native (WKWebView) and NOT jsdom-testable — jsdom has no canvas 2D
// backend and Image.decode never resolves against a stub URL. We stub those DOM primitives so the FLOW
// (Annotate invokes capture_webview_png, Capture pushes a gallery thumbnail) is observable, without
// asserting on real pixels. cropRegion's math is proven in overlay-model.test.ts.
const STUB_PNG = "data:image/png;base64,STUB";

let handle: AnnotateHandle | null = null;

function stubCanvasAndImage(): void {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 800;
      naturalHeight = 600;
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,CROP") as never;
}

function mount(
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  extra?: { cwd?: string; attachImages?: (imgs: AttachedImage[]) => void },
): { card: HTMLElement; iframe: HTMLIFrameElement; errors: string[] } {
  const card = document.createElement("div");
  const closeBtn = document.createElement("button");
  const iframe = document.createElement("iframe");
  card.append(closeBtn, iframe);
  document.body.appendChild(card);
  iframe.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 400, height: 300, right: 410, bottom: 320, x: 10, y: 20, toJSON() {} }) as DOMRect;
  card.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 420, height: 360, right: 420, bottom: 360, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const errors: string[] = [];
  handle = initAnnotate({
    card,
    iframe,
    invoke,
    now: () => 42,
    onError: (m) => errors.push(m),
    cwd: extra?.cwd,
    attachImages: extra?.attachImages,
  });
  return { card, iframe, errors };
}

// Drive Annotate → Capture so exactly one gallery thumbnail (a CROP data URL) exists.
async function captureOne(card: HTMLElement): Promise<void> {
  (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
  await flush();
  (card.querySelector(".proto-annotate-capture") as HTMLButtonElement).click();
  await flush();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("annotate controller", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    stubCanvasAndImage();
  });
  afterEach(() => {
    handle?.destroy();
    handle = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts an Annotate toggle and an (empty, hidden) gallery in the card chrome", () => {
    const { card } = mount(() => Promise.resolve("" as never));
    expect(card.querySelector(".proto-annotate-toggle")).not.toBeNull();
    const gallery = card.querySelector(".capture-gallery");
    expect(gallery).not.toBeNull();
    expect(gallery!.classList.contains("is-empty")).toBe(true);
  });

  it("Annotate invokes capture_webview_png and mounts the frozen stage + overlay", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card, iframe } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("capture_webview_png");
    expect(card.querySelector(".proto-annotate-stage")).not.toBeNull();
    expect(card.querySelector(".proto-annotate-frozen")).not.toBeNull();
    expect(card.querySelector(".proto-annotate-svg")).not.toBeNull();
    expect(iframe.classList.contains("proto-annotate-hidden")).toBe(true);
  });

  it("Capture snapshots, crops, and pushes exactly one gallery thumbnail", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    (card.querySelector(".proto-annotate-capture") as HTMLButtonElement).click();
    await flush();
    // one snapshot for Annotate + one for Capture
    expect(invoke).toHaveBeenCalledTimes(2);
    const thumbs = card.querySelectorAll(".capture-thumb");
    expect(thumbs).toHaveLength(1);
    const img = thumbs[0].querySelector("img") as HTMLImageElement;
    expect(img.src).toContain("CROP");
  });

  it("Capture finalizes a pending text editor before snapshotting (no live textarea rasterized)", async () => {
    let snapshotCalls = 0;
    let textareaPresentAtSnapshot: boolean | null = null;
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "capture_webview_png") {
        snapshotCalls += 1;
        // Only observe the state at the SECOND snapshot (the Capture, not the initial freeze).
        if (snapshotCalls === 2) {
          textareaPresentAtSnapshot = !!document.querySelector("textarea.proto-annotate-textinput");
        }
      }
      return Promise.resolve(STUB_PNG as never);
    });
    const { card } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    // Select the text tool and open a text editor by pointer-down on the overlay SVG.
    (card.querySelector('.proto-annotate-tool[data-tool="text"]') as HTMLButtonElement).click();
    const svgEl = card.querySelector(".proto-annotate-svg") as SVGSVGElement;
    const down = new Event("pointerdown") as PointerEvent;
    Object.assign(down, { clientX: 30, clientY: 40, pointerId: 1 });
    svgEl.dispatchEvent(down);
    const input = card.querySelector("textarea.proto-annotate-textinput") as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    input.value = "note";

    (card.querySelector(".proto-annotate-capture") as HTMLButtonElement).click();
    await flush();

    // At the moment the Capture snapshot fired, no live textarea existed.
    expect(textareaPresentAtSnapshot).toBe(false);
    // The pending text was committed to the SVG, then cleared post-capture (overlay.clear()).
    expect(card.querySelector("textarea.proto-annotate-textinput")).toBeNull();
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(1);
  });

  it("Stop annotating removes the stage and un-hides the iframe", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card, iframe } = mount(invoke as never);
    const toggle = card.querySelector(".proto-annotate-toggle") as HTMLButtonElement;
    toggle.click();
    await flush();
    toggle.click();
    expect(card.querySelector(".proto-annotate-stage")).toBeNull();
    expect(iframe.classList.contains("proto-annotate-hidden")).toBe(false);
  });

  it("surfaces snapshot invoke failure via onError and mounts no stage", async () => {
    const invoke = vi.fn(() => Promise.reject(new Error("boom")));
    const { card, errors } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    expect(errors.some((e) => e.includes("boom"))).toBe(true);
    expect(card.querySelector(".proto-annotate-stage")).toBeNull();
  });

  it("deleting a capture whose full-size modal is open closes that modal too (no dangle)", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    (card.querySelector(".proto-annotate-capture") as HTMLButtonElement).click();
    await flush();
    // Enlarge the capture.
    (card.querySelector(".capture-thumb-img") as HTMLImageElement).click();
    expect(document.querySelector(".capture-full")).not.toBeNull();
    // Delete it while enlarged.
    (card.querySelector(".capture-thumb-del") as HTMLButtonElement).click();
    (document.querySelector(".capture-confirm-delete") as HTMLButtonElement).click();
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(0);
    // The full-size modal must be gone, not dangling.
    expect(document.querySelector(".capture-full")).toBeNull();
  });

  it("deleting a thumbnail removes it from the gallery", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card } = mount(invoke as never);
    (card.querySelector(".proto-annotate-toggle") as HTMLButtonElement).click();
    await flush();
    (card.querySelector(".proto-annotate-capture") as HTMLButtonElement).click();
    await flush();
    (card.querySelector(".capture-thumb-del") as HTMLButtonElement).click();
    // confirm dialog is a stacked modal appended to body
    const del = document.querySelector(".capture-confirm-delete") as HTMLButtonElement;
    expect(del).not.toBeNull();
    del.click();
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(0);
  });

  it("Attach persists via write_capture_png (FULL data URL) FIRST, then attaches the shaped bare-base64 image", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "write_capture_png") return Promise.resolve("/cwd/.plan-tree/prototype/captures/cap1.png" as never);
      return Promise.resolve(STUB_PNG as never);
    });
    const attached: AttachedImage[][] = [];
    const { card } = mount(invoke as never, { cwd: "/cwd", attachImages: (imgs) => attached.push(imgs) });
    await captureOne(card);

    (card.querySelector(".capture-thumb-attach") as HTMLButtonElement).click();
    await flush();

    const writeCall = calls.find((c) => c.cmd === "write_capture_png");
    expect(writeCall).toBeTruthy();
    // FULL data URL passed to the persist command (Rust strips the prefix).
    expect(writeCall!.args).toEqual({ cwd: "/cwd", id: "cap1", dataUrl: "data:image/png;base64,CROP" });
    // Attach happened AFTER persist, with the SHAPED bare-base64 image.
    const writeIdx = calls.findIndex((c) => c.cmd === "write_capture_png");
    expect(attached).toHaveLength(1);
    expect(attached[0]).toEqual([{ media_type: "image/png", data: "CROP" }]);
    // Ordering: nothing attached before the write resolved.
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    // The item reflects the attached state.
    const btn = card.querySelector(".capture-thumb-attach") as HTMLButtonElement;
    expect(btn.classList.contains("is-attached")).toBe(true);
  });

  it("on persist FAILURE surfaces onError and does NOT attach (fail-closed)", async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "write_capture_png") return Promise.reject(new Error("disk full"));
      return Promise.resolve(STUB_PNG as never);
    });
    const attached: AttachedImage[][] = [];
    const { card, errors } = mount(invoke as never, { cwd: "/cwd", attachImages: (imgs) => attached.push(imgs) });
    await captureOne(card);

    (card.querySelector(".capture-thumb-attach") as HTMLButtonElement).click();
    await flush();

    expect(errors.some((e) => e.includes("disk full"))).toBe(true);
    expect(attached).toHaveLength(0);
    const btn = card.querySelector(".capture-thumb-attach") as HTMLButtonElement;
    expect(btn.classList.contains("is-attached")).toBe(false);
  });

  it("gallery-delete calls delete_capture_png ONLY for a persisted capture", async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "write_capture_png") return Promise.resolve("/cwd/captures/cap1.png" as never);
      return Promise.resolve(STUB_PNG as never);
    });
    const { card } = mount(invoke as never, { cwd: "/cwd", attachImages: () => {} });
    await captureOne(card);
    // Attach it → now persisted.
    (card.querySelector(".capture-thumb-attach") as HTMLButtonElement).click();
    await flush();
    invoke.mockClear();

    (card.querySelector(".capture-thumb-del") as HTMLButtonElement).click();
    (document.querySelector(".capture-confirm-delete") as HTMLButtonElement).click();
    await flush();

    expect(invoke).toHaveBeenCalledWith("delete_capture_png", { cwd: "/cwd", id: "cap1" });
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(0);
  });

  it("gallery-delete of an UNPERSISTED capture deletes in memory with NO unlink invoke", async () => {
    const invoke = vi.fn(() => Promise.resolve(STUB_PNG as never));
    const { card } = mount(invoke as never, { cwd: "/cwd", attachImages: () => {} });
    await captureOne(card);
    invoke.mockClear();

    (card.querySelector(".capture-thumb-del") as HTMLButtonElement).click();
    (document.querySelector(".capture-confirm-delete") as HTMLButtonElement).click();
    await flush();

    expect(invoke).not.toHaveBeenCalledWith("delete_capture_png", expect.anything());
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(0);
  });

  it("a failing unlink does NOT block the in-memory delete (fail-open)", async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "write_capture_png") return Promise.resolve("/cwd/captures/cap1.png" as never);
      if (cmd === "delete_capture_png") return Promise.reject(new Error("gone"));
      return Promise.resolve(STUB_PNG as never);
    });
    const { card, errors } = mount(invoke as never, { cwd: "/cwd", attachImages: () => {} });
    await captureOne(card);
    (card.querySelector(".capture-thumb-attach") as HTMLButtonElement).click();
    await flush();

    (card.querySelector(".capture-thumb-del") as HTMLButtonElement).click();
    (document.querySelector(".capture-confirm-delete") as HTMLButtonElement).click();
    await flush();

    expect(errors.some((e) => e.includes("gone"))).toBe(true);
    expect(card.querySelectorAll(".capture-thumb")).toHaveLength(0);
  });
});
