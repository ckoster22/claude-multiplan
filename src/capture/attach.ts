// PURE: shape an in-session Capture into the conversation send path's AttachedImage wire shape.
// Captures are always PNG data URLs (`data:image/png;base64,<data>`); the send path wants bare
// base64 with a snake_case `media_type`. Splits on the FIRST comma so a base64 body containing
// commas (it cannot, but defensively) is preserved.

import type { AttachedImage } from "../conversation/images";
import type { PersistedCapture } from "./gallery";

// Accepts only a PersistedCapture: attaching to a conversation is legal only after the capture has
// been written to disk (fail-closed), so the pending → persisted transition is a compile-time gate.
export function captureToAttachedImage(cap: PersistedCapture): AttachedImage {
  const comma = cap.dataUrl.indexOf(",");
  const data = comma >= 0 ? cap.dataUrl.slice(comma + 1) : cap.dataUrl;
  return { media_type: "image/png", data };
}
