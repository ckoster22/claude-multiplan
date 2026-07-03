// MODEL SEAM (E3) — the per-phase model switch. The whole tree runs in ONE long-lived SDK session;
// the dispatch seam re-asserts deps.setModel whenever the ACTIVE node's effective model (domain-aware
// phaseModel, override-aware) differs from the cached assertedModel. This suite drives a real
// orchestration and pins the ORDERED model sequence + the dedup invariant (no redundant setModel when
// the model is unchanged), independent of the full wire trace the golden oracle pins.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createOrchestrator, type OrchestratorDeps, type OrchestratorHandle } from "./orchestrator";
import { parseNn, nodeAtPath } from "./plan-tree";
import type { AssistantText, ResultMsg, ToolPermissionRequested } from "./types";

const FIXED_MS = 1_750_000_000_000;

let seq = 0;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_MS);
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
  seq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeHandle(): { h: OrchestratorHandle; models: string[] } {
  const models: string[] = [];
  const deps: OrchestratorDeps = {
    startSession: async () => {},
    sendMessage: async () => {},
    setMode: async () => {},
    setModel: async (model) => void models.push(model),
    resolvePermission: async () => {},
    cancelRun: async () => {},
    interrupt: async () => {},
    endSession: async () => {},
    writePlanTreeFile: async (_cwd, name) => `/abs/.plan-tree/${name}`,
    writeAgentPlan: async (_plan, _treeId, nn) =>
      `/abs/plans/${nn === null ? "master" : Number.parseInt(nn, 10)}.md`,
    resetPlanTreeDir: async () => {},
    setTimeout: () => ({}),
    clearTimeout: () => undefined,
    now: () => FIXED_MS,
  };
  return { h: createOrchestrator(deps), models };
}

function textFrame(text: string, parentToolUseId: string | null = null): AssistantText {
  return { seq: ++seq, kind: "assistant_text", text, parent_tool_use_id: parentToolUseId };
}

function resultFrame(): ResultMsg {
  return {
    seq: ++seq,
    kind: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
    session_id: "s",
  };
}

function exitPlanModeReq(id: string, plan: string): ToolPermissionRequested {
  return { seq: ++seq, kind: "tool_permission_requested", id, tool: "ExitPlanMode", input: { plan }, agent_id: null };
}

// Drive start → intent → recon → the sizer line the caller supplies.
async function driveToSizer(h: OrchestratorHandle, sizerLine: string): Promise<void> {
  await h.start({ cwd: "/seam", request: "build a widget" });
  await h.ingestStream(textFrame("confirmed intent", "agent-intent"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame("recon report body"));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame(sizerLine));
  await h.ingestStream(resultFrame());
}

// Drive one sub-plan from its armed recon turn through its own sizer → gate → approve → exec → summary.
// `reviewAfter` answers the parent-review turn (NONE) that follows a non-final child.
async function driveSub(
  h: OrchestratorHandle,
  nn: number,
  toolUseId: string,
  sizerLine: string,
  reviewAfter = false,
): Promise<void> {
  await h.ingestStream(textFrame(`sub ${nn} recon report`));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame(sizerLine));
  await h.ingestStream(resultFrame());
  await h.ingestPermission(exitPlanModeReq(toolUseId, `# Sub-Plan 0${nn}\n\nbody\n`));
  await h.approve(String(nn).padStart(2, "0"));
  await h.ingestStream(textFrame(`exec chatter ${nn}`));
  await h.ingestStream(resultFrame());
  await h.ingestStream(textFrame(`## Changes\nsummary of sub ${nn}\n## Findings\n## Next-step inputs`));
  await h.ingestStream(resultFrame());
  if (reviewAfter) {
    await h.ingestStream(textFrame("NONE"));
    await h.ingestStream(resultFrame());
  }
}

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-5";

