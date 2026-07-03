import { describe, it, expect } from "vitest";
import { parseNn } from "./ids";
import type { NodeState, TreeNode } from "./model";
import type { ModelOptions } from "../../model-picker";
import {
  codingModelForScale,
  phaseModel,
  nodeExecutionModel,
  modelOptionsEqual,
} from "./triage";

// Minimal TreeNode fixture: identity fields are inert here (triage reads only state + execution_model).
function node(state: NodeState, execution_model?: ModelOptions | null): TreeNode {
  return {
    nn: parseNn(1),
    title: "fixture",
    redraftCount: 0,
    lastFeedback: null,
    state,
    ...(execution_model !== undefined ? { execution_model } : {}),
  };
}

const OPUS_HIGH: ModelOptions = { model: "claude-opus-4-8", effort: "high" };
const SONNET_HIGH: ModelOptions = { model: "claude-sonnet-5", effort: "high" };
const SONNET_MED: ModelOptions = { model: "claude-sonnet-5", effort: "medium" };
const FABLE_HIGH: ModelOptions = { model: "claude-fable-5", effort: "high" };

const leafState = (phase: "drafting" | "awaiting-approval" | "executing" | "summarized"): NodeState => ({
  stage: "leaf",
  phase,
  planPath: null,
  summaryPath: null,
  plansDirPath: null,
});

describe("codingModelForScale", () => {
  it("standard → Sonnet/medium (effort key present)", () => {
    const opts = codingModelForScale("standard");
    expect(opts).toEqual(SONNET_MED);
    expect("effort" in opts).toBe(true);
  });
  it("large → Opus/high", () => {
    expect(codingModelForScale("large")).toEqual(OPUS_HIGH);
    expect("effort" in codingModelForScale("large")).toBe(true);
  });
  it("huge → Fable/high", () => {
    expect(codingModelForScale("huge")).toEqual(FABLE_HIGH);
    expect("effort" in codingModelForScale("huge")).toBe(true);
  });
});

