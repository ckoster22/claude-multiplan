// Mock-mode fixtures — conversation SCENES.
//
// A scene is an ordered list of frames that, when replayed through the REAL event bus
// (emitMockEvent), drive the unmodified ConversationModel + renderTree() to a specific conversation
// UI state. Each builder returns frames in strict `seq` order so the pure model derives the intended
// tree regardless of arrival timing.
//
// Most frames are `agent-stream` payloads typed against the real `AgentStream` union
// (src/conversation/types.ts), so a render-data drift is caught when `tsc --noEmit` runs over
// src/mock/**. Two scenes also carry a `tool-permission-requested` frame (the interactive
// AskUserQuestion card and the ExitPlanMode permission marker) — those are NOT agent-stream events,
// so a scene frame is tagged with its destination EVENT so the player routes each to the right
// emitMockEvent channel.

import type { AgentStream, ToolPermissionRequested, AskUserQuestionItem } from "../../conversation/types";
import { cloneQuestions } from "./questions";
import { goldenFrames } from "../golden";

// The event channels a scene frame can target — the four REAL Tauri events the conversation domain
// subscribes to. Every scene drives one of these via the mock event bus, so a deck preset's live
// behavior always matches its model-direct test path (no synthetic, no-wire-route channel).
export type SceneEvent =
  | "agent-stream"
  | "tool-permission-requested"
  | "agent-error"
  | "agent-exit";

// One frame of a scene: the destination channel + its payload. The payload is intentionally
// `unknown` at the union boundary (each channel carries a different shape); the builders below
// construct each payload from the real typed shapes so drift is still caught at the construction
// site.
export interface SceneFrame {
  event: SceneEvent;
  payload: unknown;
}

// Convenience constructors that PIN each payload to its real type at the construction site, so a
// field rename in types.ts is a compile error here.
function stream(payload: AgentStream): SceneFrame {
  return { event: "agent-stream", payload };
}

// The REAL sidecar emits `tool_permission_requested` with NO `seq` field — see
// sidecar/permissions.ts (it emits only kind/id/tool/input/agent_id) and the live controller
// (conversation/index.ts) which passes e.payload straight to model.appendPermissionRequest WITHOUT
// injecting a seq. So this
// constructor takes the SEQ-LESS shape (Omit<…, "seq">) and pins every OTHER field to the real type
// (a rename is still a compile error). It is emitted without a seq, exactly as the wire delivers it —
// the model then orders it by insertion (its seq is undefined; it never advances lastWireSeq, so a
// following user-echo/assistant reply still sorts via lastWireSeq + 0.5 off the last real wire frame).
function permission(payload: Omit<ToolPermissionRequested, "seq">): SceneFrame {
  return { event: "tool-permission-requested", payload };
}

// A scene builder: optional inter-frame delay (ms). 0 (the default) means the player emits every
// frame synchronously → the final state appears instantly. >0 means "watch it stream" — the player
// spaces emissions by `delayMs`. The builder itself only produces frames; the delay is applied by
// the player (see api.ts / core.ts), so the SAME frames serve both the instant tests and the live
// deck. The `delayMs` arg is accepted (and ignored) by every builder for a uniform signature.
export type SceneBuilder = (delayMs?: number) => SceneFrame[];

// The model's `system_init` is the conventional first frame of a live turn (it sets permission_mode
// and proves the session is live). Every scene leads with it so the working indicator + mode chip
// behave exactly as they do against a real sidecar.
function systemInit(seq: number): AgentStream {
  return {
    seq,
    kind: "system_init",
    model: "claude-sonnet-mock",
    cwd: "/Users/mock/work/widgets",
    tools: ["Read", "Edit", "Bash", "Task", "AskUserQuestion", "ExitPlanMode"],
    skills: [],
    slash_commands: [],
    permission_mode: "plan",
    session_id: "mock-session",
  };
}

// A terminal `result` frame. `isError`/`subtype`/`result`/`deliberateInterrupt` vary by scene.
function result(
  seq: number,
  over: Partial<Pick<AgentStream & { kind: "result" }, "is_error" | "subtype" | "result" | "deliberateInterrupt">> = {},
): AgentStream {
  return {
    seq,
    kind: "result",
    subtype: over.subtype ?? "success",
    is_error: over.is_error ?? false,
    result: over.result ?? "Run complete.",
    num_turns: 1,
    duration_ms: 1234,
    total_cost_usd: 0,
    session_id: "mock-session",
    ...(over.deliberateInterrupt !== undefined ? { deliberateInterrupt: over.deliberateInterrupt } : {}),
  };
}

