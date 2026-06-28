# Invariants catalog

> **GENERATED FILE — do not edit by hand. Run `npm run gen:invariants`. Source of truth: the `// INVARIANT[...]` comments in the code.**

Each invariant is a named property that always holds, documented as a co-located doc-comment directly above the construct that guarantees it. Line numbers below are recomputed at generation time, so they never rot — the comment next to the code is authoritative.

## Tier legend

Ranked strongest → weakest (how hard the invariant is to violate):

- **`type-level`** — the property is enforced by the type system — the invalid state does not compile.
- **`runtime-guard`** — an explicit runtime check rejects or neutralizes the invalid state.
- **`precedence`** — an ordering / priority of rules guarantees the property (e.g. SDK hook precedence).
- **`reducer-total`** — a total, exhaustive pure reducer maps every input to a defined valid state.
- **`containment`** — writes or effects are constrained to a bounded path / scope.
- **`sanitization`** — untrusted content is cleansed before it reaches a sink.
- **`test-pinned`** — the property holds because a test pins it — no structural enforcement.
- **`convention`** — a discipline the code follows (grep-verifiable), not compiler- or test-enforced.

## Summary (count per domain × tier)

| Domain | type-level | runtime-guard | precedence | reducer-total | containment | sanitization | test-pinned | convention | Total |
|---|---|---|---|---|---|---|---|---|---|
| Reading-pane render | 1 | 8 | 0 | 0 | 0 | 3 | 0 | 7 | 19 |
| Conversation / live-session | 7 | 19 | 0 | 1 | 0 | 0 | 0 | 5 | 32 |
| App shell — selection / review / gates | 5 | 19 | 5 | 0 | 0 | 0 | 0 | 6 | 35 |
| Sidecar / agent-driver | 3 | 13 | 0 | 0 | 4 | 0 | 0 | 3 | 23 |
| Other | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| **Total** | 17 | 59 | 5 | 1 | 4 | 3 | 0 | 21 | 110 |

## Reading-pane render

### comment-anchor-excludes-mermaid-and-code
**`runtime-guard`** — A selection starting/ending inside fenced-code, a mermaid box, or <svg> is rejected at capture and skipped by the normalized char-map walk.

**Prevents:** a comment anchored in a diagram/code re-anchoring wrong (or not at all) across reloads.

**Anchor:** `src/render/comments.ts:96` — `function isExcludedContainer(node: Node, root: HTMLElement): boolean {`

### popover-state-is-tagged-union
**`type-level`** — The popover is a discriminated union hidden|create|view; visibility = kind!=='hidden', with no parallel boolean.

**Prevents:** visible-but-no-subject / simultaneously-create-and-view states.

**Anchor:** `src/render/comments.ts:300` — `type PopoverState =`

### popover-owned-by-capturing-plan
**`runtime-guard`** — A create/view popover records the plan path open at capture; the saveEl guard makes Save a no-op when the current plan differs (the Save guard, comparing the recorded planPath to the current plan, is the enforcer).

**Prevents:** a draft captured on plan A being persisted/anchored onto plan B after a mid-draft switch.

**Anchor:** `src/render/comments.ts:311` — `planPath: string | null;`

### renderpopover-is-sole-dom-writer
**`convention`** — renderPopover is the only writer of #sel-popover.hidden / #sp-quote / #sp-text; every transition routes through it (grep-verified, not compiler-enforced).

**Prevents:** the visibility class desyncing from state.kind (a visible popover with no subject, or a hidden one with live state).

**Anchor:** `src/render/comments.ts:384` — `function renderPopover(next: PopoverState): void {`

### popover-invalidate-discards-on-plan-change-preserves-on-reload
**`runtime-guard`** — invalidatePopover discards the draft only on a genuine plan-path change; a same-plan live reload preserves the draft and re-anchors its Range to fresh DOM.

**Prevents:** a draft pointing at detached old-plan DOM, or the draft destroyed on every same-plan reload.

**Anchor:** `src/render/comments.ts:609` — `function invalidateOrReanchor(): void {`

### invalidate-via-registry-preserves-sole-writer
**`convention`** — The facade invalidates only via a per-pane WeakMap callback into the closure; it never toggles .hidden directly.

**Prevents:** the facade flipping popover DOM out-of-band, breaking the renderPopover sole-writer invariant.

**Anchor:** `src/render/comments.ts:691` — `export function invalidatePopover(paneEl: HTMLElement): void {`

### renderinto-is-pure-sync-transform
**`convention`** — renderInto does only the synchronous markdown→HTML transform; it starts no async asset/highlight work.

**Prevents:** scroll-restore running against a layout still shifting from in-flight async assets.

**Anchor:** `src/render/index.ts:42` — `export function renderInto(`

### settle-resolves-images-before-awaiting-them
**`runtime-guard`** — settle resolves local image data: URLs before renderDiagrams and before awaitImages, so no <img> is awaited holding an empty placeholder src.

**Prevents:** awaitImages treating an unresolved placeholder as complete, drifting the restored scroll.

**Anchor:** `src/render/index.ts:84` — `await resolveLocalImages(paneEl, planDir);`

### settle-forwards-cancellation
**`runtime-guard`** — settle threads its isCurrent predicate straight into renderDiagrams.

