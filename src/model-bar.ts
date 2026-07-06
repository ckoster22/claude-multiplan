// Reading-pane execution-model UI (the picker bar, the conversation-header model chip, the sidebar's
// per-node badge signature). Split out of `./model-picker` because these renderers need
// `conversation/plan-tree/triage`, which itself imports `buildOptions` from `./model-picker` — keeping
// them there would form a triage ↔ model-picker value cycle that deadlocks vite's module runner. A sink
// module; DOM handles / orchestrator snapshot come through the `./app-state` seam.

import {
  MODEL_PRESETS,
  PRESET_OPTIONS,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  isEffortLevel,
  buildOptions,
  presetClassForModel,
  friendlyModelName,
  type ModelPreset,
  type ModelOptions,
  type EffortLevel,
} from "./model-picker";
import {
  modelBarEl,
  convModelChipEl,
  orchSnapshot,
  currentRecords,
  openPath,
} from "./app-state";
import {
  getOrchestrator,
  isOrchestrationActive,
  effectiveModel,
  pathKey,
} from "./conversation/orchestrator";
import {
  resolveNodeByNnPath,
  activePathOf,
  nodeAtPath,
  type TreeNode,
  type NodePath,
} from "./conversation/plan-tree";
import { nodeExecutionModel, phaseModel } from "./conversation/plan-tree/triage";

// EXACTLY-ONCE guard for a model-override dispatch: a fast double-click on a segment cannot start a
// second setExecutionModel.
type ModelSetDispatch = "idle" | "inflight";
let modelSetDispatch: ModelSetDispatch = "idle";

// A stable digest of every node's DISPLAYED model + override source. The onSnapshot observer compares
// this against lastBadgeSig and re-renders the sidebar only on a change, so a model override flips the
// badge in-session without re-rendering on every unrelated snapshot.
export function badgeSignature(root: TreeNode): string {
  const parts: string[] = [];
  const visit = (node: TreeNode, prefix: NodePath): void => {
    const displayed = node.execution_model ?? nodeExecutionModel(node).options;
    parts.push(`${pathKey(prefix)}:${displayed.model}/${displayed.effort ?? ""}:${node.model_source ?? ""}`);
    if (node.state.stage === "split") {
      for (const child of node.state.children) visit(child, [...prefix, child.nn]);
    }
  };
  visit(root, []);
  return parts.join("|");
}

// The TRIAGE-ALIGNED override options for a picker segment. The dispatched {model, effort} must match
// the triage default for that model, NOT the raw PRESET_OPTIONS effort — otherwise "override to the
// already-recommended model" would silently downgrade effort (PRESET_OPTIONS' Fable is effort:"low";
// triage's Fable is "high") and flip the node to override for no real change. Opus defaults to
// DEFAULT_EFFORT ("high", matching triage's decomposition/large Opus); the inline effort row lets the
// user pick a different Opus effort once Opus is selected.
function overrideOptionsFor(preset: ModelPreset): ModelOptions {
  switch (preset) {
    case "opus-4-8":
      return buildOptions("claude-opus-4-8", DEFAULT_EFFORT);
    case "sonnet-5":
      return buildOptions("claude-sonnet-5", "medium");
    case "fable-5":
      return buildOptions("claude-fable-5", "high");
  }
}

// The picker segments, in the prototype's display order (Opus / Sonnet / Fable). MODEL_PRESETS is the
// roster but in a different order, so this fixes only the visual order — the roster stays single-source.
const PICKER_PRESETS: readonly ModelPreset[] = ["opus-4-8", "sonnet-5", "fable-5"];

// Resolve the open plan to its live plan-tree node (or null: no run, foreign tree, unresolved path).
function openPlanLiveNode(): { node: TreeNode; path: NodePath } | null {
  const op = openPath();
  const snap = orchSnapshot();
  if (!op || !snap) return null;
  const rec = currentRecords().find((r) => r.absolute_path === op) ?? null;
  if (!rec || !rec.tree_id || rec.tree_id !== snap.treeId) return null;
  return resolveNodeByNnPath(snap.root, rec.nn_path);
}

