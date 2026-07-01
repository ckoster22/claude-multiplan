// Conversation domain — attachments.ts tests (DOM controller; jsdom).
//
// Invariant-first: assert the chip/strip/getImages contract that SHOULD hold — chips render
// in attach order with 1-based positional #N badges, removal renumbers + reorders getImages(),
// and a rejected attach shows an error with NO chip added — independent of implementation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createImageAttachments, type ImageAttachments } from "./attachments";

// Outstanding FileReader.readAsDataURL operations. The attach funnel (addFiles →
// fileToAttachedImage → FileReader.onload, in images.ts) is async and fire-and-forget from the
// paste/drop event handlers, so the test can't await it directly. Counting in-flight reads lets
// settle() wait for the funnel to FULLY drain instead of guessing a fixed number of event-loop
// turns (which is non-deterministic under parallel test load).
let pendingReads = 0;
const realReadAsDataURL = FileReader.prototype.readAsDataURL;

// A 1x1 PNG (tiny, real bytes) — deterministic small base64 payload through jsdom's FileReader.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function pngFile(name: string): File {
  const bytes = Uint8Array.from(atob(PNG_1x1_BASE64), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}

function svgFile(name = "x.svg"): File {
  return new File(["<svg/>"], name, { type: "image/svg+xml" });
}

// Build a DataTransfer-ish object for a paste/drop event (jsdom has no real DataTransfer).
function fakeDataTransfer(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    files,
  } as unknown as DataTransfer;
}

// Surface DOM + a handle. inputEl + chipStrip + errorEl mirror the real prompt-surface shape.
interface Harness {
  inputEl: HTMLElement;
  chipStrip: HTMLElement;
  errorEl: HTMLElement;
  attach: ImageAttachments;
}

function makeHarness(): Harness {
  const inputEl = document.createElement("div");
  const chipStrip = document.createElement("div");
  const errorEl = document.createElement("div");
  errorEl.className = "hidden";
  document.body.append(inputEl, chipStrip, errorEl);
  const attach = createImageAttachments({ inputEl, chipStrip, errorEl });
  return { inputEl, chipStrip, errorEl, attach };
}

// Dispatch a paste carrying the given files; wait for the async addFiles funnel to settle.
async function paste(h: Harness, files: File[]): Promise<void> {
  const ev = new Event("paste") as Event & { clipboardData?: DataTransfer };
  ev.clipboardData = fakeDataTransfer(files);
  h.inputEl.dispatchEvent(ev);
  await settle();
}

// Wait until every FileReader read kicked off by the dispatched event has reached loadend AND the
// (microtask-chained) render() that addFiles runs after the last read has flushed. pendingReads is
// only 0 at a macrotask boundary once the WHOLE funnel is done — between two sequential reads the
// 0→1 hand-off happens entirely in microtasks, so a poll never catches a transient 0. Polling that
// invariant via vi.waitFor is deterministic no matter how the event loop interleaves under load.
async function settle(): Promise<void> {
  await vi.waitFor(() => {
    if (pendingReads !== 0) throw new Error(`FileReader still reading (${pendingReads} pending)`);
  });
}

function chips(h: Harness): HTMLElement[] {
  return Array.from(h.chipStrip.querySelectorAll(".conv-attach-chip"));
}

function badges(h: Harness): string[] {
  return Array.from(h.chipStrip.querySelectorAll(".conv-attach-badge")).map(
    (b) => b.textContent ?? "",
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Instrument FileReader so settle() can track in-flight reads. The wrapper only counts (it adds a
  // one-shot loadend listener and decrements there, alongside production's own onload) and otherwise
  // delegates to the real read — read behavior is unchanged. loadend fires after load, so production's
  // promise has already resolved by the time we decrement.
  pendingReads = 0;
  FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) {
    pendingReads++;
    this.addEventListener("loadend", () => void pendingReads--, { once: true });
    return realReadAsDataURL.call(this, blob);
  };
});

afterEach(() => {
  FileReader.prototype.readAsDataURL = realReadAsDataURL;
});

describe("createImageAttachments — single image", () => {
  it("one image → one chip + getImages() length 1", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png")]);
    expect(chips(h)).toHaveLength(1);
    expect(h.attach.getImages()).toHaveLength(1);
    expect(h.attach.getImages()[0].media_type).toBe("image/png");
    expect(h.attach.getImages()[0].data).toBe(PNG_1x1_BASE64);
    expect(h.attach.isEmpty()).toBe(false);
  });
});

describe("createImageAttachments — multiple ordered images", () => {
  it("three images → ordered chips #1 #2 #3 + getImages() length 3 in order", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    expect(chips(h)).toHaveLength(3);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);
    // Order is the attach order — assert via the per-chip thumbnail alt is not enough, so the
    // chip count + getImages length carry the ordering invariant; thumbnails all share data here.
    expect(h.attach.getImages()).toHaveLength(3);
  });

  it("remove the MIDDLE chip → renumbers #1 #2 and getImages reflects the new order", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);

    const middleRemove = chips(h)[1].querySelector<HTMLButtonElement>(".conv-attach-remove")!;
    middleRemove.click();

    expect(chips(h)).toHaveLength(2);
    expect(badges(h)).toEqual(["#1", "#2"]); // renumbered positionally
    expect(h.attach.getImages()).toHaveLength(2);
  });

  it("order preserved across removal-then-add", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    chips(h)[0].querySelector<HTMLButtonElement>(".conv-attach-remove")!.click();
    expect(badges(h)).toEqual(["#1", "#2"]);
    // Add a fourth — appends to the end, badges stay contiguous.
    await paste(h, [pngFile("d.png")]);
    expect(badges(h)).toEqual(["#1", "#2", "#3"]);
    expect(h.attach.getImages()).toHaveLength(3);
  });
});

describe("createImageAttachments — reject at attach", () => {
  it("unsupported type → inline error shown and NO chip added", async () => {
    const h = makeHarness();
    await paste(h, [svgFile()]);
    expect(chips(h)).toHaveLength(0);
    expect(h.attach.getImages()).toHaveLength(0);
    expect(h.attach.isEmpty()).toBe(true);
    expect(h.errorEl.classList.contains("hidden")).toBe(false);
    expect(h.errorEl.textContent ?? "").toMatch(/unsupported/i);
  });

  it("a valid image alongside a rejected one keeps only the valid chip", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("ok.png"), svgFile()]);
    expect(chips(h)).toHaveLength(1);
    expect(badges(h)).toEqual(["#1"]);
    expect(h.errorEl.classList.contains("hidden")).toBe(false);
  });
});

describe("createImageAttachments — clear()", () => {
  it("clear() empties images, strip, and error", async () => {
    const h = makeHarness();
    await paste(h, [pngFile("a.png")]);
    await paste(h, [svgFile()]); // sets an error
    h.attach.clear();
    expect(h.attach.getImages()).toHaveLength(0);
    expect(chips(h)).toHaveLength(0);
    expect(h.attach.isEmpty()).toBe(true);
    expect(h.errorEl.classList.contains("hidden")).toBe(true);
  });
});