**Prevents:** a cancellable settle that still runs a superseded mermaid pass.

**Anchor:** `src/render/index.ts:87` — `await renderDiagrams(paneEl, isCurrent);`

### mermaid-source-carried-verbatim-not-as-code
**`convention`** — A mermaid fence renders to <pre class='mermaid-src'> carrying escaped raw source, never <pre><code>.

**Prevents:** diagram source being syntax-highlighted as code instead of rendered as a diagram.

**Anchor:** `src/render/markdown.ts:47` — `if (lang === "mermaid") {`

### foreignobject-html-integration-survives-sanitization
**`sanitization`** — The sanitize config preserves <foreignObject> + HTML-namespaced children (multi-line labels) while stripping <script>/on* handlers.

**Prevents:** both failure modes — labels collapsing (config too strict) and on*/script handlers surviving (config too loose).

**Anchor:** `src/render/mermaid.ts:43` — `export const MERMAID_SANITIZE_CONFIG = {`

### single-sanitize-config-source
**`convention`** — One exported sanitize-config; production and tests exercise the same profile (tests via sanitizeSvg).

**Prevents:** test/prod sanitizer drift — a test passing against a profile production never actually uses.

**Anchor:** `src/render/mermaid.ts:43` — `export const MERMAID_SANITIZE_CONFIG = {`

### loose-security-mandates-own-sanitizer
**`sanitization`** — Mermaid runs at securityLevel:'loose' (which disables its internal sanitizer), so the pane runs its own DOMPurify pass.

**Prevents:** relying on a sanitizer loose-mode turned off → raw active content reaching the DOM.

**Anchor:** `src/render/mermaid.ts:52` — `export function sanitizeSvg(svg: string): string {`

### iscurrent-default-keeps-callers-current
**`convention`** — renderDiagrams' isCurrent param defaults to always-current, so existing positional callers compile and behave unchanged.

**Prevents:** a required-param break of existing callers / accidental cancellation of normal (non-superseded) renders.

**Anchor:** `src/render/mermaid.ts:114` — `export async function renderDiagrams(`

### superseded-render-injects-nothing
**`runtime-guard`** — A superseded render pass (isCurrent()===false) injects no diagram and registers no controller — checked before render, before DOM replace, and before controller registration.

**Prevents:** a stale generation's diagram landing in a live pane; an orphan pan/zoom controller leaking a window listener.

**Anchor:** `src/render/mermaid.ts:137` — `for (const el of sources) {`

### mermaid-bad-diagram-never-blanks-pane
**`runtime-guard`** — A diagram that fails to parse/render is replaced with its raw source + a dim error note; rendering never throws or blanks the pane.

**Prevents:** one malformed diagram crashing/blanking the whole reading pane.

**Anchor:** `src/render/mermaid.ts:145` — `try {`

### mermaid-bindfunctions-never-called
**`convention`** — bindFunctions is never invoked on a rendered diagram, so any embedded click/script wiring stays inert.

**Prevents:** re-activating click/script handlers that sanitization stripped.

**Anchor:** `src/render/mermaid.ts:148` — `const { svg } = await mermaid.render(id, src);`

### pan-zoom-controller-no-listener-leak-across-renders
**`runtime-guard`** — A pane's previous pan/zoom controllers are destroyed before a new render builds new ones (at the innerHTML wipe and at renderDiagrams top).

**Prevents:** window drag/wheel listeners accumulating across live-reloads.

**Anchor:** `src/render/mermaid.ts:193` — `export function destroyControllers(paneEl: HTMLElement): void {`

### mermaid-svg-always-dompurified-before-innerhtml
**`sanitization`** — Every mermaid-produced SVG is DOMPurify-sanitized before it is assigned to innerHTML.

**Prevents:** stored XSS — an injected <script>/on* handler in a plan's node label executing on render.

**Anchor:** `src/render/mermaid.ts:225` — `stage.innerHTML = sanitizeSvg(svg);`

## Conversation / live-session

### setimages-owns-its-copies
**`convention`** — setImages replaces the set wholesale and copies each entry, so the controller never aliases the caller's snapshot.

**Prevents:** shared-reference mutation between controller and the captured sending-state images

**Anchor:** `src/conversation/attachments.ts:192` — `setImages: (imgs) => {`

### composer-single-start
**`runtime-guard`** — a rapid double-click/double-Enter on Start dispatches exactly one run.

**Prevents:** double session-start

**Anchor:** `src/conversation/composer.ts:236` — `if (this.starting) return;`

### validate-before-arm
**`convention`** — input validation runs before arming `this.starting`, so a validation failure never latches Start disabled.

**Prevents:** a latched-disabled Start after a recoverable validation error

**Anchor:** `src/conversation/composer.ts:243` — `if (!text) {`

### dispatch-dimension-orthogonal
**`type-level`** — a send/resume round-trip in flight is its own dimension, exactly idle|sending|resuming — separate from SessionState.

**Prevents:** a double-fire dispatching twice because 'in flight' was not representable

**Anchor:** `src/conversation/index.ts:63` — `export type DispatchState =`

### sending-carries-its-restore-payload
**`type-level`** — while dispatch is 'sending', the typed text+images ride on the state object so a rejected send hands the exact input back.

