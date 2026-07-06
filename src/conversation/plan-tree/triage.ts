// Multiplan plan-tree package — LEAF: pure model-triage (which Claude model fits which phase).
//
// Maps a node's live (stage, phase) to the effective LLM {model, effort} for the turn that runs
// there, the node's PERSISTED per-node model, and the leaf coding-scale tier — each with a domain
// tag and a short rationale for the UI. PURE: no DOM, no Tauri, no I/O. Depends on `model` (TreeNode
// / NodeState types) and `model-picker` (`buildOptions` value + `ModelOptions` type-only). The
// switches are exhaustive + total over the state union (`assertNever` makes a new phase a compile
// error). `model-picker` imports nothing from plan-tree, so no cycle (the reading-pane picker/chip
// renderers that DO need triage live in `model-bar`, a sink module, not in `model-picker`).

import { buildOptions } from "../../model-picker";
import type { ModelOptions } from "../../model-picker";
import type { TreeNode } from "./model";

// The four coarse work domains a turn falls into. Drives the model choice AND is surfaced to the UI.
export type Domain = "visual" | "research" | "reasoning" | "coding";

// The leaf's execution size tier, stamped onto a leaf's execution_model at decomposition time.
export type Scale = "standard" | "large" | "huge";

// A model choice with its domain classification and a short human rationale (for the UI/audit).
interface Triage {
  options: ModelOptions;
  domain: Domain;
  rationale: string;
}

// Total assertion helper — an unhandled union member is a compile error at the call site.
function assertNever(x: never): never {
  throw new Error(`unexpected value: ${String(x)}`);
}

// The neutral coding default when a leaf carries no stamped execution_model.
const CODING_DEFAULT: ModelOptions = buildOptions("claude-sonnet-5", "medium");

// The decomposition model: what a `split` node (and the root's decomposition node) runs. The reducer
// stamps this so it needs the Opus decomposition model without importing model-picker.
export function decompositionModel(): ModelOptions {
  return buildOptions("claude-opus-4-8", "high");
}

// The leaf coding-execution model by scale tier.
export function codingModelForScale(scale: Scale): ModelOptions {
  switch (scale) {
    case "standard":
      return buildOptions("claude-sonnet-5", "medium");
    case "large":
      return buildOptions("claude-opus-4-8", "high");
    case "huge":
      return buildOptions("claude-fable-5", "high");
    default:
      return assertNever(scale);
  }
}

// The RUNTIME effective model for the live turn at this node's current (stage, phase).
export function phaseModel(node: TreeNode): Triage {
  const state = node.state;
  switch (state.stage) {
    case "open": {
      const phase = state.phase;
      switch (phase) {
        case "clarifying-intent":
        case "prototype-review":
          return {
            options: buildOptions("claude-sonnet-5", "high"),
            domain: "visual",
            rationale:
              "Visual prototyping — fast, cheap throwaway UI iteration; near-Opus coding.",
          };
        case "recon":
          return {
            options: buildOptions("claude-sonnet-5", "high"),
            domain: "research",
            rationale:
              "Web research / codebase recon — BrowseComp parity with Opus at ~1/3 token cost.",
          };
        case "sizing":
        case "decomposing":
        case "awaiting-decomposition-approval":
          return {
            options: buildOptions("claude-opus-4-8", "high"),
            domain: "reasoning",
            rationale: "Right-sizing & decomposition — Opus 4.8 leads math/reasoning.",
          };
        case "pending":
          return {
            options: buildOptions("claude-sonnet-5", "high"),
            domain: "research",
            rationale:
              "Freshly-minted node — safe cheap default until the node activates.",
          };
        default:
          return assertNever(phase);
      }
    }
    case "leaf": {
      const phase = state.phase;
      switch (phase) {
        case "drafting":
        case "awaiting-approval":
          return {
            options: buildOptions("claude-opus-4-8", "high"),
            domain: "reasoning",
            rationale: "Plan authoring — reasoning-heavy.",
          };
        case "executing":
          return {
            options: node.execution_model ?? CODING_DEFAULT,
            domain: "coding",
            rationale: "Coding execution — runs the leaf's scale-tiered model.",
          };
        case "summarized":
          return {
            options: node.execution_model ?? CODING_DEFAULT,
            domain: "coding",
            rationale: "Coding execution — runs the leaf's scale-tiered model.",
          };
        default:
          return assertNever(phase);
      }
    }
    case "split": {
      const phase = state.phase;
      switch (phase) {
        case "running-children":
        case "reviewing":
        case "summarized":
          return {
            options: buildOptions("claude-opus-4-8", "high"),
            domain: "reasoning",
            rationale: "Decomposition — Opus 4.8.",
          };
        default:
          return assertNever(phase);
      }
    }
    default:
      return assertNever(state);
  }
}

// The PERSISTED per-node model (what the node IS, independent of the momentary live phase).
export function nodeExecutionModel(node: TreeNode): Triage {
  const state = node.state;
  switch (state.stage) {
    case "split":
      return {
        options: buildOptions("claude-opus-4-8", "high"),
        domain: "reasoning",
        rationale: "Decomposition — Opus 4.8.",
      };
    case "leaf":
      return {
        options: node.execution_model ?? CODING_DEFAULT,
        domain: "coding",
        rationale: "Coding execution — runs the leaf's scale-tiered model.",
      };
    case "open":
      return {
        options: node.execution_model ?? buildOptions("claude-sonnet-5", "high"),
        domain: "research",
        rationale: "Un-sized node — provisional cheap default.",
      };
    default:
      return assertNever(state);
  }
}

// Structural equality on {model, effort}. A missing effort key equals a missing effort key; null and
// undefined both mean "absent".
export function modelOptionsEqual(
  a: ModelOptions | null | undefined,
  b: ModelOptions | null | undefined,
): boolean {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === null || bn === null) return an === bn;
  return an.model === bn.model && (an.effort ?? undefined) === (bn.effort ?? undefined);
}