describe("phaseModel", () => {
  const openPhase = (phase: Extract<NodeState, { stage: "open" }>["phase"]): NodeState => ({
    stage: "open",
    phase,
  });
  const splitPhase = (phase: "running-children" | "reviewing" | "summarized"): NodeState => ({
    stage: "split",
    phase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: [node(leafState("summarized"))] as any,
    planPath: null,
    summaryPath: null,
    plansDirPath: null,
  });

  it("open/clarifying-intent → visual, Sonnet/high", () => {
    const t = phaseModel(node(openPhase("clarifying-intent")));
    expect(t.domain).toBe("visual");
    expect(t.options.model).toBe("claude-sonnet-5");
    expect(t.rationale).toContain("Visual prototyping");
  });
  it("open/prototype-review → visual, Sonnet/high", () => {
    const t = phaseModel(node(openPhase("prototype-review")));
    expect(t.domain).toBe("visual");
    expect(t.options.model).toBe("claude-sonnet-5");
  });
  it("open/recon → research, Sonnet/high", () => {
    const t = phaseModel(node(openPhase("recon")));
    expect(t.domain).toBe("research");
    expect(t.options.model).toBe("claude-sonnet-5");
    expect(t.rationale).toContain("recon");
  });
  it("open/sizing → reasoning, Opus/high", () => {
    const t = phaseModel(node(openPhase("sizing")));
    expect(t.domain).toBe("reasoning");
    expect(t.options.model).toBe("claude-opus-4-8");
    expect(t.rationale).toContain("Right-sizing");
  });
  it("open/decomposing → reasoning, Opus/high", () => {
    const t = phaseModel(node(openPhase("decomposing")));
    expect(t.domain).toBe("reasoning");
    expect(t.options.model).toBe("claude-opus-4-8");
  });
  it("open/awaiting-decomposition-approval → reasoning, Opus/high", () => {
    const t = phaseModel(node(openPhase("awaiting-decomposition-approval")));
    expect(t.domain).toBe("reasoning");
    expect(t.options.model).toBe("claude-opus-4-8");
  });
  it("open/pending → research, Sonnet/high (safe default)", () => {
    const t = phaseModel(node(openPhase("pending")));
    expect(t.domain).toBe("research");
    expect(t.options).toEqual(SONNET_HIGH);
  });

  it("leaf/drafting → reasoning, Opus/high", () => {
    const t = phaseModel(node(leafState("drafting")));
    expect(t.domain).toBe("reasoning");
    expect(t.options.model).toBe("claude-opus-4-8");
    expect(t.rationale).toContain("Plan authoring");
  });
  it("leaf/awaiting-approval → reasoning, Opus/high", () => {
    const t = phaseModel(node(leafState("awaiting-approval")));
    expect(t.domain).toBe("reasoning");
    expect(t.options.model).toBe("claude-opus-4-8");
  });
  it("leaf/executing surfaces the stamped execution_model tier", () => {
    const t = phaseModel(node(leafState("executing"), FABLE_HIGH));
    expect(t.domain).toBe("coding");
    expect(t.options).toEqual(FABLE_HIGH);
  });
  it("leaf/executing without a stamp falls back to Sonnet/medium", () => {
    const t = phaseModel(node(leafState("executing")));
    expect(t.domain).toBe("coding");
    expect(t.options).toEqual(SONNET_MED);
  });
  it("leaf/summarized without a stamp falls back to Sonnet/medium", () => {
    const t = phaseModel(node(leafState("summarized")));
    expect(t.domain).toBe("coding");
    expect(t.options).toEqual(SONNET_MED);
  });

  it("split/running-children → reasoning, Opus/high", () => {
    const t = phaseModel(node(splitPhase("running-children")));
    expect(t.domain).toBe("reasoning");
    expect(t.options).toEqual(OPUS_HIGH);
  });
  it("split/reviewing → reasoning, Opus/high", () => {
    const t = phaseModel(node(splitPhase("reviewing")));
    expect(t.domain).toBe("reasoning");
    expect(t.options).toEqual(OPUS_HIGH);
  });
});

describe("nodeExecutionModel", () => {
  const splitState: NodeState = {
    stage: "split",
    phase: "running-children",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: [node(leafState("summarized"))] as any,
    planPath: null,
    summaryPath: null,
    plansDirPath: null,
  };

  it("split → Opus/high, reasoning", () => {
    const t = nodeExecutionModel(node(splitState));
    expect(t.domain).toBe("reasoning");
    expect(t.options).toEqual(OPUS_HIGH);
  });
  it("leaf with a stamp → that stamp, coding", () => {
    const t = nodeExecutionModel(node(leafState("executing"), FABLE_HIGH));
    expect(t.domain).toBe("coding");
    expect(t.options).toEqual(FABLE_HIGH);
  });
  it("leaf without a stamp → Sonnet/medium, coding", () => {
    const t = nodeExecutionModel(node(leafState("drafting")));
    expect(t.domain).toBe("coding");
    expect(t.options).toEqual(SONNET_MED);
  });
});

describe("modelOptionsEqual", () => {
  it("equal objects → true", () => {
    expect(modelOptionsEqual({ model: "x", effort: "high" }, { model: "x", effort: "high" })).toBe(true);
  });
  it("differing model → false", () => {
    expect(modelOptionsEqual({ model: "x", effort: "high" }, { model: "y", effort: "high" })).toBe(false);
  });
  it("differing effort → false", () => {
    expect(modelOptionsEqual({ model: "x", effort: "high" }, { model: "x", effort: "low" })).toBe(false);
  });
  it("null vs undefined → true (both absent)", () => {
    expect(modelOptionsEqual(null, undefined)).toBe(true);
  });
  it("absent-effort equals absent-effort", () => {
    expect(modelOptionsEqual({ model: "x" }, { model: "x" })).toBe(true);
  });
  it("absent-effort vs present-effort → false", () => {
    expect(modelOptionsEqual({ model: "x" }, { model: "x", effort: "high" })).toBe(false);
  });
});