**Prevents:** a sending state with no way to recover the user's message

**Anchor:** `src/conversation/index.ts:63` — `export type DispatchState =`

### session-single-source-of-truth
**`convention`** — all liveness-derived UI derives from this one SessionState; applySessionState is the sole mutator (grep-verified — one `let session`, one writer) and re-derives every control purely on each transition.

**Prevents:** contradictory control states (New-plan modal open while live; Resume enabled while active)

**Anchor:** `src/conversation/index.ts:243` — `type SessionState = "none" | "active" | "idle" | "paused";`

### post-stop-idempotent-none
**`runtime-guard`** — applySessionState assigns `session = next` then re-derives, so a transition to the already-current state (a late agent-exit after explicit Stop → 'none') is idempotent.

**Prevents:** a duplicate teardown/re-render from a redundant terminal signal

**Anchor:** `src/conversation/index.ts:302` — `const applySessionState = (next: SessionState): void => {`

### resume-reverts-on-reject
**`runtime-guard`** — the optimistic flip to active is pending-until-confirmed — a rejected dispatch reverts to the captured prior state.

**Prevents:** a phantom stuck 'Working…' with Resume disabled forever

**Anchor:** `src/conversation/index.ts:817` — `const prev = session; // "idle"`

### sync-throw-no-lockout
**`runtime-guard`** — a synchronous throw in the marker→sync-work→invoke sequence recovers dispatch to idle.

**Prevents:** a permanent Send/Resume lockout (the async .catch never runs on a sync throw)

**Anchor:** `src/conversation/index.ts:825` — `try {`

### single-dispatch-under-double-fire
**`runtime-guard`** — a second Send/Resume/Enter before the first round-trip settles dispatches exactly once.

**Prevents:** double send_agent_message / double session-open

**Anchor:** `src/conversation/index.ts:873` — `if (dispatch.t !== "idle") return;`

### restore-only-if-not-retyped
**`runtime-guard`** — a failed dispatch restores captured text/images only if the field/tray is still empty.

**Prevents:** clobbering newer input typed during the round-trip

**Anchor:** `src/conversation/index.ts:889` — `const restoreInput = (): void => {`

### synchronous-clear-once
**`runtime-guard`** — the field/chips clear synchronously at fire time and are never re-cleared on resolve.

**Prevents:** text typed during an open round-trip wiped when the first send resolves

**Anchor:** `src/conversation/index.ts:987` — `dispatch = { t: "sending", text, images };`

### no-orphan-bubble
**`runtime-guard`** — a user bubble is appended only on a dispatched-and-resolved turn; a failed send adds a notice, no bubble.

**Prevents:** an orphan bubble implying the agent got a message it never did

**Anchor:** `src/conversation/index.ts:994` — `.then(() => {`

### awaiting-exactly-one-armed-step
**`type-level`** — at most one sequencer step is armed — `run.awaiting` is exactly one tagged variant; a result while idle is swallowed.

**Prevents:** a boundary result consumed by the wrong step; two steps armed at once

**Anchor:** `src/conversation/orchestrator.ts:1430` — `type Awaiting =`

### runstate-all-or-nothing-reset
**`type-level`** — every per-run transient lives in this one bundle; freshRunState's `: RunState` return forces every field initialized, and start()/resume() replace it wholesale, so all transients reset together.

**Prevents:** run A's context (stale summary/mandate/held-permission) bleeding into run B

**Anchor:** `src/conversation/orchestrator.ts:1491` — `interface RunState {`

### at-most-one-adjust-note
**`type-level`** — at most one parent-review adjustment note is pending (single nullable field), scoped to its issuing parent's children via parentKey.

**Prevents:** a second pending note coexisting / leaking into another level's prompts

**Anchor:** `src/conversation/orchestrator.ts:1532` — `adjustNote: { parentKey: PathKey; note: string } | null;`

### at-most-one-pending-gate
**`runtime-guard`** — a re-presented disk gate carries a synthetic `resumed:` id (the live resolver died with the prior process); this short-circuit drops its resolvePermission rather than calling the dead sidecar resolver.

**Prevents:** resolving a dead synthetic id against the sidecar

**Anchor:** `src/conversation/orchestrator.ts:1807` — `if (eff.id.startsWith("resumed:")) {`

### asserted-policy-is-a-pure-ledger-cache
**`runtime-guard`** — session permission mode is a pure function of the ledger (writePolicyFor2); run.assertedPolicy is only a cache, re-asserted when it differs (null after an ExitPlanMode allow makes the live mode unknown).

**Prevents:** the session running in a stale write policy after an out-of-band plan-mode exit

**Anchor:** `src/conversation/orchestrator.ts:2016` — `if (active) {`

### one-turn-watchdog-slot
**`runtime-guard`** — exactly one turn is in flight, so one shared watchdog handle (run.turnWatchdog); every arm site clears the prior first (clearTurnWatchdog).

**Prevents:** two live watchdog timers firing competing FATALs

**Anchor:** `src/conversation/orchestrator.ts:2090` — `const clearTurnWatchdog = (): void => {`

### watchdog-rearmed-per-tag-on-resume
**`runtime-guard`** — on quota resume the watchdog is re-armed per awaited tag (summary→path, parent-review→parentPath, intent→[]).

