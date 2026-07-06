import { invoke } from "@tauri-apps/api/core";
import {
  isOrchestrationActive,
  pathKey,
  type ResumePlan,
  type ResumeScope,
  type RecursiveLedger,
} from "./conversation/orchestrator";
import {
  resumeScopeForRoot,
  treeIsDone,
  planName2,
  activePathOf,
  nodeAtPath,
  type TreeNode,
  type NodePath,
} from "./conversation/plan-tree";
import { diag } from "./conversation/diag";
import {
  fromNullable,
  failure,
  success,
  match as foldRemoteData,
  type RemoteData,
} from "./remote-data";
import { resolvedCwdFor } from "./cwd";
import {
  RESUME_SENTINEL_SCHEME,
  resumeBannerEl,
  resumeBannerMsgEl,
  resumePlanBtnEl,
  resumeConfirmRowEl,
  resumeHazardEl,
  toastEl,
} from "./app-state";
import type { PlanRecord } from "./types";

export function resumeActionLabel(plan: ResumePlan, phaseLabel: string): string {
  switch (plan.kind) {
    case "restart":
      return "Restart from your original request";
    case "prototype-gate":
      return "Resume — Prototype review";
    case "rewind": {
      // Hazardous rewind: label "Continue implementation" (the user is resuming, not discarding);
      // the risk is surfaced in the confirm row, not the button label.
      if (plan.requiresConfirm) return "Continue implementation";
      const target = plan.toGate === "decomposition" ? "decomposition plan" : "approved plan";
      return `Rewind to ${target}`;
    }
    case "gate":
    case "resend":
    case "acceptance":
      // Active phase IS the forward action: re-present the gate / re-send / re-mint the acceptance bar.
      return `Resume — ${phaseLabel}`;
  }
}

// Reading-pane affordance by precedence: prototype > acceptance > review > resume > none.
// "review" covers both the held-gate VIEWING bar and the SUMMARY count.
export type Affordance = "none" | "prototype" | "acceptance" | "review" | "resume";

// INVARIANT[affordance-union] (precedence): at most one reading-pane affordance is active, chosen by first-match over the total order prototype > acceptance > review > resume > none.
//   prevents: two affordances painted into the bar at once
export function computeAffordance(signals: {
  prototype: boolean;
  acceptance: boolean;
  review: boolean;
  resume: boolean;
}): Affordance {
  if (signals.prototype) return "prototype";
  if (signals.acceptance) return "acceptance";
  if (signals.review) return "review";
  if (signals.resume) return "resume";
  return "none";
}

// ---- Synthetic "resume" sidebar rows ------------------------------------------------
//
// `list_plans` synthesizes a `PlanRecord` for a mid-decompose plan-tree that has NO real plan `.md`
// file yet, so the tree is still visible + its resume banner reachable. The row carries a SENTINEL
// `absolute_path` of the form `plan-tree-resume://<tree_id>` — there is NO file behind it. Anything
// that would `invoke` `read_plan_contents` / `set_open_plan` / `mark_viewed` against the path MUST
// guard on this predicate first (the Rust commands reject a sentinel — canonicalize fails on the
// scheme string).

// True iff `path` is a synthetic-row sentinel (no real `.md` file behind it).
export function isResumeSentinel(path: string): boolean {
  return path.startsWith(RESUME_SENTINEL_SCHEME);
}

// The tree_id encoded in a sentinel path (`plan-tree-resume://<tree_id>` → `<tree_id>`). Caller MUST
// have already gated on `isResumeSentinel`. Used to test whether a live-run placeholder is standing in
// for the same tree (the happy resume→placeholder takeover) before clearing a vanished sentinel.
export function resumeSentinelTreeId(path: string): string {
  return path.slice(RESUME_SENTINEL_SCHEME.length);
}

// The verdict detectResumable hands back: the pure ResumeScope (resumable OR blocked) PLUS the cwd +
// parsed ledger the click handler needs to drive getOrchestrator().resume(). Null (returned by
// detectResumable) means "no banner at all".
export type ResumeVerdict = ResumeScope & { cwd: string; ledger: RecursiveLedger };

