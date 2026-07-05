// Impure gallery strip: renders the in-session Capture[] as a thumbnail strip, opens a full-size
// capture in a STACKED modal (over the preview modal, via src/modal.ts), and offers a per-thumbnail
// corner-X → confirm → delete. The Capture[] source of truth lives in the controller that owns this
// strip (annotate-overlay.ts); this module only reads a getter and calls back a delete/re-render.

import { openModal, type ModalHandle } from "../modal";
import type { Capture } from "./gallery";

export interface GalleryStripDeps {
  getCaptures: () => readonly Capture[];
  // Delete this capture: unlink any persisted file (best-effort) then drop it from the in-session
  // model. The controller owns the reducer + invoke; the strip just triggers it after confirm.
  onDelete: (cap: Capture) => void | Promise<void>;
}

export interface GalleryStripHandle {
  readonly root: HTMLElement;
  render(): void;
  destroy(): void;
}

// Mount the strip. Returns a handle; call `render()` after every capture add/delete so the strip
// reflects the current state. `destroy()` closes any open full-size/confirm modals so nothing dangles.
export function createGalleryStrip(deps: GalleryStripDeps): GalleryStripHandle {
  const root = document.createElement("div");
  root.className = "capture-gallery";

  // The full-size modal currently open, keyed by the capture id it shows — so a delete of THAT
  // capture can close it (the enlarged-while-deleted edge case) rather than leaving it dangling.
  let openFull: { id: string; handle: ModalHandle } | null = null;
  let confirmHandle: ModalHandle | null = null;

  const openFullSize = (cap: Capture): void => {
    const img = document.createElement("img");
    img.className = "capture-full-img";
    img.src = cap.dataUrl;
    img.alt = `Capture ${cap.id}`;
    const handle = openModal({
      label: `Capture ${cap.id}`,
      content: img,
      className: "capture-full",
      onClose: () => {
        if (openFull && openFull.handle === handle) openFull = null;
      },
    });
    openFull = { id: cap.id, handle };
  };

  const confirmDelete = (cap: Capture): void => {
    if (confirmHandle) return;
    const body = document.createElement("div");
    body.className = "capture-confirm";
    const msg = document.createElement("p");
    msg.className = "capture-confirm-msg";
    msg.textContent = "Delete this capture?";
    const row = document.createElement("div");
    row.className = "capture-confirm-row";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "capture-confirm-cancel";
    cancel.textContent = "Cancel";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "capture-confirm-delete";
    del.textContent = "Delete";
    row.append(cancel, del);
    body.append(msg, row);
    const handle = openModal({
      label: "Confirm delete capture",
      content: body,
      className: "capture-confirm-modal",
      onClose: () => {
        if (confirmHandle === handle) confirmHandle = null;
      },
    });
    confirmHandle = handle;
    cancel.addEventListener("click", () => handle.close());
    del.addEventListener("click", () => {
      // If the full-size view of THIS capture is open, close it too so it can't dangle post-delete.
      if (openFull && openFull.id === cap.id) openFull.handle.close();
      handle.close();
      void deps.onDelete(cap);
    });
  };

  const render = (): void => {
    const caps = deps.getCaptures();
    const thumbs: HTMLElement[] = [];
    for (const cap of caps) {
      const chip = document.createElement("div");
      chip.className = "capture-thumb";
      const img = document.createElement("img");
      img.className = "capture-thumb-img";
      img.src = cap.dataUrl;
      img.alt = `Capture ${cap.id}`;
      img.addEventListener("click", () => openFullSize(cap));
      const x = document.createElement("button");
      x.type = "button";
      x.className = "capture-thumb-del";
      x.setAttribute("aria-label", `Delete capture ${cap.id}`);
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDelete(cap);
      });

      chip.append(img, x);
      thumbs.push(chip);
    }
    root.replaceChildren(...thumbs);
    root.classList.toggle("is-empty", caps.length === 0);
  };

  render();

  return {
    root,
    render,
    destroy(): void {
      openFull?.handle.close();
      confirmHandle?.close();
      root.remove();
    },
  };
}
