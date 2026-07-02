// Golden-replay adapter — turns the committed sidecar frame goldens
// (`sidecar/__goldens__/<name>.jsonl`, the exact fd-1 JSON lines a real spawned `agent-driver`
// binary wrote per scenario) into mock `SceneFrame[]`, replayable through the same event bus /
// pure-model pipeline the hand-built scenes use. One frame registry, no second frame-generation
// path: what the frontend replays here IS what the binary emitted, demuxed exactly as the host
// demuxes it.
//
// DEMUX FIDELITY OBLIGATION: `demuxLine` is a TypeScript port of the host's fd-1 → event-channel
// routing (`src-tauri/src/agent.rs` `parse_stream_line` + `normalize_error_payload`). If that Rust
// seam changes, this port MUST change with it — the golden-diff gate in golden-scenes.test.ts pins
// the ported behavior against the raw goldens.
//
// TWO SYNTHESIZED / NON-GOLDEN SEAMS (documented in CONTRACT.md "frontend golden replay"):
//   - `agent-exit {code}` comes from process TERMINATION, never fd-1, so no golden line carries
//     it. `goldenScene` synthesizes the trailing exit frame from the shared SCENARIO_EXIT_CODES
//     map (sidecar/exit-codes.ts — the same map the spawned-binary e2e asserts against).
//   - the interactive `tool-permission-requested` prompt is driven by the sidecar's canUseTool
//     path, which a query()-seam emulator cannot produce; it stays covered by the hand-built
//     scenes (questionCard / exitPlanMode) that inject the event directly.
//
// TYPING CAVEAT: golden-derived frames are parsed raw JSON cast to `unknown` payloads — they
// BYPASS the compile-time `AgentStream` pinning the hand-built scene constructors provide. The
// drift guard for golden scenes is the golden-diff gate + the per-class render tests
// (golden-scenes.test.ts), NOT `tsc`.

import type { SceneFrame, SceneBuilder } from "./fixtures/scenes";
import { SCENARIO_EXIT_CODES } from "../../sidecar/exit-codes";

// `?raw` eager glob so the goldens load identically under vitest AND the browser mock harness
// (`npm run mock`). The glob keys are the roster — scene names derive from the basenames, never
// from a hardcoded list or count.
const RAW_GOLDENS = import.meta.glob<string>("../../sidecar/__goldens__/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});

function basename(globKey: string): string {
  const file = globKey.slice(globKey.lastIndexOf("/") + 1);
  return file.replace(/\.jsonl$/, "");
}

const GOLDEN_TEXT_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_GOLDENS).map(([key, text]) => [basename(key), text]),
);

export const GOLDEN_SCENE_NAMES: string[] = Object.keys(GOLDEN_TEXT_BY_NAME).sort();

/** The exact captured fd-1 lines of one golden (no trailing blank line). */
export function goldenLines(name: string): string[] {
  const text = GOLDEN_TEXT_BY_NAME[name];
  if (text === undefined) {
    throw new Error(`unknown golden "${name}" — known: ${GOLDEN_SCENE_NAMES.join(", ")}`);
  }
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// Port of agent.rs `normalize_error_payload`: the sidecar's internal `{kind:"error", error_kind,
// message, fatal}` becomes the public `agent-error` shape — `error_kind` is lifted into `kind`
// (default "sdk" when absent) and dropped; every other field carries through verbatim.
function normalizeErrorPayload(value: Record<string, unknown>): Record<string, unknown> {
  const { error_kind, ...rest } = value;
  const publicKind = typeof error_kind === "string" ? error_kind : "sdk";
  return { ...rest, kind: publicKind };
}

/**
 * Port of agent.rs `parse_stream_line`: route one fd-1 line to its event channel.
 *   - whitespace-only (after trim)        → null (skip — never a frame)
 *   - kind "tool_permission_requested"    → `tool-permission-requested`, payload untouched
 *   - kind "error"                        → `agent-error`, payload normalized (error_kind lift)
 *   - any other kind                      → `agent-stream`, payload untouched
 *   - non-JSON                            → synthetic `agent-error` contamination diagnostic
 *     (`{kind:"contamination", message, fatal:false}` — same shape the Rust read task emits; the
 *     embedded parser text differs between serde and JSON.parse, so only the shape is contractual).
 */
export function demuxLine(line: string): SceneFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    const message = `non-JSON line on sidecar stdout: ${(e as Error).message}: ${trimmed}`;
    return { event: "agent-error", payload: { kind: "contamination", message, fatal: false } };
  }

  const obj = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : "";
  if (kind === "tool_permission_requested") {
    return { event: "tool-permission-requested", payload: value };
  }
  if (kind === "error") {
    return { event: "agent-error", payload: normalizeErrorPayload(obj) };
  }
  return { event: "agent-stream", payload: value };
}

/** A golden's demuxed frames, WITHOUT the synthesized process-termination exit. */
export function goldenFrames(name: string): SceneFrame[] {
  return goldenLines(name)
    .map(demuxLine)
    .filter((f): f is SceneFrame => f !== null);
}

/** Full-session replay: the demuxed frames plus the trailing `agent-exit {code}` synthesized from
 *  the shared per-golden exit-code map (process termination never appears on fd-1). */
export function goldenScene(name: string): SceneFrame[] {
  const code = SCENARIO_EXIT_CODES[name];
  if (code === undefined) {
    throw new Error(`golden "${name}" has no entry in SCENARIO_EXIT_CODES (sidecar/exit-codes.ts)`);
  }
  return [...goldenFrames(name), { event: "agent-exit", payload: { code } }];
}

// The golden scene registry — deliberately SEPARATE from the hand-typed SCENES registry so the
// hand registry keeps its exhaustive tsc/signature guarantees (scenes.test.ts couples to every
// SCENES key). Keyed by golden basename; consumed by golden-scenes.test.ts and the deck's second
// preset group.
export const GOLDEN_SCENES: Record<string, SceneBuilder> = Object.fromEntries(
  GOLDEN_SCENE_NAMES.map((name) => [name, () => goldenScene(name)]),
);
