// Multiplan plan-tree package — LEAF: the sizer-decision parser.
//
// parseSizerDecision: extract a SizerOutcome from a single assistant text line. PURE; depends only
// on `model`.

import type { SizerOutcome } from "./model";

// Extract a SizerOutcome from a single assistant text line. FORMAT:
//   SIZER: {"decision":"split","num_plans":3,"confidence":0.82,"scale":"standard"}
// a `SIZER:` prefix followed by a JSON object. `decision` ∈ {single,split}; `num_plans` a
// non-negative integer; `confidence` a float in [0,1]; `scale` ∈ {standard,large,huge}, defaulting to
// "standard" when absent or unrecognized. Returns null for any line lacking the prefix, carrying
// malformed JSON, or holding an out-of-domain field — INCLUDING an unknown decision word (e.g. a
// stale `escalate`), which the driver coerces to a split.
export function parseSizerDecision(line: string): SizerOutcome | null {
  const m = /^\s*SIZER:\s*(\{.*\})\s*$/.exec(line);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.decision !== "single" && o.decision !== "split") return null;
  const num_plans = o.num_plans;
  if (typeof num_plans !== "number" || !Number.isInteger(num_plans) || num_plans < 0) return null;
  const confidence = o.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  const scale: SizerOutcome["scale"] =
    o.scale === "large" || o.scale === "huge" ? o.scale : "standard";
  return { decision: o.decision, confidence, num_plans, scale };
}
