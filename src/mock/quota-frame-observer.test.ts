// Mock-mode test — the quota_exceeded STREAM frame → onQuotaPaused observer wiring, WITHOUT booting
// main.ts. vitest + jsdom.
//
// The fix under test lives in player.ts's emitSceneFrame: a played `agent-stream` frame whose
// `kind === "quota_exceeded"` also calls emitQuotaPausedFromFrame(payload) (orchestrator.ts), which
// fans onQuotaPaused({resetAt, remaining, source}) to every subscribed observer — mirroring how the
// real orchestrator (orchestrator/core.ts) translates a quota_exceeded frame into the WAITING banner.
//
// This test drives the LIVE emission path (playSceneFrames over a golden quota scene) with an observer
// subscribed directly to the mock orchestrator handle — no DOMContentLoaded, no main.ts boot. Two
// falsifiable properties:
//   1. LIVE PATH: playSceneFrames fires onQuotaPaused EXACTLY once, carrying the golden frame's source
//      and a numeric resetAt — proving player.ts → emitQuotaPausedFromFrame → observer.
//   2. PURE PATH stays observer-free: applySceneToModel over the SAME scene fires NO onQuotaPaused
//      (the fix is deliberately live-path-only).

import { describe, it, expect, beforeEach } from "vitest";
import { ConversationModel } from "../conversation/stream";
import { getOrchestrator, type OrchestratorObserver } from "../conversation/orchestrator";
import { installMockOrchestrator } from "./orchestrator";
import { applySceneToModel, playSceneFrames } from "./player";
import { goldenScene } from "./golden";
import { clearMockBuffer } from "./event";

// The three golden quota scenes, each carrying a `quota_exceeded` frame with its captured `source`.
// resetAt is pinned to the goldens' FIXED_RESET_EPOCH_MS across all three.
const PINNED_RESET_AT = 1_750_000_000_000;
const QUOTA_SCENES = [
  { name: "quota-rate-limit", source: "rate_limit_event" },
  { name: "quota-result", source: "rate_limit_event" },
  { name: "thrown-quota", source: "thrown_error" },
] as const;

type QuotaPausedInfo = { resetAt: number; remaining: number; source: string };

// Subscribe an observer to the freshly-installed mock handle that records every onQuotaPaused call.
function subscribeQuotaCapture(): QuotaPausedInfo[] {
  const calls: QuotaPausedInfo[] = [];
  const observer: OrchestratorObserver = {
    onQuotaPaused: (info) => {
      calls.push(info);
    },
  };
  getOrchestrator().subscribe(observer);
  return calls;
}

beforeEach(() => {
  document.body.innerHTML = "";
  clearMockBuffer();
  // Installs the fake handle AND clears any observers left from a prior test, so fan-out is
  // per-test deterministic.
  installMockOrchestrator();
});

describe("quota_exceeded frame → onQuotaPaused, live playSceneFrames path (no app boot)", () => {
  for (const { name, source } of QUOTA_SCENES) {
    it(`playSceneFrames(${name}) fans onQuotaPaused exactly once with source=${source} and a numeric resetAt`, () => {
      const calls = subscribeQuotaCapture();

      // The LIVE emission path: emits each frame onto the mock bus and, for the quota_exceeded frame,
      // calls emitQuotaPausedFromFrame → the subscribed observer. No DOMContentLoaded / main.ts.
      playSceneFrames(goldenScene(name));

      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe(source);
      expect(typeof calls[0].resetAt).toBe("number");
      expect(calls[0].resetAt).toBe(PINNED_RESET_AT);
      // The frame carries no `remaining` (the orchestrator derives it from the run's budget); the
      // translator supplies a nominal 1 so the WAITING banner arms.
      expect(calls[0].remaining).toBe(1);
    });
  }

  // The PURE model path (applySceneToModel) mirrors how a test/renderer applies frames without the
  // event bus — the fix is deliberately absent here, so NO observer fires. Proves the quota-banner
  // wiring is scoped to the live emission path only.
  it("applySceneToModel over the same quota scene fires NO onQuotaPaused (fix is live-path-only)", () => {
    const calls = subscribeQuotaCapture();

    applySceneToModel(new ConversationModel(), goldenScene("quota-rate-limit"));

    expect(calls).toHaveLength(0);
  });
});
