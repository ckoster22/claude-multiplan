import { describe, it, expect } from "vitest";
import { captureToAttachedImage } from "./attach";
import type { PersistedCapture } from "./gallery";

function cap(dataUrl: string): PersistedCapture {
  return { status: "persisted", id: "cap1", dataUrl, w: 10, h: 10, createdAt: 0, path: "/p/cap1.png" };
}

describe("captureToAttachedImage", () => {
  it("strips the data:image/png;base64, prefix → bare base64 + media_type image/png", () => {
    const out = captureToAttachedImage(cap("data:image/png;base64,AAAABBBB"));
    expect(out.media_type).toBe("image/png");
    expect(out.data).toBe("AAAABBBB");
    // Falsifiability: a bare-base64 result must NOT carry the data-URL prefix.
    expect(out.data.startsWith("data:")).toBe(false);
  });

  it("splits on the FIRST comma only", () => {
    const out = captureToAttachedImage(cap("data:image/png;base64,AA,BB"));
    expect(out.data).toBe("AA,BB");
  });
});