**Prevents:** a silently-stuck resumed turn hanging the run with no terminal

**Anchor:** `src/conversation/orchestrator.ts:2347` — `const rearmed = pause.awaitingVariant;`

### sizer-two-outcome
**`runtime-guard`** — the sizer decision is exactly single|split; an unparseable decision is coerced to split (loud) and the trailing assertNever(sizer.decision) guards totality.

**Prevents:** an ambiguous/garbled sizer output advancing into an undefined branch

**Anchor:** `src/conversation/orchestrator.ts:2643` — `case "sizer": {`

### ingest-queue-serialized-and-poison-proof
**`runtime-guard`** — frames process one-at-a-time through this promise chain; a throw drives a loud FATAL but the `.catch` leaves the tail resolved so later frames still run.

**Prevents:** a single throwing frame stalling the run silently / poisoning the chain

**Anchor:** `src/conversation/orchestrator.ts:3553` — `const enqueueIngest = (work: () => Promise<void>): Promise<void> => {`

### start-is-idempotent
**`runtime-guard`** — a second start() while active is a no-op returning false.

**Prevents:** a dead start closing the composer modal / running the onStarted chain

**Anchor:** `src/conversation/orchestrator.ts:3597` — `if (active) return false;`

### arm-before-send
**`convention`** — the next awaiting variant is armed before deps.sendMessage, because the turn's result can reach ingest before the send resolves.

**Prevents:** a result landing while awaiting is idle and being swallowed (the run halting at the opening phase)

**Anchor:** `src/conversation/orchestrator.ts:3656` — `run.awaiting = { tag: "intent", buffer: "" };`

### prototype-round-driver-owned-monotonic
**`runtime-guard`** — prototypeRound counts completed refine requests, incremented ONLY here, reset ONLY via freshRunState; the gate mints round+1.

**Prevents:** a clarifier-supplied round count gaming the loop-escape threshold

**Anchor:** `src/conversation/orchestrator.ts:4031` — `run.prototypeRound++;`

### quota-paused-single-probe
**`runtime-guard`** — 'are we quota-paused?' has one answer — quotaPause!==null || quotaPausePending; both agent-exit listeners read it.

**Prevents:** a same-tick agent-exit classified as end-of-run instead of a pause

**Anchor:** `src/conversation/orchestrator.ts:4178` — `quotaPaused: () => run.quotaPause !== null || run.quotaPausePending,`

### node-state-stage-phase-coupling
**`type-level`** — a node's state is a tagged union on stage (open|leaf|split), each stage permitting only its own phases and co-locating only its own fields (children only on split, artifact paths only on leaf/split).

**Prevents:** impossible stage/phase combos and reading a field that doesn't exist for the current stage

**Anchor:** `src/conversation/plan-tree.ts:217` — `export type NodeState =`

### write-policy-is-derived-not-stored
**`convention`** — write policy is one of plan|acceptEdits|prototype, computed purely from the tree by this projection and never persisted as a mutable ledger flag (RunState.assertedPolicy is only a re-derivable cache).

**Prevents:** a write policy disagreeing with the tree's actual phase

**Anchor:** `src/conversation/plan-tree.ts:493` — `export function writePolicyFor2(root: TreeNode): WritePolicy {`

### statuslabel-total-over-toolstatus
**`runtime-guard`** — statusLabel returns a distinct label for every ToolStatus incl. interrupted.

**Prevents:** an interrupted tool mislabeled 'done'/rendered pulsing

**Anchor:** `src/conversation/render.ts:129` — `function statusLabel(status: ToolStatus): string {`

### tool-status-four-state
**`type-level`** — a tool-call row's status is exactly running|done|error|interrupted.

**Prevents:** a tool abandoned at turn-end stuck visibly 'running' forever

**Anchor:** `src/conversation/stream.ts:32` — `export type ToolStatus = "running" | "done" | "error" | "interrupted";`

### segment-arrival-monotonic
**`runtime-guard`** — each event gets a session-segment number in arrival order; each subsequent system_init opens the next segment.

**Prevents:** seq-order scrambling across a resume (which resets the wire seq)

**Anchor:** `src/conversation/stream.ts:498` — `const segmentOf = new Map<ModelEvent, number>();`

### turn-end-demotion-segment-and-seq-scoped
**`reducer-total`** — a still-running tool is demoted to interrupted iff a turn-terminal frame is causally after it, compared (segment,seq) lexicographically.

**Prevents:** a running turn-N tool flipped by an earlier turn's terminal, or a resumed-session tool flipped by the prior session's synthetic exit

**Anchor:** `src/conversation/stream.ts:833` — `for (const tool of toolById.values()) {`

## App shell — selection / review / gates

### action-in-flight-tristate
**`type-level`** — at most one review action dispatches at a time — identity is the single union none | submit | approve, not two booleans.

**Prevents:** the "submit AND approve both in flight" state

**Anchor:** `src/main.ts:134` — `type ActionInFlight = "none" | "submit" | "approve";`

### selection-single-truth
**`type-level`** — the reading-pane target is exactly one closed-union variant — none | plan | sentinel | placeholder.

**Prevents:** independent openPath/placeholder/sentinel flags drifting into a contradictory double-active state

