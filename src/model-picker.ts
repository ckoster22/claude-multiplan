// Model roster: the fixed preset table plus the pure helpers that map between a preset id, its
// concrete agent options ({model, effort?}), and the UI-facing badge class / friendly name. This
// module is the single source of truth for the roster; it is UI- and transport-free (the DOM and the
// orchestrator/Rust/sidecar wiring live elsewhere). It stays a LEAF (no plan-tree/orchestrator/DOM
// imports) because `conversation/plan-tree/triage` imports `buildOptions` from here — importing triage
// back would form a triage ↔ model-picker value cycle that deadlocks vite's module runner. The
// reading-pane picker/chip renderers therefore live in `./model-bar` (a sink module), not here.

// The three preset ids, in display order. `as const` makes this the source of
// truth for both the runtime membership check and the ModelPreset union.
export const MODEL_PRESETS = ["opus-4-8", "fable-5", "sonnet-5"] as const;

export type ModelPreset = (typeof MODEL_PRESETS)[number];

// The five SDK effort levels, in display order. `as const` makes this the source
// of truth for both the runtime membership check and the EffortLevel union. This
// mirrors the SDK's EffortLevel union but is kept LOCAL to the frontend (do not
// import sidecar/env-overrides into production src/ — it pulls SDK types into the
// frontend graph). A test-only drift-guard keeps the two whitelists in sync.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// The Opus effort used when nothing else is specified.
export const DEFAULT_EFFORT: EffortLevel = "high";

// The concrete agent options a preset resolves to. `effort` is optional so the
// table can express effort-less presets — and so the key-omission invariant
// (below) can be exercised.
export interface ModelOptions {
  model: string;
  effort?: string;
}

// Preset id → agent options. All three current presets carry an effort, but the
// builder below is written so an absent effort means an absent key, not
// `effort: undefined` — preserving the defensive invariant for any future
// effort-less preset.
export const PRESET_OPTIONS: Readonly<Record<ModelPreset, ModelOptions>> = {
  "opus-4-8": { model: "claude-opus-4-8" },
  "fable-5": { model: "claude-fable-5", effort: "low" },
  "sonnet-5": { model: "claude-sonnet-5", effort: "medium" },
};

// Reverse index (concrete model id → preset id) DERIVED from PRESET_OPTIONS, so the model roster has
// exactly ONE source. The badge/picker helpers below key off it — a new preset in PRESET_OPTIONS
// flows through with no second list to update.
const MODEL_ID_TO_PRESET: Readonly<Record<string, ModelPreset>> = Object.fromEntries(
  (Object.entries(PRESET_OPTIONS) as [ModelPreset, ModelOptions][]).map(([preset, opts]) => [
    opts.model,
    preset,
  ]),
);

// The badge/segment CSS-class slug for a concrete model id: the preset id's FAMILY (its first
// hyphen segment — "opus-4-8" → "opus"). Unknown model → null (the caller omits the badge). No new
// roster: the class is the preset family already encoded in PRESET_OPTIONS' keys.
export function presetClassForModel(model: string): string | null {
  const preset = MODEL_ID_TO_PRESET[model];
  return preset ? preset.split("-")[0] : null;
}

// The human-facing model name for a concrete model id, derived from its preset id ("opus-4-8" →
// "Opus 4.8", "sonnet-5" → "Sonnet 5"): capitalize the family, join the version segments with ".".
// Unknown model → null (the caller falls back to the raw id).
export function friendlyModelName(model: string): string | null {
  const preset = MODEL_ID_TO_PRESET[model];
  if (!preset) return null;
  const [family, ...version] = preset.split("-");
  const capital = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length ? `${capital} ${version.join(".")}` : capital;
}

// Build a ModelOptions object that applies the key-omission rule: when `effort`
// is undefined the returned object genuinely lacks the `effort` key (so
// `"effort" in result === false`), never `{effort: undefined}`. Conditional
// assignment, not an `{effort}` spread, is what guarantees this.
export function buildOptions(model: string, effort?: string): ModelOptions {
  const options: ModelOptions = { model };
  if (effort !== undefined) options.effort = effort;
  return options;
}

// A test-only drift-guard pins this frontend whitelist against the sidecar's
// SDK-derived isEffortLevel.
export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}