describe("model seam — per-phase setModel switching (E3)", () => {
  it("2-way split drives Opus decompose → Sonnet standard-leaf exec → Opus parent review, deduped", async () => {
    const { h, models } = makeHandle();

    await driveToSizer(h, "SIZER: {\"decision\":\"split\",\"num_plans\":2,\"confidence\":0.9}");
    const masterPlan =
      "# Master Plan\n\npreamble\n\n### Sub-Plan 01: First\nscope one\n\n### Sub-Plan 02: Second\nscope two\n";
    await h.ingestPermission(exitPlanModeReq("master-tu", masterPlan));
    await h.approve("");
    await h.ingestStream(resultFrame()); // interrupted-resume boundary → fires sub-01 recon

    // scale-less sizer lines default to "standard" ⇒ a leaf coding model of Sonnet.
    await driveSub(h, 1, "sub1-tu", "SIZER: {\"decision\":\"single\",\"num_plans\":1,\"confidence\":0.95}", true);
    await driveSub(h, 2, "sub2-tu", "SIZER: {\"decision\":\"single\",\"num_plans\":1,\"confidence\":0.95}");

    // The genesis session opens Sonnet (clarify/recon), so the FIRST switch is Opus at root sizing.
    // Per child: recon Sonnet → own sizer Opus → standard-leaf executing Sonnet; between children the
    // split's own reviewing turn is Opus. Consecutive same-model phases (e.g. sizing→drafting, both
    // Opus) emit NO duplicate — the seam dedups on assertedModel.
    expect(models).toEqual([
      OPUS, // root sizing (decomposition/reasoning)
      SONNET, // sub-01 recon
      OPUS, // sub-01 sizing
      SONNET, // sub-01 leaf executing (standard scale)
      OPUS, // split reviewing (parent review of sub-01)
      SONNET, // sub-02 recon
      OPUS, // sub-02 sizing
      SONNET, // sub-02 leaf executing (standard scale)
    ]);

    // DEDUP INVARIANT: no two consecutive switches are to the same model.
    for (let i = 1; i < models.length; i++) expect(models[i]).not.toBe(models[i - 1]);
  });

  it("a huge-scale single leaf executes on Fable (the scale-tiered coding model)", async () => {
    const { h, models } = makeHandle();

    // A confident single with a 4-token sizer scale of `huge` ⇒ the collapse child's coding model is
    // Fable. The single collapses to a one-child split; that child inherits the root's `single` verdict
    // so it SKIPS its own sizer, but still runs recon → drafting → executing.
    await driveToSizer(h, "SIZER: {\"decision\":\"single\",\"num_plans\":1,\"confidence\":0.95,\"scale\":\"huge\"}");
    await h.ingestStream(textFrame("collapse-child recon report")); // child recon (Sonnet)
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub1-tu", "# Sub-Plan 01\n\nbody\n"));
    await h.approve("01");
    await h.ingestStream(textFrame("exec chatter 1"));
    await h.ingestStream(resultFrame());
    await h.ingestStream(textFrame("## Changes\nsummary\n## Findings\n## Next-step inputs"));
    await h.ingestStream(resultFrame());

    expect(models).toEqual([
      OPUS, // root sizing
      SONNET, // collapse-child recon
      OPUS, // collapse-child drafting (plan authoring)
      "claude-fable-5", // collapse-child executing (huge scale)
    ]);
  });
});

// HANDLE SEAM: setExecutionModel(path, options) is the override dispatch surface the
// reading-pane picker drives. It must stamp the target node's execution_model to EXACTLY the supplied
// options and mark model_source "override" (so re-triage never clobbers it).
describe("handle seam — setExecutionModel stamps an override on the target node", () => {
  it("setExecutionModel([01], Fable/high) yields node.execution_model === options + model_source override", async () => {
    const { h } = makeHandle();

    // Drive to the collapse child's leaf gate so node [01] exists (single verdict → one-child split).
    await driveToSizer(h, "SIZER: {\"decision\":\"single\",\"num_plans\":1,\"confidence\":0.95}");
    await h.ingestStream(textFrame("collapse-child recon report"));
    await h.ingestStream(resultFrame());
    await h.ingestPermission(exitPlanModeReq("sub1-tu", "# Sub-Plan 01\n\nbody\n"));

    const before = nodeAtPath(h.snapshot().root, [parseNn(1)]);
    expect(before?.model_source).not.toBe("override"); // pre-condition: auto (or absent)

    const options = { model: "claude-fable-5", effort: "high" };
    await h.setExecutionModel([parseNn(1)], options);

    const after = nodeAtPath(h.snapshot().root, [parseNn(1)]);
    // FALSIFY: dispatch a DIFFERENT options object (e.g. Sonnet) or drop model_source "override" in
    // the reducer → these go RED.
    expect(after?.execution_model).toEqual(options);
    expect(after?.model_source).toBe("override");
  });
});