**Anchor:** `src/main.ts:251` — `type Selection =`

### openpath-is-derived-never-assigned
**`type-level`** — openPath is a pure function over `selection` (no backing field) — recomputed each call, never a stored lvalue writers can set.

**Prevents:** a stored openPath desyncing from the active selection

**Anchor:** `src/main.ts:265` — `function openPath(): AbsPath | null {`

### placeholder-selected-folded-into-selection
**`type-level`** — the placeholder is "selected" iff `selection.k === "placeholder"` for the current run — read off the union, with no parallel boolean.

**Prevents:** a "placeholder selected AND a real plan open" double-active state

**Anchor:** `src/main.ts:363` — `function placeholderSelected(): boolean {`

### pending-surface-union
**`convention`** — every "thing awaiting the user" is one typed PendingSurface from this single builder, which both the SUMMARY count and the Resume target consult.

**Prevents:** the count and the resume button computing "what's pending" from divergent paths

**Anchor:** `src/main.ts:464` — `function pendingSurfaces(): PendingSurface[] {`

### pending-count-equals-surfaces-length-at-the-bar-site
**`convention`** — the SUMMARY count is pendingSurfaces().length — the same builder the Resume picker consults.

**Prevents:** the count double-counting or omitting a gate surface

**Anchor:** `src/main.ts:768` — `pendingCount: pendingSurfaces().length,`

### approve-never-drives-the-submitting-visual-lock
**`convention`** — only "submit" maps into the bar's visual "submitting" lock; an in-flight "approve" gates dispatch but feeds no bar change.

**Prevents:** an in-flight approve spuriously flipping the bar into "Submitting…"

**Anchor:** `src/main.ts:780` — `submitInFlight: actionInFlight === "submit",`

### surface-removal-unsuppresses-resume
**`convention`** — each site that removes a pending surface re-derives both affordances via refreshAffordances().

**Prevents:** an out-of-band cancel leaving the resume banner stuck hidden

**Anchor:** `src/main.ts:1091` — `refreshAffordances();`

### affordance-union
**`precedence`** — at most one reading-pane affordance is active, chosen by first-match over the total order prototype > acceptance > review > resume > none.

**Prevents:** two affordances painted into the bar at once

**Anchor:** `src/main.ts:1666` — `export function computeAffordance(signals: {`

### reading-pane-affordance-precedence
**`precedence`** — the resume banner is (re-)derived only when computeAffordance reports no higher affordance occupies the bar.

**Prevents:** the resume banner showing beneath a held review / gate

**Anchor:** `src/main.ts:1689` — `function refreshAffordances(): void {`

### selection-collapse-only-on-genuine-vanish
**`runtime-guard`** — a `plan` selection collapses to none only when it was in the prior list AND is absent from the new one.

**Prevents:** blanking a freshly-opened / not-yet-indexed plan that was simply never listed

**Anchor:** `src/main.ts:2170` — `function resolveSelection(`

### held-gate-plan-exempt-from-collapse
**`runtime-guard`** — the held orchestrator gate's plan is returned unchanged even if its row drops from list_plans mid-hold.

**Prevents:** a churning gate row collapsing the selection and vanishing the in-process Approve bar

**Anchor:** `src/main.ts:2179` — `if (heldGatePlan !== null && prev.path === heldGatePlan) return prev;`

### list-refresh-no-fetching-flash
**`runtime-guard`** — only the INITIAL load (listState `initial`) transitions to `fetching`; an in-place refresh of an already-loaded list leaves the rendered list untouched while the next read is in flight.

**Prevents:** a watcher tick blanking a populated sidebar to the empty `fetching` render mid-fetch.

**Anchor:** `src/main.ts:2197` — `if (isInitial(listState)) {`

**Tests:** `list-refresh-never-renders-fetching-in-place`

### transient-list-failure-is-a-noop
**`runtime-guard`** — a failed list_plans returns early, leaving listState/selection/pane untouched.

**Prevents:** a transient IPC failure collapsing the open plan (empty list → resolveSelection "vanish" → blanked pane)

**Anchor:** `src/main.ts:2220` — `console.error("list_plans failed — leaving the sidebar/selection intact", e);`

### selection-set-synchronously-before-await-in-openPlan
**`runtime-guard`** — openPlan assigns `selection` synchronously at the top, before any await, so openPath() reflects the new target throughout.

**Prevents:** a post-await derivation reading a stale selection mid-open

**Anchor:** `src/main.ts:2563` — `selection = isResumeSentinel(path)`

### popover-draft-discarded-on-plan-switch-preserved-on-reopen
**`runtime-guard`** — invalidatePopover compares the draft's planPath against the just-set openPath() — a genuine switch discards the draft, a same-plan reopen re-anchors it.

**Prevents:** a cross-plan draft surviving a switch and re-anchoring against the wrong document

**Anchor:** `src/main.ts:2721` — `invalidatePopover(readingPaneEl);`

### render-generation-guard-cancels-superseded-settles
**`runtime-guard`** — settle is handed `() => renderGuard.isCurrent(gen)`, so a superseded render's settle is cancelled the moment a newer render takes the generation.

**Prevents:** a late settle from a stale render mutating the pane after a newer plan opened