// GOLDEN-DERIVED SCENES: these keys' classes are fully covered by a captured sidecar frame golden
// (sidecar/__goldens__), so their content is the golden's demuxed frame stream (src/mock/golden.ts)
// instead of hand-built frames — one frame registry, no drift by construction. They use
// goldenFrames (NOT goldenScene): the hand registry models a live session mid-flight, so the
// synthesized process-termination `agent-exit` is deliberately omitted (it belongs to the
// full-session GOLDEN_SCENES replay). Scenes further below that no golden can derive stay
// hand-built — see the NON-GOLDEN SEAMS marker.

// Assistant text bubble (.conv-text). The signature frames are the assistant_texts — removing them
// leaves only system_init + result, so no `.conv-text` node exists (the falsifiability target).
export const assistantText: SceneBuilder = () => goldenFrames("happy-text");

// A tool row still RUNNING (.conv-tool[data-status="running"]). NO result frame and NO matching
// tool_result, so the model leaves the tool node at status "running". Dropping the tool_use frame
// removes the row entirely (falsifiability target). Hand-built: every golden captures a COMPLETED
// run (the e2e drives each scenario to its terminal frame), so no golden can hold a mid-turn state.
export const toolRunning: SceneBuilder = () => [
  stream(systemInit(1)),
  stream({
    seq: 2,
    kind: "tool_use",
    id: "tool-run-1",
    tool: "Bash",
    input: { command: "npm run build" },
    parent_tool_use_id: null,
  }),
  // No tool_result, no result — the turn is still generating, the tool stays "running".
];

// A completed tool row (.conv-tool[data-status="done"]). The golden's tool_result (is_error:false)
// correlates onto the tool_use by id → status "done". Dropping the tool_result leaves the tool with
// no result when the terminal result ends the turn, so it is demoted to "interrupted"
// (turn-end demotion) — the [data-status="done"] selector fails either way (falsifiability target).
export const toolDone: SceneBuilder = () => goldenFrames("tool-call");

// An errored tool row (.conv-tool[data-status="error"]). The tool_result with is_error:true
// correlates onto the tool_use → status "error". Dropping the (is_error) tool_result leaves the row
// "running" (falsifiability target). Hand-built: no golden carries an is_error tool_result.
export const toolError: SceneBuilder = () => [
  stream(systemInit(1)),
  stream({
    seq: 2,
    kind: "tool_use",
    id: "tool-err-1",
    tool: "Bash",
    input: { command: "npm test -- nonexistent" },
    parent_tool_use_id: null,
  }),
  stream({
    seq: 3,
    kind: "tool_result",
    tool_use_id: "tool-err-1",
    content: "No test files found matching 'nonexistent'.",
    is_error: true,
    parent_tool_use_id: null,
  }),
  stream(result(4)),
];

// A subagent group (.conv-subagent). The golden's subagent_started seeds a labeled group; its
// nested assistant_text + tool_use/tool_result carry the SAME parent_tool_use_id ("T1") so they
// fold into that group. Dropping the subagent_started frame AND the nested child frames removes the
// group (falsifiability target — the per-scene assertion targets .conv-subagent which only exists
// when the group is present).
export const subagentGroup: SceneBuilder = () => goldenFrames("subagent-fanout");

// A successful terminal result (.conv-result, NOT .conv-result-error / -interrupted). The signature
// is the golden's success result row (the per-scene test also asserts the absence of the
// error/interrupted classes, so an is_error golden could never satisfy it).
export const resultSuccess: SceneBuilder = () => goldenFrames("happy-text");

// A failed terminal result (.conv-result-error). The golden's result carries is_error:true → the
// loud "Run failed" row; a success result renders the plain .conv-result instead (falsifiability
// target).
export const resultError: SceneBuilder = () => goldenFrames("error-midstream");

