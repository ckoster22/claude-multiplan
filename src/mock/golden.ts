// Turns the committed sidecar frame goldens (`sidecar/__goldens__/<name>.jsonl`, the exact fd-1 JSON
// lines a real spawned `agent-driver` binary wrote) into mock `SceneFrame[]`, replayable through the
// same event bus / pure-model pipeline the hand-built scenes use — so what the frontend replays here
// IS what the binary emitted, demuxed exactly as the host demuxes it.
//
// `demuxLine` is a TypeScript port of the host's fd-1 → event-channel routing (`src-tauri/src/agent.rs`
// `parse_stream_line` + `normalize_error_payload`). If that Rust seam changes, this port must change
// with it — the golden-diff gate in golden-scenes.test.ts pins the ported behavior against the goldens.
//
// Two synthesized / non-golden seams (see CONTRACT.md "frontend golden replay"):
//   - `agent-exit {code}` comes from process termination, never fd-1: `goldenScene` synthesizes it
//     from the shared SCENARIO_EXIT_CODES map (the same map the spawned-binary e2e asserts against).
//   - the interactive `tool-permission-requested` prompt is driven by the sidecar's canUseTool path,
//     which a query()-seam emulator cannot produce; it stays covered by the hand-built scenes.
//
// Golden-derived frames are parsed raw JSON cast to `unknown` payloads — they bypass the compile-time
// `AgentStream` pinning the hand-built constructors provide. Their drift guard is the golden-diff gate
// + the per-class render tests (golden-scenes.test.ts), not `tsc`.

import type { SceneFrame, SceneBuilder } from "./fixtures/scenes";
import { SCENARIO_EXIT_CODES } from "../../sidecar/exit-codes";

// `?raw` eager glob so the goldens load identically under vitest and the browser mock harness. Scene
// names derive from the glob-key basenames, never a hardcoded list.
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

/** The captured fd-1 lines of one golden, blank lines dropped. */
export function goldenLines(name: string): string[] {
  const text = GOLDEN_TEXT_BY_NAME[name];
  if (text === undefined) {
    throw new Error(`unknown golden "${name}" — known: ${GOLDEN_SCENE_NAMES.join(", ")}`);
  }
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// Port of agent.rs `normalize_error_payload`: the internal `error_kind` is lifted into the public
// `kind` (default "sdk" when absent) and dropped; every other field carries through verbatim.
function normalizeErrorPayload(value: Record<string, unknown>): Record<string, unknown> {
  const { error_kind, ...rest } = value;
  const publicKind = typeof error_kind === "string" ? error_kind : "sdk";
  return { ...rest, kind: publicKind };
}

/**
 * Port of agent.rs `parse_stream_line`: route one fd-1 line to its event channel. A non-JSON line
 * becomes a synthetic `agent-error` contamination diagnostic matching the Rust read task's shape —
 * only the shape is contractual (the embedded parser text differs between serde and JSON.parse).
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

/** A golden's demuxed frames, without the synthesized process-termination exit. */
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

// review-cycle is a documented HYBRID scene. The captured golden replays ExitPlanMode as an
// already-APPROVED tool_use/tool_result round-trip (a query()-seam emulator cannot produce the
// pending `tool_permission_requested` review prompt — see the non-golden seams note above). Replaying
// it verbatim renders a generic completed tool row showing JSON.stringify(input) with literal "\n",
// NOT the real review UX. So we keep the golden's streamed lead-up (system_init + the assistant_text
// delta stream + its terminal assistant_text) and REPLACE the post-approval ExitPlanMode round-trip
// (tool_use/tool_result) and the trailing result with an injected pending `tool_permission_requested`
// frame carrying the SAME plan the golden's ExitPlanMode captured — reproducing the streamed text
// followed by the pending plan-approval bar, the real ExitPlanMode review UX.
function reviewCycleHybrid(): SceneFrame[] {
  const golden = goldenFrames("review-cycle");
  const lead = golden.filter((f) => {
    const kind = (f.payload as { kind?: string }).kind;
    return kind !== "tool_use" && kind !== "tool_result" && kind !== "result";
  });
  const exitUse = golden.find(
    (f) =>
      (f.payload as { kind?: string }).kind === "tool_use" &&
      (f.payload as { tool?: string }).tool === "ExitPlanMode",
  );
  const plan = (exitUse?.payload as { input?: { plan?: string } } | undefined)?.input?.plan ?? "";
  return [
    ...lead,
    {
      event: "tool-permission-requested",
      payload: {
        kind: "tool_permission_requested",
        id: "review-cycle-exit-1",
        tool: "ExitPlanMode",
        input: { plan },
        agent_id: null,
      },
    },
  ];
}

// Kept separate from the hand-typed SCENES registry so that one keeps its exhaustive tsc/signature
// guarantees (scenes.test.ts couples to every SCENES key). Keyed by golden basename. review-cycle is
// overridden with its hybrid builder (see reviewCycleHybrid).
export const GOLDEN_SCENES: Record<string, SceneBuilder> = Object.fromEntries(
  GOLDEN_SCENE_NAMES.map((name) => [
    name,
    name === "review-cycle" ? reviewCycleHybrid : () => goldenScene(name),
  ]),
);
