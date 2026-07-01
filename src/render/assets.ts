// Image asset resolution for the reading pane.
//
// markdown-it render is synchronous, so the image rule (markdown.ts) cannot
// await the Rust command that turns a local file into a data: URL. Instead it
// emits <img data-resolve="1" data-local-src="<original src>"> placeholders.
// After the HTML is inserted, `resolveLocalImages` does an async pass: it joins
// each placeholder src against the plan dir, calls `read_image_as_data_url`, and
// sets the <img>'s real .src.

import { invoke } from "@tauri-apps/api/core";
import {
  type ScalarRemoteData,
  success,
  failure,
  matchScalar,
} from "../remote-data";

/**
 * PURE path/scheme logic. Remote/data srcs pass through unchanged. Local srcs
 * are joined against `planDir` (absolute srcs used as-is) and the resulting path
 * is handed to the `read_image_as_data_url` Rust command, whose data: URL is
 * returned.
 *
 * A single awaited one-shot read modeled as `ScalarRemoteData<string>`: a
 * resolved data: URL (or passthrough src) is `success`, an `invoke` rejection is
 * `failure`. Scalar — there is no `zeroResults` for a single image read.
 *
 * Kept pure (invoke is the only side effect, mockable in tests).
 */
export async function resolveImageSrc(
  src: string,
  planDir: string,
): Promise<ScalarRemoteData<string>> {
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:")
  ) {
    return success(src);
  }
  const path = joinPath(planDir, src);
  try {
    const dataUrl = await invoke<string>("read_image_as_data_url", { path });
    return success(dataUrl);
  } catch (e) {
    return failure(String(e));
  }
}

/**
 * Join a (possibly relative) image src against the plan directory. Absolute
 * srcs (leading `/`) are returned as-is. Pure — exported for testing.
 */
export function joinPath(planDir: string, src: string): string {
  if (src.startsWith("/")) return src;
  // Strip an optional leading `./`
  const rel = src.replace(/^\.\//, "");
  const base = planDir.replace(/\/+$/, "");
  return base ? `${base}/${rel}` : rel;
}

/**
 * Async pass over every deferred-resolution <img> in the pane. Each one is
 * resolved independently; a failure leaves a visible broken-image marker but
 * never rejects the batch.
 */
export async function resolveLocalImages(
  paneEl: HTMLElement,
  planDir: string,
): Promise<void> {
  const imgs = Array.from(
    paneEl.querySelectorAll<HTMLImageElement>("img[data-resolve='1']"),
  );
  await Promise.all(
    imgs.map(async (img) => {
      const orig = img.getAttribute("data-local-src") ?? "";
      const rd = await resolveImageSrc(orig, planDir);
      // Fold the awaited one-shot read. `initial`/`fetching` cannot fire for a
      // settled success/failure read, so they are genuine NO-OPS — a no-op is
      // correct-if-somehow-reached, unlike a spurious empty error marker that
      // would flag a perfectly good image as broken. Per-image isolation: one
      // failing image still leaves the batch intact.
      const fail = (message: string) => {
        img.alt = img.alt || `image not found: ${orig}`;
        img.dataset.error = message;
      };
      matchScalar(rd, {
        success: (url) => {
          img.src = url;
        },
        error: fail,
        initial: () => {},
        fetching: () => {},
      });
      img.removeAttribute("data-resolve");
    }),
  );
}

/**
 * Resolve once every <img> in the pane has fired load OR error, with a per-image
 * timeout so a stuck remote image cannot hang a reload. Already-complete images
 * resolve immediately.
 *
 * IMPORTANT: an unresolved local placeholder (empty `src`, or a leftover
 * `data-resolve` attribute) reports `complete === true` in the DOM and would
 * otherwise be counted as "loaded" the instant we look at it — masking the async
 * height growth that lands when its real data: URL finally arrives. settle()
 * awaits resolveLocalImages() first so this should not happen in practice; the
 * guard below is the defensive backstop: such placeholders are SKIPPED (not
 * awaited, not counted complete) so they can't falsely satisfy the wait.
 */
export function awaitImages(paneEl: HTMLElement, timeoutMs = 5000): Promise<void> {
  const imgs = Array.from(paneEl.querySelectorAll<HTMLImageElement>("img"));
  return Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          // Skip unresolved placeholders: a still-deferred local image (leftover
          // data-resolve) or one with no real src must not count as loaded.
          if (img.hasAttribute("data-resolve") || !hasRealSrc(img)) {
            resolve();
            return;
          }
          // complete && naturalWidth>0 means already loaded; complete alone can
          // also mean errored — either way we're done waiting.
          if (img.complete) {
            resolve();
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            img.removeEventListener("load", finish);
            img.removeEventListener("error", finish);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          img.addEventListener("load", finish);
          img.addEventListener("error", finish);
        }),
    ),
  ).then(() => undefined);
}

/** True when the <img> carries a real (non-empty) src attribute. */
function hasRealSrc(img: HTMLImageElement): boolean {
  const src = img.getAttribute("src");
  return src !== null && src !== "";
}
