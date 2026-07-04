// Impure annotate/capture controller. Mounts INTO the prototype-preview modal's `.card`: an Annotate
// toggle + tool palette + gallery strip in the modal CHROME (outside the capture region), and — while
// annotating — an "annotation stage" absolutely positioned over the iframe at its identical rect. The
// stage holds a frozen <img> (a webview-native snapshot cropped to the iframe rect, covering the live
// iframe) and a coincident transparent SVG overlay. Capture re-snapshots the composited on-screen stage.
//
// The snapshot path (invoke → decode → crop) is native/manual-e2e only; jsdom/mock returns a stub URL,
// so the crop yields a stub image but the FLOW (invoke called, Capture pushed) is jsdom-observable.

import { cropRegion } from "./overlay-model";
import { addCapture, deleteCapture, persistCapture, type Capture, type PersistedCapture } from "./gallery";
import { captureToAttachedImage } from "./attach";
import { createOverlay, TOOLS, type Tool, type OverlayHandle } from "./overlay-tools";
import { createGalleryStrip, type GalleryStripHandle } from "./gallery-ui";
import type { AttachedImage } from "../conversation/images";

const TOOL_LABELS: Record<Tool, string> = {
  arrow: "Arrow",
  ellipse: "Circle",
  freehand: "Draw",
  text: "Comment",
};

export interface AnnotateDeps {
  card: HTMLElement;
  iframe: HTMLIFrameElement;
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  // A caller-supplied clock reading (e.g. performance.now()) stamped onto each Capture, keeping the
  // pure gallery model clock-free.
  now: () => number;
  // Surface capture/snapshot errors visibly; reuse the host's #hook-status pattern.
  onError: (message: string) => void;
  // Originating working directory of the prototype gate — the containment root the persisted PNG is
  // written under (write_capture_png / delete_capture_png). Optional so older callers / tests that
  // never exercise the attach flow still compile; the attach button is inert without it.
  cwd?: string;
  // Append shaped images to the live conversation's follow-up attachment tray. Optional for the same
  // reason as `cwd`; when absent the attach action is inert.
  attachImages?: (imgs: AttachedImage[]) => void;
}

export interface AnnotateHandle {
  destroy(): void;
}

// Decode a data-URL PNG and crop it (via an in-DOM canvas — a same-origin data URL does not taint) to
// the on-screen `rect`, returning a fresh data URL plus its pixel dims. The scale is derived from the
// PNG's natural width (cropRegion), never devicePixelRatio.
async function snapshotCrop(
  dataUrl: string,
  rect: { left: number; top: number; width: number; height: number },
  webviewCss: { width: number; height: number },
): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  if (img.naturalWidth === 0 || img.naturalHeight === 0) {
    throw new Error("snapshot decoded to a zero-size image");
  }
  const region = cropRegion(
    { w: img.naturalWidth, h: img.naturalHeight },
    rect,
    webviewCss,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.sw));
  canvas.height = Math.max(1, Math.round(region.sh));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(
    img,
    region.sx,
    region.sy,
    region.sw,
    region.sh,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return { dataUrl: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height };
}