// Narrow shape-guard for a parsed `state.json`: schema-2 ledger with a `root` node and the tree_id we
// matched on. Deliberately shallow — assertCoherent2 (run inside resumeScopeForRoot/rehydrate) is the
// deep check; this only gates the obviously-wrong (wrong schema, missing root) before any helper that
// could throw runs.
function isLedgerShape(v: unknown): v is RecursiveLedger {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.schema === 2 && typeof o.tree_id === "string" && typeof o.root === "object" && o.root !== null;
}

// READ-ONLY resume detection (NO tokens, NO agent). Given the selected plan record, decide whether a
// Resume banner should appear and, if so, with what verdict. NEVER throws (every throwing step is
// wrapped) — a plan click must not be able to crash. Returns null whenever there is no resumable
// tree: cwd unresolved, no/absent state.json, parse failure, tree_id mismatch (a stale `.plan-tree/`
// for a DIFFERENT tree must not light up), the tree already done, an orchestration already active, or
// a coherence/scope helper that threw. Returns a verdict (resumable OR blocked) otherwise, so the
// banner can render BOTH the resume button and the blocked message.
// Reads the cwd subsystem (homePath / cwdByStem) and isOrchestrationActive.
export async function detectResumable(rec: PlanRecord): Promise<ResumeVerdict | null> {
  try {
    // tree_id is required: a standalone plan (no tree) is never part of a `.plan-tree/`.
    if (!rec.tree_id) {
      diag(`detectResumable: stem=${rec.filename_stem} no tree_id → no banner`);
      return null;
    }
    // An active orchestration owns the seam — never offer a competing resume.
    if (isOrchestrationActive()) {
      diag(`detectResumable: tree_id=${rec.tree_id} orchestrationActive → no banner`);
      return null;
    }
    const cwd = resolvedCwdFor(rec);
    if (cwd === null) {
      diag(`detectResumable: tree_id=${rec.tree_id} cwd UNRESOLVED → no banner`);
      return null; // cwd unresolved → no banner.
    }

    // The state.json read is wrapped in its OWN try/catch so a cwd/IO error here (e.g. a non-existent
    // or `~`-unexpanded cwd making Rust's `read_plan_tree_file` REJECT) is distinguished from the
    // benign "no tree" case (resolve to null) and is NOT silently absorbed by the outer catch as an
    // anonymous "UNEXPECTED ERROR". Both branches → no banner; the diag tells them apart in dev.
    let stateFile: RemoteData<string>;
    try {
      stateFile = fromNullable(
        await invoke<string | null>("read_plan_tree_file", { cwd, name: "state.json" }),
      );
    } catch (e) {
      console.debug("detectResumable: read_plan_tree_file(state.json) rejected", e);
      diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json READ ERROR (${e}) → no banner`);
      return null; // cwd/IO error reading the tree → not resumable (and now visibly diagnosed).
    }
    // `fromNullable` maps an ABSENT state.json (null) -> zeroResults; a present one -> success. Fold all
    // five arms to the raw text, or null when there is no resumable tree (absent/unread).
    const raw = foldRemoteData(stateFile, {
      initial: () => null,
      fetching: () => null,
      zeroResults: (): string | null => {
        diag(`detectResumable: tree_id=${rec.tree_id} cwd=${cwd} state.json NOT FOUND → no banner`);
        return null;
      },
      success: (data): string | null => data,
      error: () => null,
    });
    if (raw === null) {
      return null; // no `.plan-tree/state.json` → not a resumable tree.
    }

    // Defensive parse + shape-guard — a torn/foreign file must degrade to no-banner, never throw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.debug("detectResumable: state.json parse failed", e);
      diag(`detectResumable: tree_id=${rec.tree_id} state.json PARSE FAILED → no banner`);
      return null;
    }
    if (!isLedgerShape(parsed)) {
      diag(`detectResumable: tree_id=${rec.tree_id} state.json wrong shape → no banner`);
      return null;
    }
    const ledger = parsed;

    // STALE-TREE GUARD: a `.plan-tree/` left by a DIFFERENT tree must not light up this plan's banner.
    if (ledger.tree_id !== rec.tree_id) {
      diag(
        `detectResumable: tree_id MISMATCH (ledger=${ledger.tree_id} rec=${rec.tree_id}) → no banner`,
      );
      return null;
    }

    const root = ledger.root as TreeNode;

    // BANNER↔ENGINE DISK-PROBE SYMMETRY: the engine (orchestrator.resume) classifies a persisted
    // `open/decomposing` node by probing disk — does planName2(activePath) exist under `.plan-tree/`? —
    // and gates (re-present the decomposition gate) when present, resends ("decompose") when absent. The
    // banner MUST classify identically, so pre-read that SAME single artifact here and back a synchronous
    // predicate with the cached result. recoveryFor only ever probes the ACTIVE node's path, so probe the
    // DYNAMIC activePathOf(root) (nested decomposes resolve correctly), NOT a hardcoded root. A NON-NULL
    // read ⇒ "present"; null/absent/missing-file/IO-error ⇒ "absent" (the conservative default, matching
    // the engine). Every read is guarded so a missing file degrades to "absent" — never a throw
    // (detectResumable must never throw). The predicate keys on pathKey so a probe of any other path
    // falls through to absent rather than a phantom hit.
    // The probe fires ONLY when the active node is actually open/decomposing (the sole consumer of the
    // predicate in recoveryFor). A leaf gate or any other phase needs no `.plan-tree/` filename read,
    // and firing one there would be a wasted disk hit (and would wrongly probe `.plan-tree/` for a leaf
    // plan that lives under ~/.claude/plans/, tripping the leaf-gate "no plan-tree probe" invariant).
    const decompositionArtifactCache = new Map<string, boolean>();
    const activeForProbe = activePathOf(root);
    if (activeForProbe !== null) {
      const activeNode = nodeAtPath(root, activeForProbe);
      const isDecomposing =
        activeNode?.state.stage === "open" && activeNode.state.phase === "decomposing";
      if (isDecomposing) {
        let probe: RemoteData<string>;
        try {
          probe = fromNullable(
            await invoke<string | null>("read_plan_tree_file", {
              cwd,
              name: planName2(activeForProbe),
            }),
          );
        } catch (e) {
          console.debug("detectResumable: decomposition-artifact probe failed", e);
          probe = failure(String(e)); // missing/IO-error ⇒ absent.
        }
        // present (success) ⇒ exists; absent (zeroResults) or errored ⇒ does not exist.
        const exists = foldRemoteData(probe, {
          initial: () => false,
          fetching: () => false,
          zeroResults: () => false,
          success: () => true,
          error: () => false,
        });
        decompositionArtifactCache.set(pathKey(activeForProbe), exists);
      }
    }
    const decompositionArtifactExists = (path: NodePath): boolean =>
      decompositionArtifactCache.get(pathKey(path)) ?? false;

    // treeIsDone is pure + total, but wrap defensively alongside resumeScopeForRoot (which CAN throw on
    // an unclassified node state via assertNeverRecovery). Any throw → no banner.
    let scope: ResumeScope;
    try {
      if (treeIsDone(root)) {
        diag(`detectResumable: tree_id=${rec.tree_id} treeIsDone=true → no banner`);
        return null; // a completed tree is not resumable.
      }
      // Pass the ledger so the acceptance window (a baseline-bearing root parked awaiting a
      // verdict) classifies as resumable rather than blocked, and the disk-probe predicate so
      // open/decomposing is classified gate-vs-resend identically to the engine.
      scope = resumeScopeForRoot(root, ledger, decompositionArtifactExists);
    } catch (e) {
      console.debug("detectResumable: resume-scope derivation threw", e);
      diag(`detectResumable: tree_id=${rec.tree_id} resumeScopeForRoot THREW → no banner`);
      return null;
    }

    if (!scope.resumable) {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} scope=BLOCKED(${scope.reason}) phase="${scope.phaseLabel}" → blocked banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // For a resumable GATE scope, the user reviews an on-disk plan artifact — verify it exists, else
    // the gate cannot be re-presented. The two gate kinds live in DIFFERENT trees on disk:
    //   - LEAF gate: `scope.plan.planPath` is the ABSOLUTE path recorded on the node at NODE_DRAFTED.
    //     This app writes leaf plans into `~/.claude/plans/` (NOT `.plan-tree/`), so the artifact is
    //     verified through the plans channel (`read_plan_contents`, which canon-checks containment in
    //     the plans dir). Using `read_plan_tree_file` here would ALWAYS miss (the file is not under
    //     `.plan-tree/`) and false-negative every real leaf gate into a blocked banner.
    //   - DECOMPOSITION gate: an `open/awaiting-decomposition-approval` node has no path field, so
    //     `scope.plan.planPath` is the FILENAME `planName2(path)` ("master.md" / "<pathKey>-plan.md")
    //     under `.plan-tree/` — verified through `read_plan_tree_file`.
    // Missing artifact → degrade to a BLOCKED verdict (banner shows the message, not a button).
    // Resend scopes need no artifact (the prompt is re-sent fresh).
    // The forced acceptance window: the build is COMPLETE; the only thing missing is the
    // user's verdict against the frozen baseline. There is NO plan artifact to verify (no model turn
    // resumes — the driver re-mints the acceptance gate and surfaces the bar). Surface it as a
    // resumable banner so reopening the app shows the acceptance bar, not the blocked message.
    if (scope.plan.kind === "acceptance") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE acceptance window phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "gate") {
      const plan = scope.plan;
      // The leaf gate artifact is a SCALAR plans-store read (success, or a thrown read → error); the
      // decomposition gate artifact is an OPTIONAL `.plan-tree/` read (fromNullable: absent →
      // zeroResults, present → success). Both flow into one RemoteData<string> whose only "present"
      // state is `success`.
      let artifact: RemoteData<string>;
      try {
        if (plan.gateKind === "leaf") {
          // The node's absolute `~/.claude/plans/...` path — verify through the plans channel.
          artifact = success(await invoke<string>("read_plan_contents", { path: plan.planPath }));
        } else {
          // The decomposition plan lives under `.plan-tree/` by filename.
          artifact = fromNullable(
            await invoke<string | null>("read_plan_tree_file", {
              cwd,
              name: planName2(plan.path),
            }),
          );
        }
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file — treat any
        // throw as "absent" rather than crashing the click.
        console.debug("detectResumable: gate-artifact read failed", e);
        artifact = failure(String(e));
      }
      // The gate is re-presentable only when the artifact is PRESENT (success); absent (zeroResults)
      // or errored ⇒ missing.
      const artifactPresent = foldRemoteData(artifact, {
        initial: () => false,
        fetching: () => false,
        zeroResults: () => false,
        success: () => true,
        error: () => false,
      });
      if (!artifactPresent) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} ${plan.gateKind} gate artifact MISSING (planPath=${plan.planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${plan.gateKind} gate at "${pathKey(plan.path)}" planPath=${plan.planPath} phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    if (scope.plan.kind === "resend") {
      diag(
        `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE resend(${scope.plan.awaiting}) phase="${scope.phaseLabel}" → Resume banner`,
      );
      return { ...scope, cwd, ledger };
    }

    // New kinds (restart / prototype-gate / rewind): the pure scope is now RESUMABLE and the
    // banner offers them as real one-click FORWARD actions. The orchestrator decides the concrete
    // action from the ledger (resume keys off cwd+ledger), so the banner only triggers resume.
    //   - restart{from:"clarify"} / prototype-gate: NO artifact verification — `restart` re-runs the
    //     clarify turn from the root title (no durable plan to read), and `prototype-gate`'s artifact
    //     is the `.plan-tree/prototype/` directory + INTENT.md the driver re-mints (not a single plan
    //     .md verified through the gate channels). Both are resumable as-is.
    //   - rewind: when `planPath` is non-null the rewind re-presents an on-disk plan artifact, but the
    //     CHANNEL depends on the artifact's SHAPE (mirroring how the gate branch above distinguishes
    //     leaf vs decomposition):
    //       * ABSOLUTE `~/.claude/plans/...` planPath ⇒ a LEAF artifact (the leaf/executing
    //         audit-and-continue rewind carries the node's own absolute planPath, recorded at
    //         NODE_DRAFTED — leaves write ONLY to the plans store, never `.plan-tree/`). Verify it
    //         through the PLANS channel (read_plan_contents). Using read_plan_tree_file here would
    //         ALWAYS miss — the Rust allow-list (valid_plan_tree_name) rejects an absolute name — so
    //         every real executing rewind would false-negative into a blocked banner (the "Continue
    //         implementation" button would never appear).
    //       * RELATIVE name ⇒ a decomposition plan filename under `.plan-tree/` (planName2(path)) —
    //         verify it like a DECOMPOSITION gate (read_plan_tree_file).
    //     A null planPath rewind (a torn leaf gate, the runtime-degenerate no-active-node case) has no
    //     single artifact to read → resumable with no verification.
    if (scope.plan.kind === "rewind" && scope.plan.planPath !== null) {
      const planPath = scope.plan.planPath;
      const isAbsolute = planPath.startsWith("/") || planPath.startsWith("~");
      // ABSOLUTE planPath ⇒ a SCALAR plans-store read (success, or thrown → error); RELATIVE ⇒ an
      // OPTIONAL `.plan-tree/` read (fromNullable: absent → zeroResults, present → success). The
      // rewind re-presents the artifact only when it is PRESENT (success).
      let artifact: RemoteData<string>;
      try {
        artifact = isAbsolute
          ? success(await invoke<string>("read_plan_contents", { path: planPath }))
          : fromNullable(await invoke<string | null>("read_plan_tree_file", { cwd, name: planPath }));
      } catch (e) {
        // read_plan_contents REJECTS (not resolves null) on a missing/out-of-bounds file, and
        // read_plan_tree_file rejects an invalid/out-of-bounds name — treat any throw as "absent"
        // rather than crashing the click.
        console.debug("detectResumable: rewind-artifact probe failed", e);
        artifact = failure(String(e)); // missing/IO-error ⇒ absent.
      }
      const artifactPresent = foldRemoteData(artifact, {
        initial: () => false,
        fetching: () => false,
        zeroResults: () => false,
        success: () => true,
        error: () => false,
      });
      if (!artifactPresent) {
        diag(
          `detectResumable: tree_id=${rec.tree_id} rewind artifact MISSING (planPath=${planPath}) → blocked banner`,
        );
        return { resumable: false, reason: "plan artifact missing", phaseLabel: scope.phaseLabel, cwd, ledger };
      }
    }
    diag(
      `detectResumable: tree_id=${rec.tree_id} cwd=${cwd} RESUMABLE ${scope.plan.kind} phase="${scope.phaseLabel}" → Resume banner`,
    );
    return { ...scope, cwd, ledger };
  } catch (e) {
    // Belt-and-suspenders: detectResumable must NEVER throw on a plan click.
    console.debug("detectResumable: unexpected error", e);
    diag(`detectResumable: UNEXPECTED ERROR → no banner`);
    return null;
  }
}

// Resume context for the currently-rendered resumable banner; null when hidden / blocked. Set by
// renderResumeBanner when a resumable verdict paints, cleared on hide / blocked / success. Owned here
// (a module `let`) rather than in `main` because a controller cannot write a main-resident `let`
// through the read-only injection getters; `resumeFromBanner`/`executeResume` in `main` read it back
// via getPendingResume().
let pendingResume: { cwd: string; ledger: RecursiveLedger; requiresConfirm: boolean; hazard: string | null } | null =
  null;

// The resume context stashed by the last resumable render (or null). Read by the staying
// resumeFromBanner/executeResume in `main`.
export function getPendingResume(): {
  cwd: string;
  ledger: RecursiveLedger;
  requiresConfirm: boolean;
  hazard: string | null;
} | null {
  return pendingResume;
}

// Drop the stashed resume context (used by the test-reset seam in `main`).
export function clearPendingResume(): void {
  pendingResume = null;
}

// Render the #resume-banner from a verdict (or hide it for null). Pure DOM derivation: resumable →
// the #resume-plan-btn labeled per-kind (see resumeActionLabel; the resume context stashed for its
// click); blocked → a static muted "<phaseLabel> — resuming from here isn't supported yet" message,
// no button; null → hidden + context cleared. A SEPARATE surface from refreshReviewBar, but per the
// precedence refreshAffordances only paints it when no higher affordance occupies the bar.
export function renderResumeBanner(verdict: ResumeVerdict | null): void {
  const bannerEl = resumeBannerEl();
  if (!bannerEl) return;
  const msgEl = resumeBannerMsgEl();
  const btnEl = resumePlanBtnEl();
  // Always start from the collapsed (one-click) confirm state — any prior verdict's open confirm row
  // must not bleed across a re-render onto a different/blocked/hidden verdict.
  hideResumeConfirmRow();
  if (verdict === null) {
    pendingResume = null;
    bannerEl.classList.add("hidden");
    bannerEl.classList.remove("blocked");
    btnEl?.classList.add("hidden");
    if (msgEl) msgEl.textContent = "";
    return;
  }
  bannerEl.classList.remove("hidden");
  if (verdict.resumable) {
    // Only a `rewind` plan carries `requiresConfirm`/`hazard` (leaf/executing today); every other
    // resumable kind is one-click (requiresConfirm absent ⇒ false). Extract them onto pendingResume so
    // the click handler can gate the hazardous case without re-deriving the plan shape.
    const requiresConfirm = verdict.plan.kind === "rewind" && verdict.plan.requiresConfirm === true;
    const hazard =
      verdict.plan.kind === "rewind" && verdict.plan.hazard !== undefined ? verdict.plan.hazard : null;
    pendingResume = { cwd: verdict.cwd, ledger: verdict.ledger, requiresConfirm, hazard };
    bannerEl.classList.remove("blocked");
    if (msgEl) msgEl.textContent = "";
    if (btnEl) {
      btnEl.classList.remove("hidden");
      btnEl.textContent = resumeActionLabel(verdict.plan, verdict.phaseLabel);
    }
  } else {
    pendingResume = null;
    bannerEl.classList.add("blocked");
    btnEl?.classList.add("hidden");
    if (msgEl) {
      msgEl.textContent = `${verdict.phaseLabel} — resuming from here isn't supported yet`;
    }
  }
}

// Collapse the inline confirm row back to the one-click button (hide the confirm/cancel pair + hazard
// text, re-show the primary button). Idempotent — safe to call when the row was never opened.
function hideResumeConfirmRow(): void {
  resumeConfirmRowEl()?.classList.add("hidden");
  const hazardEl = resumeHazardEl();
  if (hazardEl) hazardEl.textContent = "";
  resumePlanBtnEl()?.classList.remove("hidden");
}

// Cancel the hazardous confirm step: abort WITHOUT resuming, collapsing the confirm row back to the
// one-click button. pendingResume is untouched (the banner stays, the verdict remains resumable).
export function cancelResumeConfirm(): void {
  hideResumeConfirmRow();
}

// Show the lightweight #toast with `msg`, auto-dismissing after TOAST_MS. Non-blocking — it never
// changes session/tab state. A second call resets the timer (latest message wins).
const TOAST_MS = 6000;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string): void {
  const el = toastEl();
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("hidden");
    toastTimer = null;
  }, TOAST_MS);
}