// Render (or hide) the reading-pane "Execution model" picker for the open plan. Visible ONLY when the
// open plan maps to a live node (a static/legacy plan has nothing to recommend or override). Rebuilt
// from scratch on each call (openPlan + every onSnapshot) so the `.on` segment / recommendation /
// override state track the live snapshot.
export function renderModelBar(): void {
  const bar = modelBarEl();
  if (!bar) return;
  const hit = openPlanLiveNode();
  if (!hit) {
    bar.classList.add("hidden");
    bar.replaceChildren();
    return;
  }
  const { node, path } = hit;
  const current = node.execution_model ?? nodeExecutionModel(node).options;
  const currentClass = presetClassForModel(current.model);
  const overridden = node.model_source === "override";
  const triage = nodeExecutionModel(node);

  bar.replaceChildren();
  bar.classList.remove("hidden");

  const row1 = document.createElement("div");
  row1.className = "row1";

  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "Execution model";
  row1.appendChild(lbl);

  const seg = document.createElement("div");
  seg.className = "seg";
  for (const preset of PICKER_PRESETS) {
    const family = preset.split("-")[0];
    const btn = document.createElement("button");
    btn.dataset.preset = preset;
    btn.classList.add(family);
    if (family === currentClass) btn.classList.add("on");
    btn.textContent = friendlyModelName(PRESET_OPTIONS[preset].model) ?? preset;
    seg.appendChild(btn);
  }
  row1.appendChild(seg);

  if (overridden) {
    const ovr = document.createElement("span");
    ovr.className = "overridden";
    ovr.textContent = "overridden by you";
    row1.appendChild(ovr);
  } else {
    const recpill = document.createElement("span");
    recpill.className = "recpill";
    recpill.textContent = `Recommended: ${friendlyModelName(triage.options.model) ?? triage.options.model}`;
    row1.appendChild(recpill);
  }
  bar.appendChild(row1);

  // Opus exposes an inline effort row (low…max). Non-Opus presets carry their effort on the preset,
  // so no effort UI is shown for them. The active button is the node's current effort (DEFAULT_EFFORT
  // when unset); choosing a different level dispatches an Opus override at that effort.
  if (currentClass === "opus") {
    const activeEffort: EffortLevel = isEffortLevel(current.effort)
      ? current.effort
      : DEFAULT_EFFORT;
    const row2 = document.createElement("div");
    row2.className = "row2";

    const elbl = document.createElement("span");
    elbl.className = "lbl";
    elbl.textContent = "Effort";
    row2.appendChild(elbl);

    const eseg = document.createElement("div");
    eseg.className = "seg";
    for (const level of EFFORT_LEVELS) {
      const btn = document.createElement("button");
      btn.dataset.effort = level;
      btn.classList.add("opus");
      if (level === activeEffort) btn.classList.add("on");
      btn.textContent = level;
      eseg.appendChild(btn);
    }
    row2.appendChild(eseg);
    bar.appendChild(row2);

    // Fresh listener each render so it closes over THIS render's live NodePath.
    eseg.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest("button[data-effort]") : null;
      if (!(btn instanceof HTMLElement)) return;
      const level = btn.dataset.effort;
      if (!isEffortLevel(level)) return;
      // Self-no-op: re-selecting the active effort would re-stamp an identical override (flipping an
      // auto node to override for no real change), so it is inert — mirrors the model-segment guard.
      if (level === activeEffort) return;
      if (modelSetDispatch === "inflight") return;
      modelSetDispatch = "inflight";
      void (async () => {
        try {
          await getOrchestrator().setExecutionModel(path, buildOptions("claude-opus-4-8", level));
        } catch (e) {
          console.error("model picker: setExecutionModel (effort) failed", e);
        } finally {
          modelSetDispatch = "idle";
        }
      })();
    });
  }

  const rationale = document.createElement("div");
  rationale.className = "rationale";
  rationale.textContent = triage.rationale;
  bar.appendChild(rationale);

  // Fresh listener each render so it closes over THIS render's live NodePath (the node can move
  // between snapshots).
  seg.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("button[data-preset]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const preset = btn.dataset.preset;
    if (!preset || !(MODEL_PRESETS as readonly string[]).includes(preset)) return;
    // Self-no-op: clicking the already-`.on` segment of a NON-overridden (auto) node must not
    // dispatch. The reducer always stamps model_source:"override", and there is no "reset to
    // recommended", so dispatching here would irreversibly flip auto→override for no real change.
    // (An already-overridden node stays clickable — re-clicking re-asserts / can pick a new model.)
    if (!overridden && preset.split("-")[0] === currentClass) return;
    if (modelSetDispatch === "inflight") return;
    modelSetDispatch = "inflight";
    void (async () => {
      try {
        await getOrchestrator().setExecutionModel(path, overrideOptionsFor(preset as ModelPreset));
      } catch (e) {
        console.error("model picker: setExecutionModel failed", e);
      } finally {
        modelSetDispatch = "idle";
      }
    })();
  });
}

// Render (or hide) the conversation-header chip that shows the model the ACTIVE session is running
// right now. Visible ONLY while an orchestration is active with a live active node; hidden otherwise
// (no run, or the terminal/acceptance window where activePathOf is null). The displayed {model, effort}
// is the orchestrator's own effectiveModel(activeNode) — the SAME override-aware resolution the
// dispatch seam asserts via setModel — so the chip can never drift from what the session actually runs.
// The tooltip carries the phase's triage rationale ("why this model"). Rebuilt from scratch each call.
export function renderModelChip(): void {
  const chip = convModelChipEl();
  if (!chip) return;
  const snap = orchSnapshot();
  const activeP = snap && isOrchestrationActive() ? activePathOf(snap.root) : null;
  const node = activeP ? nodeAtPath(snap!.root, activeP) : null;
  if (!node) {
    chip.classList.add("hidden");
    chip.replaceChildren();
    chip.removeAttribute("title");
    return;
  }
  const opts = effectiveModel(node);
  const cls = presetClassForModel(opts.model);
  chip.className = `conv-model-chip${cls ? ` ${cls}` : ""}`;
  chip.replaceChildren();

  const name = document.createElement("span");
  name.className = "cm-name";
  name.textContent = friendlyModelName(opts.model) ?? opts.model;
  chip.appendChild(name);

  if (opts.effort) {
    const eff = document.createElement("span");
    eff.className = "cm-effort";
    eff.textContent = opts.effort;
    chip.appendChild(eff);
  }

  chip.title = phaseModel(node).rationale;
}