**Anchor:** `src/main.ts:2725` — `await settle(readingPaneEl, undefined, () => renderGuard.isCurrent(gen));`

### openGatePlanFile-shared-by-both-gate-paths
**`convention`** — the gate observer and the Resume path both re-open a held gate's plan through this one sequence.

**Prevents:** the two gate-open paths diverging

**Anchor:** `src/main.ts:2918` — `async function openGatePlanFile(planPath: string): Promise<void> {`

### gate-preferred-over-newer-external-review
**`precedence`** — a held orchestrator gate is found first among the pending surfaces, so Resume re-opens it regardless of a newer external review.

**Prevents:** a newer external review opening instead of the live held gate

**Anchor:** `src/main.ts:2939` — `const gateSurface = surfaces.find((s) => s.kind === "orchestrator-gate");`

### sentinel-touches-no-file-io
**`runtime-guard`** — a synthetic resume sentinel is guarded out of every file-backed IPC (set_open_plan / mark_viewed) in this handler.

**Prevents:** backend rejections / "reload failed" logs for a row with no real file

**Anchor:** `src/main.ts:2957` — `const op = openPath();`

### open-plan-stamped-viewed-before-relist
**`runtime-guard`** — when the open plan is the changed file, markViewed runs before refreshList / list_plans.

**Prevents:** the sidebar momentarily bolding the plan the user is actively watching

**Anchor:** `src/main.ts:2971` — `if (op !== null && changedPath === op && !isResumeSentinel(op)) {`

### reload-target-re-read-after-relist
**`runtime-guard`** — the reload target is re-read from openPath() AFTER refreshList, so a collapsed selection yields nothing to reload.

**Prevents:** a reload firing against a path the same refresh just collapsed

**Anchor:** `src/main.ts:2981` — `const opAfter = openPath();`

### exactly-once-action-dispatch
**`runtime-guard`** — the top-of-handler early-return bails whenever a sibling action is already dispatching, before any branch runs.

**Prevents:** a fast double-click on Submit/Approve, or a cross-click, starting a second dispatch

**Anchor:** `src/main.ts:3422` — `if (actionInFlight !== "none") return;`

### lock-set-after-guard-before-await
**`runtime-guard`** — the lock is taken only after this branch's validation guard has passed, and before the branch's first await.

**Prevents:** a guard-rejected click sticking the lock and freezing the bar

**Anchor:** `src/main.ts:3435` — `actionInFlight = "submit"; // lock BEFORE the first await; reset in finally on EVERY exit.`

### lock-reset-on-every-exit
**`runtime-guard`** — the finally returns actionInFlight to "none" on every exit path once a dispatched round-trip settles.

**Prevents:** a failed dispatch leaving the lock stuck and permanently blocking actions

**Anchor:** `src/main.ts:3463` — `actionInFlight = "none";`

### prototype-loop-always-has-an-escape
**`runtime-guard`** — from round >= PROTOTYPE_MAX_ROUNDS the approve affordance relabels to "Proceed as-is", guaranteeing a loop exit.

**Prevents:** an unbounded refine loop with no as-is exit

**Anchor:** `src/prototype.ts:95` — `return round >= PROTOTYPE_MAX_ROUNDS ? "Proceed as-is" : "Approve visual";`

### gate-self-clears-from-snapshot
**`convention`** — the prototype/acceptance bar modes derive strictly from the orchestrator snapshot (never module state), so nulling the gate in the reducer reverts the bar on the next onSnapshot.

**Prevents:** a stale held-gate flag keeping the bar in PROTOTYPE/ACCEPTANCE after the gate resolved

**Anchor:** `src/prototype.ts:108` — `export function prototypeGateActive(`

### approval-gate-beats-prototype-gate
**`precedence`** — a held pendingApproval short-circuits to null, suppressing the prototype-mode bar.

**Prevents:** a prototype gate and an approval gate both driving the bar

**Anchor:** `src/prototype.ts:115` — `if (snap.pendingApproval != null) return null; // approval gate takes precedence`

### approval-and-prototype-beat-acceptance
**`precedence`** — both a held pendingApproval and a held pendingPrototype short-circuit to null, outranking the forced-acceptance gate.

**Prevents:** the post-completion acceptance bar co-existing with a mid-run hold

**Anchor:** `src/prototype.ts:151` — `if (snap.pendingApproval != null) return null; // approval gate takes precedence`

### acceptance-refine-targets-from-root-children
**`runtime-guard`** — refine targets are the root's direct children only, and [] unless the root is split — empty for a single-leaf run.

**Prevents:** offering refine targets that don't exist on a leaf-only tree

**Anchor:** `src/prototype.ts:189` — `if (root.state.stage !== "split") return [];`

### review-bar-mode-union
**`type-level`** — the bar's mode is exactly one of hidden | viewing | summary | submitting (a single union field).

**Prevents:** incoherent combos like "submitting while not viewing" being representable (submitting is nested under viewing in the derivation below)

**Anchor:** `src/review.ts:28` — `mode: "viewing" | "summary" | "hidden" | "submitting";`

### pendingcount-zero-fully-hidden
**`runtime-guard`** — pendingCount === 0 returns the fully-hidden state regardless of viewing / submitInFlight.

**Prevents:** a bar showing with nothing pending

