import { describe, it, expect } from "vitest";
import {
  MODEL_PRESETS,
  PRESET_OPTIONS,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  buildOptions,
  isEffortLevel,
  presetClassForModel,
  friendlyModelName,
  type ModelPreset,
  type EffortLevel,
} from "./model-picker";
// Drift-guard (test-only): the FRONTEND effort whitelist must stay in sync with
// the sidecar's SDK-derived isEffortLevel. Vitest includes sidecar/**; the
// production src tsc graph does NOT, so this import is confined to the test file.
import { isEffortLevel as sidecarIsEffortLevel } from "../sidecar/env-overrides";

describe("PRESET_OPTIONS table", () => {
  it("maps each preset id to its exact model/effort options", () => {
    expect(PRESET_OPTIONS["opus-4-8"]).toEqual({ model: "claude-opus-4-8" });
    // Opus carries NO static effort — its effort is chosen per-plan in the modelbar.
    expect("effort" in PRESET_OPTIONS["opus-4-8"]).toBe(false);
    expect(PRESET_OPTIONS["fable-5"]).toEqual({
      model: "claude-fable-5",
      effort: "low",
    });
    expect(PRESET_OPTIONS["sonnet-5"]).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
    });
  });

  it("lists the three presets in the documented order", () => {
    expect([...MODEL_PRESETS]).toEqual(["opus-4-8", "fable-5", "sonnet-5"]);
  });

  it("lists the five effort levels in the documented order, default high", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_EFFORT).toBe("high");
  });
});

// DEFENSIVE: the key-omission invariant, exercised directly on the pure builder
// with an effort-less synthetic input. Every consumer routes options through
// buildOptions, so pinning the builder pins the invariant for any effort-less preset.
describe("buildOptions key-omission invariant", () => {
  it("omits the effort key entirely when no effort is supplied", () => {
    const result = buildOptions("some-model");
    expect(result).toEqual({ model: "some-model" });
    // Genuine absence, not `effort: undefined`.
    expect("effort" in result).toBe(false);
    expect(Object.keys(result)).toEqual(["model"]);
  });

  it("includes the effort key when an effort is supplied", () => {
    const result = buildOptions("some-model", "low");
    expect(result).toEqual({ model: "some-model", effort: "low" });
    expect("effort" in result).toBe(true);
  });
});

describe("isEffortLevel", () => {
  it("accepts every roster effort level", () => {
    for (const level of EFFORT_LEVELS) expect(isEffortLevel(level)).toBe(true);
  });
  it("rejects non-levels and non-strings", () => {
    // FALSIFY: return true unconditionally → these go RED.
    expect(isEffortLevel("ultra")).toBe(false);
    expect(isEffortLevel(undefined)).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
  });
});

// Drift-guard (non-tautological): the frontend EFFORT_LEVELS list must agree
// with the sidecar's SDK-derived isEffortLevel. Iterate the FRONTEND list and
// assert each is accepted; assert genuine non-levels are rejected. If the two
// whitelists drift, this goes red.
describe("effort whitelist drift-guard", () => {
  it("accepts every FRONTEND effort level under the sidecar guard", () => {
    for (const level of EFFORT_LEVELS) {
      expect(sidecarIsEffortLevel(level)).toBe(true);
    }
  });

  it("rejects non-levels under the sidecar guard", () => {
    expect(sidecarIsEffortLevel("ultra")).toBe(false);
    expect(sidecarIsEffortLevel("medium-high")).toBe(false);
  });
});

describe("presetClassForModel (badge/segment class slug)", () => {
  it("maps each roster model id to its family slug", () => {
    expect(presetClassForModel("claude-opus-4-8")).toBe("opus");
    expect(presetClassForModel("claude-sonnet-5")).toBe("sonnet");
    expect(presetClassForModel("claude-fable-5")).toBe("fable");
  });
  it("returns null for an unknown model id (the caller omits the badge)", () => {
    // FALSIFY: return a hardcoded slug for unknown ids → this goes RED.
    expect(presetClassForModel("gpt-4o")).toBeNull();
    expect(presetClassForModel("")).toBeNull();
  });
  it("is derived from PRESET_OPTIONS, not a second roster (every roster model resolves)", () => {
    for (const preset of MODEL_PRESETS) {
      expect(presetClassForModel(PRESET_OPTIONS[preset].model)).toBe(preset.split("-")[0]);
    }
  });
});

describe("friendlyModelName", () => {
  it("derives the display name from the preset id", () => {
    expect(friendlyModelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(friendlyModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(friendlyModelName("claude-fable-5")).toBe("Fable 5");
  });
  it("returns null for an unknown model id", () => {
    expect(friendlyModelName("mystery-model")).toBeNull();
  });
});

// Type-level sanity: ModelPreset is the union of the three ids; EffortLevel the
// five effort ids. (Compile-time guard; harmless at runtime.)
const _presetTypeCheck: ModelPreset = "opus-4-8";
void _presetTypeCheck;
const _effortTypeCheck: EffortLevel = "high";
void _effortTypeCheck;