// A deliberately-interrupted terminal result (.conv-result-interrupted). The render branch keys
// EXCLUSIVELY on deliberateInterrupt, so we set it on the stored frame (the host normally tags this
// at ingest; here the fixture pre-tags it). Removing deliberateInterrupt makes it render as a loud
// .conv-result-error instead (falsifiability target). Hand-built: deliberateInterrupt is a
// HOST-side annotation, never on the wire, so no golden can carry it.
export const resultInterrupted: SceneBuilder = () => [
  stream(systemInit(1)),
  stream(result(2, { is_error: true, subtype: "error_during_execution", result: "", deliberateInterrupt: true })),
];

// A FATAL agent error (.conv-error-fatal). The golden's terminal `error` line demuxes onto the
// agent-error channel (error_kind lifted into the public `kind`) carrying fatal:true → the
// .conv-error-fatal class. Flipping fatal to false drops the -fatal class (falsifiability target).
export const errorFatal: SceneBuilder = () => goldenFrames("stream-abort");

// A DENIED tool permission row (.conv-perm-denied — which the minimap maps to the red "danger"
// tier). FIDELITY: the sidecar emits this as a DIRECT agent-stream frame (kind:"permission_denied"),
// NOT as the resolution of a tool-permission-requested round-trip — the golden captures exactly
// that: a deny verdict decided OUTSIDE the canUseTool seam, forwarded straight onto the wire with
// tool/tool_use_id/agent_id/decision_reason_type/message, then the turn's terminal result. The
// model emits a PermissionDeniedNode → renderTree draws .conv-perm-denied. Removing the
// permission_denied frame removes the row entirely (falsifiability target).
export const permissionDenied: SceneBuilder = () => goldenFrames("permission-denied");

// NON-GOLDEN SEAMS — the interactive `tool-permission-requested` scenes below (questionCard /
// exitPlanMode / permissionThenReply) inject the event directly onto the mock channel. The prompt
// is driven by the sidecar's canUseTool path, which the query()-seam emulator can never produce, so
// no golden exists and none ever will (the documented seam decision — see CONTRACT.md "frontend
// golden replay").

// An INTERACTIVE AskUserQuestion card (.conv-question, pending). Surfaced via a
// tool-permission-requested frame carrying tool:"AskUserQuestion" + input.questions. The model reads
// input.questions and renders the interactive card. Removing the permission frame removes the card
// (falsifiability target). The session stays live + waiting (no result) so the card is interactive.
export const questionCard: SceneBuilder = () => [
  stream(systemInit(1)),
  stream({
    seq: 2,
    kind: "assistant_text",
    text: "Before I build the prototype, a couple of quick questions:",
    parent_tool_use_id: null,
  }),
  permission({
    kind: "tool_permission_requested",
    id: "ask-mock-1",
    tool: "AskUserQuestion",
    input: { questions: cloneQuestions() },
    agent_id: null,
  }),
  // No result — the agent is blocked on the user's answer (waiting-for-input state).
];

// The in-process review flow keys on THIS plan text. When the live app receives
// the ExitPlanMode tool-permission-requested frame, main.ts's handleToolPermissionRequested calls
// write_agent_plan({ plan: input.plan }) then opens the written path with read_plan_contents — so the
// Plan tab MUST show exactly THIS markdown, not a fallback. The mock captures input.plan at
// write_agent_plan and serves it back for the written path (see core.ts), making the round-trip
// faithful. Exported so the test can assert read_plan_contents returns this exact text.
export const EXIT_PLAN_MODE_PLAN = `# Mock plan — ship the widget pipeline

This is the plan held at the in-process review seam.

## Steps

1. Validate the schema
2. Wire the renderer
3. Add tests

The review bar above offers **Approve & Build** (resolve the held plan) and **Request changes**.
`;

// The ExitPlanMode permission marker (.conv-perm-request, text "Plan ready — reviewing in the Plan
// tab"). Surfaced via a tool-permission-requested frame carrying tool:"ExitPlanMode". The model
// renders a neutral permission_request marker (NOT a question card). Removing the permission frame
// removes the marker (falsifiability target).
//
// REVIEW-FLOW SCENE (documented decision): exitPlanMode is the scene that drives the REAL in-process
// review bar ("Approve & Build"). In live mock playback the tool-permission-requested frame reaches
// main.ts's handleToolPermissionRequested (which early-returns only while isOrchestrationActive() —
// false in mock mode, since the mock never registers a real orchestration), so it writes the plan,
// opens it on the Plan tab, and renders the in-process review bar. The .conv-perm-request marker in
// the conversation pane is the conversation-side signature; the bar is the review-side signature.
export const exitPlanMode: SceneBuilder = () => [
  stream(systemInit(1)),
  stream({
    seq: 2,
    kind: "assistant_text",
    text: "I have a complete plan ready for your review.",
    parent_tool_use_id: null,
  }),
  permission({
    kind: "tool_permission_requested",
    id: "exit-plan-mock-1",
    tool: "ExitPlanMode",
    input: { plan: EXIT_PLAN_MODE_PLAN },
    agent_id: null,
  }),
  // No result — the plan is held at the canUseTool seam awaiting review.
];