**Anchor:** `src/review.ts:77` — `if (input.pendingCount === 0) {`

### submitInFlight-meaningful-only-while-viewing
**`runtime-guard`** — the submitInFlight → "submitting" refinement is checked only inside this VIEWING branch.

**Prevents:** a leaked in-flight flag forcing "submitting" while the bar should be hidden / summary

**Anchor:** `src/review.ts:92` — `if (input.viewing) {`

### submit-disabled-at-zero-comments
**`runtime-guard`** — in VIEWING, Submit is visible but disabled until there is >=1 comment.

**Prevents:** an empty-feedback deny

**Anchor:** `src/review.ts:118` — `submitDisabled: n === 0,`

### approve-is-a-viewing-only-in-process-affordance
**`runtime-guard`** — Approve & Build is visible only while VIEWING an in-process review/gate (approveVisible === inProcess inside the viewing branch).

**Prevents:** an Approve & Build button where there is no held in-process seam

**Anchor:** `src/review.ts:125` — `approveVisible: inProcess,`

## Sidecar / agent-driver

### cli-plan-redirect-relative-contained
**`convention`** — plansDirectory is always a non-empty relative path under .plan-tree/cli-plans with no `..`.

**Prevents:** an empty value resurrecting duplicate top-level rows, or an absolute path the CLI rejects.

**Anchor:** `sidecar/cli-plans.ts:22` — `export const CLI_PLANS_SUBDIR = ".plan-tree/cli-plans";`

### env-override-whitelist-or-no-op
**`runtime-guard`** — AGENT_EFFORT overrides only for a valid SDK level and AGENT_MODEL only when non-empty; invalid values produce no override.

**Prevents:** a typo'd effort/empty model failing the whole session.

**Anchor:** `sidecar/env-overrides.ts:32` — `export function optionOverridesFromEnv(`

### plan-bash-write-blocklist-preserves-tests
**`runtime-guard`** — under plan, write-shaped Bash is denied while read-only test runs stay allowed (best-effort blocklist, NOT a sandbox).

**Prevents:** echo>file / rm / sed -i / git mutating the tree during planning.

**Anchor:** `sidecar/permissions.ts:103` — `export const BASH_WRITE_DENY_PATTERNS: ReadonlyArray<RegExp> = [`

### dual-tier-no-drift
**`runtime-guard`** — the PreToolUse hook and the canUseTool gate apply the same prototype/plan decision via one shared bashDecisionFor.

**Prevents:** a Bash/path allowed at one tier but denied at the other.

**Anchor:** `sidecar/permissions.ts:261` — `export function bashDecisionFor(policy: HostPolicy, command: unknown): string | null {`

### prototype-bash-failclosed-allowlist
**`runtime-guard`** — under prototype, Bash runs only when every segment is provably read-only and there's no command/process substitution; unrecognized denies.

**Prevents:** an obfuscated Bash command writing during the prototype phase.

**Anchor:** `sidecar/permissions.ts:271` — `if (typeof command !== "string" || command.trim().length === 0) {`

### hostpolicy-failclosed-mapping
**`runtime-guard`** — only acceptEdits and prototype widen the host policy; every other value (incl. malformed) maps to plan — via the function's final default branch (`return "plan"`), not the type.

**Prevents:** an unknown/spoofed wire mode disabling write protection.

**Anchor:** `sidecar/permissions.ts:307` — `export function hostPolicyForMode(mode: unknown): HostPolicy {`

### sdk-never-receives-host-only-prototype
**`type-level`** — the SDK is only ever handed plan|acceptEdits|default; host-only prototype maps to default.

**Prevents:** passing 'prototype' to the SDK (not in its union) or using SDK plan mode (which hard-blocks Write).

**Anchor:** `sidecar/permissions.ts:321` — `export function sdkPermissionMode(mode: unknown): "plan" | "acceptEdits" | "default" {`

### prototype-write-containment
**`containment`** — under prototype policy a mutating tool is allowed only when its target resolves strictly under <cwd>/.plan-tree/prototype/.

**Prevents:** a prototype-phase agent writing outside the scratch dir.

**Anchor:** `sidecar/permissions.ts:346` — `export function isPrototypeWritePath(cwd: string, filePath: unknown): boolean {`

### prototype-traversal-rejection
**`containment`** — any `..` segment rejects the write — checked on raw input and resolved segments; `..` is never collapsed.

**Prevents:** path-traversal laundering escaping containment.

**Anchor:** `sidecar/permissions.ts:352` — `if (filePath.split("/").includes("..")) return false;`

### prototype-strict-subpath-no-prefix-sibling
**`containment`** — the resolved path must be strictly longer than the prototype root and match segment-for-segment.

**Prevents:** a .plan-tree/prototype-evil/ sibling passing a string-prefix check.

**Anchor:** `sidecar/permissions.ts:362` — `if (resolved.length <= root.length) return false;`

### pretooluse-precedes-allow-rules
**`containment`** — prototype containment is enforced at the PreToolUse hook tier, which precedes SDK allow-rules.

**Prevents:** a user permissions.allow rule bypassing containment in default mode.

**Anchor:** `sidecar/permissions.ts:416` — `export function createPrototypePreToolUseHook(`