export function initAnnotate(deps: AnnotateDeps): AnnotateHandle {
  const { card, iframe, invoke, now, onError, cwd, attachImages } = deps;

  let captures: Capture[] = [];
  let annotating = false;
  let stage: HTMLDivElement | null = null;
  let overlay: OverlayHandle | null = null;

  const toolbar = document.createElement("div");
  toolbar.className = "proto-annotate-toolbar";

  const annotateBtn = document.createElement("button");
  annotateBtn.type = "button";
  annotateBtn.className = "proto-annotate-toggle";
  annotateBtn.textContent = "Annotate";

  const palette = document.createElement("div");
  palette.className = "proto-annotate-palette";
  palette.hidden = true;

  const toolBtns = new Map<Tool, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "proto-annotate-tool";
    b.dataset.tool = t;
    b.textContent = TOOL_LABELS[t];
    b.addEventListener("click", () => selectTool(t));
    toolBtns.set(t, b);
    palette.appendChild(b);
  }

  const captureBtn = document.createElement("button");
  captureBtn.type = "button";
  captureBtn.className = "proto-annotate-capture";
  captureBtn.textContent = "Capture";
  captureBtn.hidden = true;

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "proto-annotate-undo";
  undoBtn.textContent = "Undo";
  undoBtn.hidden = true;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "proto-annotate-clear";
  clearBtn.textContent = "Clear";
  clearBtn.hidden = true;

  toolbar.append(annotateBtn, palette, undoBtn, clearBtn, captureBtn);

  const gallery: GalleryStripHandle = createGalleryStrip({
    getCaptures: () => captures,
    onDelete: async (cap) => {
      // Best-effort unlink of the persisted file — a thrown unlink must NOT block the in-memory
      // delete (fail-open). A "pending" capture never persisted, so skip the invoke entirely.
      if (cap.status === "persisted" && cwd) {
        try {
          await invoke("delete_capture_png", { cwd, id: cap.id });
        } catch (e) {
          onError(`Could not delete capture file: ${String(e)}`);
        }
      }
      captures = deleteCapture(captures, cap.id);
      gallery.render();
    },
    onAttach: async (cap) => {
      if (!cwd || !attachImages) {
        onError("Cannot attach capture: no live conversation.");
        return false;
      }
      // Persist FIRST (fail-closed): only attach after write_capture_png succeeds. Pass the FULL data
      // URL — the Rust side strips the `data:image/png;base64,` prefix.
      let path: string;
      try {
        path = await invoke<string>("write_capture_png", { cwd, id: cap.id, dataUrl: cap.dataUrl });
      } catch (e) {
        onError(`Could not save capture: ${String(e)}`);
        return false;
      }
      captures = persistCapture(captures, cap.id, path);
      const persisted = captures.find(
        (c): c is PersistedCapture => c.id === cap.id && c.status === "persisted",
      );
      if (persisted) attachImages([captureToAttachedImage(persisted)]);
      // Success feedback is the item's own "Attached" state (persisted status → button relabel),
      // applied by the gallery re-render the caller runs after this resolves.
      gallery.render();
      return true;
    },
  });

  card.insertBefore(toolbar, iframe);
  card.append(gallery.root);

  function selectTool(t: Tool): void {
    overlay?.setTool(t);
    for (const [tool, b] of toolBtns) b.classList.toggle("is-active", tool === t);
  }

  const iframeRect = (): DOMRect => iframe.getBoundingClientRect();

  const positionStage = (): void => {
    if (!stage) return;
    const cardRect = card.getBoundingClientRect();
    const r = iframeRect();
    // Stage is absolutely positioned within the card; offset by the card's own origin.
    stage.style.left = `${r.left - cardRect.left}px`;
    stage.style.top = `${r.top - cardRect.top}px`;
    stage.style.width = `${r.width}px`;
    stage.style.height = `${r.height}px`;
    overlay?.reproject();
  };

  const onResize = (): void => positionStage();

  async function enterAnnotate(): Promise<void> {
    let dataUrl: string;
    try {
      dataUrl = await invoke<string>("capture_webview_png");
    } catch (e) {
      onError(`Could not snapshot prototype: ${String(e)}`);
      return;
    }
    const r = iframeRect();
    let frozen: { dataUrl: string; w: number; h: number };
    try {
      frozen = await snapshotCrop(dataUrl, r, {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      });
    } catch (e) {
      onError(`Could not prepare annotation image: ${String(e)}`);
      return;
    }

    stage = document.createElement("div");
    stage.className = "proto-annotate-stage";

    const frozenImg = document.createElement("img");
    frozenImg.className = "proto-annotate-frozen";
    frozenImg.src = frozen.dataUrl;
    frozenImg.alt = "Frozen prototype";
    stage.appendChild(frozenImg);

    overlay = createOverlay(stage, () => {
      const rect = iframeRect();
      return { w: rect.width, h: rect.height };
    });
    stage.appendChild(overlay.svg);

    card.appendChild(stage);
    iframe.classList.add("proto-annotate-hidden");
    positionStage();

    annotating = true;
    annotateBtn.textContent = "Stop annotating";
    annotateBtn.classList.add("is-active");
    palette.hidden = false;
    captureBtn.hidden = false;
    undoBtn.hidden = false;
    clearBtn.hidden = false;
    selectTool("arrow");
    window.addEventListener("resize", onResize);
  }

  function exitAnnotate(): void {
    window.removeEventListener("resize", onResize);
    overlay?.destroy();
    overlay = null;
    stage?.remove();
    stage = null;
    iframe.classList.remove("proto-annotate-hidden");
    annotating = false;
    annotateBtn.textContent = "Annotate";
    annotateBtn.classList.remove("is-active");
    palette.hidden = true;
    captureBtn.hidden = true;
    undoBtn.hidden = true;
    clearBtn.hidden = true;
  }

  annotateBtn.addEventListener("click", () => {
    if (annotating) exitAnnotate();
    else void enterAnnotate();
  });

  undoBtn.addEventListener("click", () => overlay?.undo());
  clearBtn.addEventListener("click", () => overlay?.clear());

  captureBtn.addEventListener("click", () => void doCapture());

  async function doCapture(): Promise<void> {
    if (!stage) return;
    // Commit any open text editor before snapshotting so a live <textarea> is never rasterized.
    overlay?.finalizePendingText();
    let dataUrl: string;
    try {
      dataUrl = await invoke<string>("capture_webview_png");
    } catch (e) {
      onError(`Could not capture: ${String(e)}`);
      return;
    }
    const rect = stage.getBoundingClientRect();
    let cropped: { dataUrl: string; w: number; h: number };
    try {
      cropped = await snapshotCrop(
        dataUrl,
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
      );
    } catch (e) {
      onError(`Could not crop capture: ${String(e)}`);
      return;
    }
    captures = addCapture(captures, {
      dataUrl: cropped.dataUrl,
      w: cropped.w,
      h: cropped.h,
      createdAt: now(),
    });
    overlay?.clear();
    gallery.render();
  }

  return {
    destroy(): void {
      window.removeEventListener("resize", onResize);
      overlay?.destroy();
      stage?.remove();
      iframe.classList.remove("proto-annotate-hidden");
      gallery.destroy();
      toolbar.remove();
      captures = [];
    },
  };
}