// A MIXED scene exercising the seq-LESS permission frame followed by a resolved follow-up (Finding 1
// ordering proof). The frames in file order: system_init(1), assistant_text(2), a SEQ-LESS ExitPlanMode
// permission frame (does NOT advance lastWireSeq), then — representing the agent's reply AFTER the
// user resolved/answered — assistant_text(3) + result(4). The test ALSO drives a live user echo via
// model.appendUserMessage AFTER the permission frame: because the permission frame left lastWireSeq at
// 2 (the last real wire frame), the echo lands at 2.5, sorting AFTER the assistant_text(2)+permission
// but strictly BEFORE the agent's reply assistant_text(3) — the lastWireSeq+0.5 invariant. Removing the
// permission frame must NOT change that ordering (its undefined seq never participated).
export const permissionThenReply: SceneBuilder = () => [
  stream(systemInit(1)),
  stream({
    seq: 2,
    kind: "assistant_text",
    text: "A couple of quick questions before I continue:",
    parent_tool_use_id: null,
  }),
  permission({
    kind: "tool_permission_requested",
    id: "mixed-perm-1",
    tool: "AskUserQuestion",
    input: { questions: cloneQuestions() },
    agent_id: null,
  }),
  stream({
    seq: 3,
    kind: "assistant_text",
    text: "Thanks — proceeding with your selection.",
    parent_tool_use_id: null,
  }),
  stream(result(4)),
];

// The Question-card knobs (count / multiSelect / include-Other / answered) build a card from a
// PARAMETERIZED question set (questions.buildQuestions) rather than the fixed questionCard scene, so
// the deck needs the same primitive frames the scenes use. These thin exports reuse the private
// constructors above so a frame's shape can NEVER drift from the scenes' (single source of truth).

// A system_init agent-stream payload (the conventional first frame of a turn). Reuses systemInit().
export function systemInitFrame(seq: number): AgentStream {
  return systemInit(seq);
}

// A terminal result agent-stream payload (success by default). Reuses result().
export function resultFrame(
  seq: number,
  over: Partial<Pick<AgentStream & { kind: "result" }, "is_error" | "subtype" | "result" | "deliberateInterrupt">> = {},
): AgentStream {
  return result(seq, over);
}

// A SEQ-LESS AskUserQuestion permission SceneFrame carrying an arbitrary question set (the Question-
// card knob passes buildQuestions(opts)). Reuses the seq-less permission() constructor so it matches
// the real wire (no fabricated seq).
export function questionPermissionFrame(id: string, questions: AskUserQuestionItem[]): SceneFrame {
  return permission({
    kind: "tool_permission_requested",
    id,
    tool: "AskUserQuestion",
    input: { questions },
    agent_id: null,
  });
}

export const SCENES = {
  // Golden-derived (content = a demuxed sidecar frame golden; see the marker above assistantText).
  assistantText,
  toolDone,
  subagentGroup,
  resultSuccess,
  resultError,
  errorFatal,
  permissionDenied,
  // Hand-built: states no completed-run golden can hold (mid-turn / is_error tool_result /
  // host-side deliberateInterrupt).
  toolRunning,
  toolError,
  resultInterrupted,
  // Hand-built: the interactive tool-permission-requested seam (see the NON-GOLDEN SEAMS marker).
  questionCard,
  exitPlanMode,
  permissionThenReply,
} as const satisfies Record<string, SceneBuilder>;

// The set of valid scene names (the registry keys). Used by listScenes() and the per-scene test loop.
export type SceneName = keyof typeof SCENES;

export const SCENE_NAMES = Object.keys(SCENES) as SceneName[];

// A sensible default scene the mock plays when a session starts with no scene explicitly selected.
export const DEFAULT_SCENE: SceneName = "assistantText";