### interactive-hold-serialization
**`runtime-guard`** — at most one interactive hold (ExitPlanMode/AskUserQuestion) is live; a second is denied immediately.

**Prevents:** two concurrent approval cards colliding so a hold resolves against the wrong tool-use id.

**Anchor:** `sidecar/permissions.ts:462` — `export function shouldDenyConcurrentInteractive(`

### allow-result-carries-updatedinput
**`convention`** — allowResult is the sole 'allow' constructor and always sets updatedInput.

**Prevents:** a bare {behavior:'allow'} failing the SDK's runtime validator.

**Anchor:** `sidecar/permissions.ts:476` — `export function allowResult(input: Record<string, unknown>): PermissionResult {`

### plan-policy-mutating-deny
**`runtime-guard`** — while host policy is plan, the four mutating tools are denied in-process regardless of the SDK's believed mode.

**Prevents:** writes sailing through after the SDK self-flips out of plan on ExitPlanMode approval.

**Anchor:** `sidecar/permissions.ts:565` — `if (MUTATING_TOOLS.has(toolName) && getHostPolicy() === "plan") {`

### null-cwd-fails-closed
**`runtime-guard`** — a null/empty session cwd denies all mutating tools under prototype policy.

**Prevents:** an unset cwd silently widening writes to the whole filesystem.

**Anchor:** `sidecar/permissions.ts:578` — `if (cwd === null || !isPrototypeWritePath(cwd, target)) {`

### quota-epoch-ms-canonical
**`runtime-guard`** — every reset time is epoch-ms (seconds-vs-ms disambiguated at the 1e12 boundary).

**Prevents:** a seconds-epoch treated as ms (a pause ending ~1000x too early/late).

**Anchor:** `sidecar/quota.ts:26` — `function toEpochMs(value: unknown): number | null {`

### rate-limit-pause-only-on-rejected
**`runtime-guard`** — a rate_limit_event pauses the session only when status==='rejected'.

**Prevents:** a non-blocking warning limit pausing a live session.

**Anchor:** `sidecar/quota.ts:51` — `if (r.status !== "rejected") return null;`

### quota-auth-never-classified-as-quota
**`runtime-guard`** — auth/credential errors are never parsed as a quota reset (the auth guard returns null first).

**Prevents:** an expired token paused-and-retried forever instead of surfacing as fatal auth.

**Anchor:** `sidecar/quota.ts:92` — `if (AUTH_RE.test(text)) return null;`

### quota-uncertainty-degrades-exhausted-never-early
**`runtime-guard`** — any uncertainty returns null/sentinel-0 and the resolver biases later, never earlier.

**Prevents:** a wrong-early resume time that resumes straight back into the wall.

**Anchor:** `sidecar/quota.ts:203` — `export function parseClockTimeInTz(text: unknown, nowMs: number = Date.now()): number | null {`

### setpermissionmode-gated-to-live
**`type-level`** — `q` exists only on the live Session variant, so setPermissionMode is unreachable on idle/dead/draining at compile time.

**Prevents:** a setPermissionMode dereferencing `q` on a statically non-live session.

**Anchor:** `sidecar/session-command.ts:28` — `export type Session =`

### decidesessioncommand-purity
**`convention`** — decideSessionCommand never calls q.setPermissionMode; index.ts owns the sole SDK call site.

**Prevents:** a hidden SDK side-effect double-firing the mode flip.

**Anchor:** `sidecar/session-command.ts:53` — `export function decideSessionCommand(`

### one-session-per-process
**`type-level`** — a second start in the same process is a fatal protocol rejection that exits non-zero.

**Prevents:** a dropped second start leaving the old Query/conversation alive so new messages get absorbed.

**Anchor:** `sidecar/session-start.ts:27` — `export type StartDecision =`

### fresh-start-reasserts-hostpolicy
**`runtime-guard`** — a fresh start re-derives hostPolicy from that command's own permissionMode (fail-closed plan).

**Prevents:** a stale widened policy leaking into a new session.

**Anchor:** `sidecar/session-start.ts:38` — `export function decideStart(alreadyStarted: boolean, permissionMode: unknown): StartDecision {`

## Other

### remote-data-exhaustive-five-state
**`type-level`** — folding a RemoteData via match() (all five states) or matchScalar() (the four reachable states) is exhaustive — the cases object requires every handler key, so a missing case is a compile error and each fold ends in assertNever; matchScalar accepts only ScalarRemoteData (zeroResults excluded by type), so a possibly-empty source cannot bypass the empty state.

**Prevents:** a consumer routed through match()/matchScalar() silently ignoring the loading/empty/error states — stale data mid-fetch or a missing empty-state UI — and a collection read mis-routed through the scalar fold turning a legitimate empty result into a false error. (It does NOT prevent swallowed errors at leaf reads: unwrapOr is the sanctioned escape hatch that deliberately collapses error→fallback.)

**Anchor:** `src/remote-data.ts:10` — `export type RemoteData<T> =`

## §Rust backend (`src-tauri/`)

NOT YET AUDITED — this branch did not touch it; tracked as a follow-up.
(Static placeholder — the generator does not scan this tree.)

## §Mock harness (`src/mock/`)

NOT YET AUDITED — this branch did not touch it; tracked as a follow-up.
(Static placeholder — the generator does not scan this tree.)
