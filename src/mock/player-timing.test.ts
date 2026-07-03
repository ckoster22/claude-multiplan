// Pins the two playback timings of playSceneFrames so a future change cannot silently make the
// interactive `npm run mock` replay instant again (the reviewer's original complaint):
//   • delayMs <= 0  → SYNCHRONOUS: every frame emitted before the call returns (the deterministic
//     path vitest + applySceneToModel depend on).
//   • delayMs  > 0  → SCHEDULED OVER TIME: nothing emitted synchronously; frames arrive only as
//     timers fire, so streamed assistant_text_delta frames reveal token-by-token.
//
// Falsifiability: if playSceneFrames were changed to always emit synchronously, the delayed case's
// "0 emitted synchronously" assertion goes RED. If it were changed to always schedule, the sync
// case's "all emitted synchronously" assertion goes RED.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { playSceneFrames } from "./player";
import { listen, clearMockBuffer } from "./event";
import type { SceneFrame } from "./fixtures/scenes";

function textFrame(seq: number): SceneFrame {
  return {
    event: "agent-stream",
    payload: { seq, kind: "assistant_text", text: `chunk ${seq}`, parent_tool_use_id: null },
  };
}

const FRAMES: SceneFrame[] = [textFrame(1), textFrame(2), textFrame(3)];

describe("playSceneFrames timing", () => {
  beforeEach(() => {
    clearMockBuffer();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delayMs <= 0 emits every frame synchronously", async () => {
    let received = 0;
    await listen("agent-stream", () => {
      received += 1;
    });

    playSceneFrames(FRAMES, 0);

    // No timers advanced yet — the whole scene is already delivered.
    expect(received).toBe(FRAMES.length);
  });

  it("delayMs > 0 schedules frames over time (nothing emitted synchronously)", async () => {
    let received = 0;
    await listen("agent-stream", () => {
      received += 1;
    });

    playSceneFrames(FRAMES, 20);

    // The delayed branch schedules frame i at delayMs*i via setTimeout — even frame 0 (setTimeout 0)
    // defers to a macrotask, so BEFORE advancing timers zero frames have been emitted.
    expect(received).toBe(0);

    vi.runAllTimers();

    // Once every scheduled timer fires, the full scene has streamed in.
    expect(received).toBe(FRAMES.length);
  });

  it("the delayed cancel fn stops pending frames from streaming", async () => {
    let received = 0;
    await listen("agent-stream", () => {
      received += 1;
    });

    const cancel = playSceneFrames(FRAMES, 20);
    cancel();
    vi.runAllTimers();

    expect(received).toBe(0);
  });
});
