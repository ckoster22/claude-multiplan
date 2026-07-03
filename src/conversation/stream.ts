// Conversation domain — PURE in-memory stream model.
//
// Consumes the committed agent-stream vocabulary (types.ts) and produces a normalized,
// renderable tree. NO DOM. Responsibilities:
//   - order strictly by `seq`;
//   - correlate tool_use.id -> tool_result.tool_use_id (status running -> done/error);
//   - group subagent sub-streams keyed by the frozen `parent_tool_use_id` (= the parent
//     tool_use's id, which the SDK reuses as the subagent's agent_id) — NO name label
//     (none is frozen; the visible name is deferred to live smoke);
//   - track `permission_mode` for the mode chip;
//   - record a tool-permission-requested marker, permission_denied rows, errors, exit;
//   - mark the run complete on `result`.
//
// The model is rebuilt from scratch on every event apply (events are accumulated and the
// derived tree recomputed) so ordering-by-seq and late-arriving correlations are always
// consistent regardless of wire arrival order.

import type {
  AgentStream,
  ToolPermissionRequested,
  AgentError,
  AgentExit,
  AskUserQuestionItem,
  AskUserQuestionAnswers,
} from "./types";

// A tool-call row's lifecycle status. "running" until its tool_result correlates (→ "done"/"error");
// "interrupted" when the turn ended (result/exit) while it was still running and no result ever landed
// — so its row stops pulsing instead of spinning forever (see the turn-end demotion in derive()).
// INVARIANT[tool-status-four-state] (type-level): a tool-call row's status is exactly running|done|error|interrupted.
//   prevents: a tool abandoned at turn-end stuck visibly 'running' forever
export type ToolStatus = "running" | "done" | "error" | "interrupted";

// A rendered tool-call row (a tool_use, possibly correlated with its tool_result).
export interface ToolNode {
  type: "tool";
  seq: number;
  segment?: number;
  id: string;
  tool: string;
  input: unknown;
  status: ToolStatus;
  // The correlated tool_result content + error flag, once it lands (else null/running).
  result: unknown | null;
  isError: boolean;
}

// An assistant-text bubble. A streamed block carries `blockUid` — the session-unique correlation id
// shared by its `assistant_text_delta` chunks and the terminal `assistant_text` — so the reducer keys
// ONE growing node across every delta and the commit (see nodeKey); `live` is true while deltas
// accumulate, false once the terminal block finalizes it. A non-streamed block omits both, keeping
// the fresh-node-per-frame path.
export interface TextNode {
  type: "text";
  seq: number;
  segment?: number;
  text: string;
  blockUid?: string;
  live?: boolean;
}

// A user-attributed bubble: the verbatim text the user typed/submitted (free-text message, prototype
// refine feedback, or plan-review comments). Echoed into the stream AFTER a successful dispatch so the
// user's own words are visible in the conversation (they were previously wrapped into a system prompt
// and never shown). Placed at `lastWireSeq + 0.5` (a fractional tiebreaker — see appendUserMessage) so
// it sorts after every frame seen so far but strictly BEFORE the agent's reply (the next wire frame).
export interface UserMessageNode {
  type: "user";
  seq: number;
  segment?: number;
  text: string;
  // Multimodal: DISPLAY data URLs (`data:<media_type>;base64,<data>`) for images the user attached to
  // this message, in attach order. Rendered as a thumbnail row ABOVE the text in the user bubble.
  // OPTIONAL + OMITTED when the message carried no images (a text-only send is byte-identical to today).
  images?: string[];
}

// A de-emphasized SYSTEM bubble: a harness-injected role:"user" transcript record that the human
// did NOT type — a plumbing turn (subagent task-notification, command stdout/stderr, bash I/O,
// system reminder). Held verbatim (raw XML/plaintext) and rendered DIM + left-aligned, visually
// distinct from both the orange user bubble and the grey assistant bubble. NEVER markdown-rendered.
export interface SystemMessageNode {
  type: "system";
  seq: number;
  segment?: number;
  text: string;
}

// A Plan->Build (or any) mode-change chip.
export interface ModeNode {
  type: "mode";
  seq: number;
  segment?: number;
  mode: string;
}

// The "awaiting review" marker for a tool-permission-requested event.
export interface PermissionRequestNode {
  type: "permission_request";
  seq: number;
  segment?: number;
  id: string;
  tool: string;
  agentId: string | null;
}

// An interactive AskUserQuestion request derived from a tool-permission-requested event whose tool
// is "AskUserQuestion". While unanswered it carries the questions so the renderer can draw the input
// card (radios/checkboxes + Submit) and the controller can resolve it. Once answered (the controller
// appends a question_answered event), `answers` is set: the renderer drops the form and shows the
// chosen answers as a record. The hold lives in the sidecar; this node is the host-side affordance.
export interface QuestionRequestNode {
  type: "question_request";
  seq: number;
  segment?: number;
  // The SDK toolUseID — what the controller round-trips via resolve_tool_permission.
  id: string;
  questions: AskUserQuestionItem[];
  // null while pending (render the form); set once the user submitted (render the chosen answers).
  answers: AskUserQuestionAnswers | null;
}

// A visible permission_denied row (a tool decided OUTSIDE the canUseTool seam).
export interface PermissionDeniedNode {
  type: "permission_denied";
  seq: number;
  segment?: number;
  tool: string;
  toolUseId: string;
  reasonType: string;
  message: string;
}

// The terminal result row.
export interface ResultNode {
  type: "result";
  seq: number;
  segment?: number;
  isError: boolean;
  result: string;
  // The SDK result subtype (e.g. "success" | "error_during_execution") — RECORD ONLY, never keyed
  // on for rendering (error_during_execution also covers genuine mid-run failures).
  subtype: string;
  // True when the controller tagged the stored frame as a deliberate orchestrator interrupt (the
  // post-decomposition-approval boundary). Read from the STORED frame field — never from live
  // orchestrator state, which de-arms `resuming` before later rebuilds. The render branch keys
  // EXCLUSIVELY on this flag.
  deliberateInterrupt: boolean;
}

// An error row (fatal or diagnostic).
export interface ErrorNode {
  type: "error";
  seq: number;
  segment?: number;
  errorKind: AgentError["kind"];
  message: string;
  fatal: boolean;
}

// An exit row.
export interface ExitNode {
  type: "exit";
  seq: number;
  segment?: number;
  code: number;
}

// A plain, non-error notice row (an informational orchestrator message). Carries
// NO error semantics — it never flips session state, never renders an "Error:" prefix or error face.
export interface NoticeNode {
  type: "notice";
  seq: number;
  segment?: number;
  message: string;
}

// A quota auto-resume banner row — a PURE render node owned by the orchestrator observer wiring (NOT
// the agent-stream reducer; the `quota_exceeded` frame stays inert). It NEVER flips session/complete
// state. There is at most ONE in the tree at a time: a second pause UPDATES the single node in place
// (state waiting -> exhausted) rather than appending a duplicate (the model keys it as a singleton).
//   - "waiting":   the session paused mid-turn, auto-resume is armed; the renderer draws a live
//                  wall-clock countdown to `resetAt` and the "auto-resume armed · N left" pill. NO
//                  Resume button (resuming before the quota refreshes is impossible).
//   - "exhausted": the once-per-session auto-resume budget was already spent; the renderer draws the
//                  next reset time + a Cancel-session affordance ONLY (no countdown, no auto-resume).
// `resetAt` is epoch-MILLISECONDS (already normalized by the orchestrator — never re-scaled here).
// `remaining` is the auto-resume attempts left (only meaningful for "waiting"; 0 for "exhausted").
export interface QuotaBannerNode {
  type: "quota-banner";
  seq: number;
  segment?: number;
  state: "waiting" | "exhausted";
  resetAt: number;
  remaining: number;
  source: string;
  // DEMO-ONLY override (mock-animate scrubbable countdown): when present the WAITING banner renders
  // this static remaining-ms instead of arming a live wall-clock countdown, so the value is a pure
  // function of scrub-time T. Production NEVER sets it — the live wall-clock path is unchanged.
  frozenRemainingMs?: number;
}

// A subagent group: an accent-bordered container keyed by agent_id, holding nested nodes.
// When a `subagent_started` frame is seen for this group's id, its identity + task are attached so
// the renderer draws a labeled header ("Subagent · {subagentType} — {description}"); absent that
// frame (older sidecar) these stay null and the renderer falls back to the anonymous box.
export interface SubagentGroupNode {
  type: "subagent";
  // The earliest seq among the group's children (so the group sorts into the timeline). When the
  // group was seeded by a `subagent_started` frame BEFORE any child, this is that frame's seq so the
  // group appears immediately at the point the subagent started.
  seq: number;
  agentId: string;
  // Subagent identity + task from the `subagent_started` frame (null until/unless it arrives).
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
  children: RenderNode[];
}

// Every render node carries an optional `segment`: the arrival-order session segment it was derived
// in (0 for the first session, bumped on each resume's fresh system_init — see the segment counting in
// replayAll/derive). It is the DOM-key qualifier for `nodeKey`: a resume RESETS the wire seq to 0, so
// two same-type nodes at the same seq in different segments would otherwise collide on `${type}:${seq}`
// and the renderer would reuse the wrong element. Optional so hand-built node literals (tests, mock
// scenes) need not set it; derive() always stamps it.
//
// Any node that can appear at the top level of the timeline OR inside a subagent group.
// (A subagent group only appears at the top level.)
export type RenderNode =
  | ToolNode
  | TextNode
  | UserMessageNode
  | SystemMessageNode
  | ModeNode
  | PermissionRequestNode
  | QuestionRequestNode
  | PermissionDeniedNode
  | ResultNode
  | ErrorNode
  | ExitNode
  | NoticeNode
  | QuotaBannerNode;

export type TopNode = RenderNode | SubagentGroupNode;

// The single, in-place "working…" indicator state. Non-null while a turn is active (events have
// arrived but no `result`/`exit` yet); carries the latest `status` label, or a generic seed
// ("Working…") before any status frame arrives. The renderer shows ONE indicator from this (never
// appended per-event); null hides it. The controller may additionally force it null when the session
// is not actively generating (e.g. after Pause), so the indicator never lingers.
export interface WorkingState {
  label: string;
}

// The full derived, renderable tree.
export interface RenderTree {
  // Top-level nodes in `seq` order (subagent groups interleaved at their earliest child seq).
  nodes: TopNode[];
  // The current permission mode (last mode_change / system_init), or null if never set.
  permissionMode: string | null;
  // True once a `result` frame has landed.
  complete: boolean;
  // The live "working…" indicator, or null when no turn is active (idle / complete / exited).
  working: WorkingState | null;
}

// The generic label shown the instant a turn starts, before any `status` frame arrives.
export const WORKING_SEED_LABEL = "Working…";

// Shown INSTEAD of the latest status label while the agent is blocked on the user — a held
// interactive permission (AskUserQuestion answers / ExitPlanMode plan review). While a canUseTool
// hold is pending the SDK emits no further frames, so without this override the indicator would
// show a stale "thinking…" forever.
export const WAITING_INPUT_LABEL = "Waiting for your input…";

// Every event this model accepts. agent-error / agent-exit / tool-permission-requested are
// tagged so they can share one accumulation list with the agent-stream union. We give them
// synthetic seqs at append time (they carry their own seq for the first two; agent-error /
// agent-exit do NOT carry a seq on the wire, so the controller assigns a monotonic one).
export type ModelEvent =
  | AgentStream
  | ToolPermissionRequested
  | ({ __event: "error"; seq: number } & AgentError)
  | ({ __event: "exit"; seq: number } & AgentExit)
  | { __event: "notice"; seq: number; message: string }
  | {
      // A verbatim user-message echo, appended AFTER a user-submitted feedback/message dispatch
      // SUCCEEDS. `seq` is `lastWireSeq + 0.5` (assigned inside appendUserMessage, NOT controller-
      // assigned) so it sorts after every frame seen so far but strictly before the agent's reply (the
      // next wire frame). On derive it produces a standalone UserMessageNode.
      __event: "user_message";
      seq: number;
      text: string;
      // Multimodal: DISPLAY data URLs of images attached to this message (attach order). OMITTED when
      // the message had no images, so a text-only echo carries no images key.
      images?: string[];
    }
  | {
      // A verbatim SYSTEM-message echo (history-replay only): a harness-injected role:"user" plumbing
      // record that the human did not type. Carries its TRUE file-position seq (like user_message in
      // replay). On derive it produces a standalone SystemMessageNode (dim bubble).
      __event: "system_message";
      seq: number;
      text: string;
    }
  | {
      // A synthetic "the user submitted answers for this AskUserQuestion request" marker, appended by
      // the controller after a successful resolve_tool_permission. It carries no wire seq; the
      // controller assigns one (its `seq` only positions it in the ordering — the derive folds it onto
      // the matching question_request node by `id`, it never produces a standalone node).
      __event: "question_answered";
      seq: number;
      id: string;
      answers: AskUserQuestionAnswers;
    }
  | {
      // A synthetic "the held permission `id` was resolved (allow OR deny)" marker, appended from
      // the frontend resolve path (ExitPlanMode has no question_answered — its resolution is the
      // review Approve/Request-changes click). It clears the waiting-for-input override
      // DETERMINISTICALLY at resolve time instead of waiting for the next inbound frame. Produces
      // no timeline node; `seq` is controller-assigned, like question_answered.
      __event: "permission_resolved";
      seq: number;
      id: string;
    }
  | {
      // The quota-banner singleton. Appended/updated by the orchestrator observer wiring on
      // onQuotaPaused/onQuotaExhausted; cleared on onQuotaResumed. There is at most ONE in the event
      // list at a time — the model methods (appendQuotaBanner / updateQuotaBanner / clearQuotaBanner)
      // mutate THIS single accumulated event rather than pushing a second, so a pause-then-exhaust
      // transition updates the node in place and never duplicates. `state` "cleared" tombstones it so
      // a resumed banner produces NO node on derive (the singleton is logically removed). `seq` is
      // `lastWireSeq + 0.5` so the banner sorts after every frame seen so far (the paused turn's last
      // frame) but before the next wire frame (the resumed turn's reply). `resetAt` is epoch-ms.
      __event: "quota_banner";
      seq: number;
      state: "waiting" | "exhausted" | "cleared";
      resetAt: number;
      remaining: number;
      source: string;
      // DEMO-ONLY (mock-animate): a static remaining-ms override carried onto the derived node. See
      // QuotaBannerNode.frozenRemainingMs. Production never sets it.
      frozenRemainingMs?: number;
    };

// Subagent identity + task from a `subagent_started` frame, keyed by tool_use_id (= the group key =
// the children's parent_tool_use_id). Retained on the accumulator so a frame arriving BEFORE its
// children (seed an empty group) OR AFTER them (annotate an existing group) both resolve.
interface SubagentMeta {
  seq: number;
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
}

// A derived node plus the parent_tool_use_id it belongs under (null = top level). tool_results are
// NOT placed (they fold into their tool); every other event that produces a node yields one Placed.
interface Placed {
  node: RenderNode;
  parent: string | null;
}

// The full derivation state built by replayAll() from the event list. Holds both the correlation
// indices (so a later event can find the node an earlier one created) and the assembled, sorted
// top-level list. A from-scratch replay populates every field; an incremental step (later) mutates
// it in place. Kept as a plain record (not a class) so a fresh one is a cheap object literal.
interface DeriveAccum {
  // Tool rows by tool_use.id, and the session segment each was consumed in (id-keyed so a
  // correlation/demotion lookup needs only the id, never the node object).
  toolById: Map<string, ToolNode>;
  toolSegment: Map<string, number>;
  subagentMeta: Map<string, SubagentMeta>;
  // Submitted AskUserQuestion answers by request id, and the question nodes they fold onto.
  answersById: Map<string, AskUserQuestionAnswers>;
  questionNodesById: Map<string, QuestionRequestNode>;
  // The live streaming text node for each in-flight block, keyed by liveKey(segment, block_uid). The
  // first delta creates + emits the node; later deltas grow it; the terminal `assistant_text`
  // finalizes it and deletes the entry. The SEGMENT scope is load-bearing: a resume restarts the
  // sidecar's block_uid counter at 0, and the full replay consumes events in seq order (segments
  // interleave, since a resume resets the wire seq), so keying by block_uid ALONE would let a new
  // segment's block "0" cross-attach to an orphaned prior-segment node (a block interrupted before its
  // terminal). Mirrors nodeKey's own segment scoping.
  liveTextByUid: Map<string, TextNode>;
  // Subagent groups by agent_id (= parent_tool_use_id), and the assembled top-level list (sorted).
  groupsById: Map<string, SubagentGroupNode>;
  topNodes: TopNode[];
  // Scalars mirroring the working-indicator / completion derivation.
  permissionMode: string | null;
  complete: boolean;
  active: boolean;
  latestStatusLabel: string | null;
  exited: boolean;
  // The latest turn-terminal frame as a (segment, seq) pair — the turn-end demotion scope.
  lastTerminalSeg: number;
  lastTerminalSeq: number;
  // The latest UNRESOLVED interactive permission hold (agent blocked on the user), or null.
  pendingInteractiveId: string | null;
  // Ids of interactive holds that have been answered OR resolved. A request whose id is already here
  // never re-arms the hold — so the fast path (arrival order) matches the seq-order replay even when a
  // resolution's synthetic-seq event arrives BEFORE the wire request it resolves.
  resolvedInteractiveIds: Set<string>;
  // The current session segment + whether any system_init has been seen — the ARRIVAL-order segment
  // counter (bumped on each non-first system_init). Retained so the fast path continues stamping
  // segments where the last replay/apply left off (a full replay recomputes them and re-stores here).
  segment: number;
  seenSystemInit: boolean;
}

function emptyAccum(): DeriveAccum {
  return {
    toolById: new Map(),
    toolSegment: new Map(),
    subagentMeta: new Map(),
    answersById: new Map(),
    questionNodesById: new Map(),
    liveTextByUid: new Map(),
    groupsById: new Map(),
    topNodes: [],
    permissionMode: null,
    complete: false,
    active: false,
    latestStatusLabel: null,
    exited: false,
    lastTerminalSeg: -1,
    lastTerminalSeq: -Infinity,
    pendingInteractiveId: null,
    resolvedInteractiveIds: new Set(),
    segment: 0,
    seenSystemInit: false,
  };
}

// The working indicator: shown while active (and not exited), carrying the latest status label or
// the generic seed before any status frame arrives; an unresolved interactive hold OVERRIDES the
// label (the agent is blocked on the user, not "thinking…"). `exited` is belt-and-suspenders (active
// is already cleared on exit/result/fatal-error).
function deriveWorking(acc: DeriveAccum): WorkingState | null {
  if (!acc.active || acc.exited) return null;
  return {
    label:
      acc.pendingInteractiveId !== null
        ? WAITING_INPUT_LABEL
        : (acc.latestStatusLabel ?? WORKING_SEED_LABEL),
  };
}

// The pure model. Accumulates raw events; derives the tree on demand.
export class ConversationModel {
  private events: ModelEvent[] = [];
  // The highest WIRE seq observed so far (from real agent-stream / tool-permission-requested frames
  // — NOT the controller's 1e9-based synthSeq, which would poison the tiebreaker below). Used to
  // place an echoed user bubble at `lastWireSeq + 0.5`: AFTER every frame seen so far, but strictly
  // BEFORE the next wire frame (`lastWireSeq + 1`, the agent's reply to that message). Frozen into the
  // event at append time so the placement is stable across re-derives.
  private lastWireSeq = -1;

  // Count of live user echoes since `lastWireSeq` last advanced. Consecutive echoes with NO intervening
  // wire frame would otherwise all land at `lastWireSeq + 0.5` and thus share a `nodeKey` — the keyed
  // renderer maps them to one cache entry and drops all but one bubble. Reset whenever a wire frame
  // advances lastWireSeq (a fresh tiebreaker window); see appendUserMessage for the bisection scheme.
  private echoCount = 0;

  // The retained derivation state, carried across derive() calls so a derive amortizes to O(new
  // events). null until the first derive (or after reset()). `nextEventIndex` is how many events have
  // been folded into `acc`; `maxProcessedSeq` is the highest WIRE seq folded in (the fast-path
  // monotonic gate — synthetic seqs never raise it). `quotaDirty` forces a full replay because the
  // quota-banner singleton was mutated in place (no new event marks the change).
  private acc: DeriveAccum | null = null;
  private nextEventIndex = 0;
  private maxProcessedSeq = -Infinity;
  private quotaDirty = false;

  // Append a committed agent-stream frame.
  appendStream(ev: AgentStream): void {
    this.events.push(ev);
    if (ev.seq > this.lastWireSeq) {
      this.lastWireSeq = ev.seq;
      this.echoCount = 0; // a new wire frame opens a fresh echo-tiebreaker window
    }
  }

  // Append a tool-permission-requested marker.
  appendPermissionRequest(ev: ToolPermissionRequested): void {
    this.events.push(ev);
    if (ev.seq > this.lastWireSeq) {
      this.lastWireSeq = ev.seq;
      this.echoCount = 0; // a new wire frame opens a fresh echo-tiebreaker window
    }
  }

  // Append a normalized agent-error. `seq` is assigned by the controller (the wire shape
  // carries no seq) so errors interleave deterministically at their arrival point.
  appendError(ev: AgentError, seq: number): void {
    this.events.push({ __event: "error", seq, ...ev });
  }

  // Append an agent-exit. `seq` assigned by the controller.
  appendExit(ev: AgentExit, seq: number): void {
    this.events.push({ __event: "exit", seq, ...ev });
  }

  // Append a plain notice (non-error). `seq` assigned by the controller. Renders as a `.conv-notice`
  // row with the bare message — no error face, no session-state change.
  appendNotice(message: string, seq: number): void {
    this.events.push({ __event: "notice", seq, message });
  }

  // Echo a verbatim user message into the stream. The bubble is placed at `lastWireSeq + 0.5` — a
  // fractional tiebreaker that sorts it AFTER every frame seen so far but strictly BEFORE the agent's
  // reply (the next wire frame at `lastWireSeq + 1`). The seq is NOT taken from the controller's
  // 1e9-based synthSeq: that base sorts after EVERY wire frame in the session — including the agent's
  // reply to this very message — so the user bubble would visibly render BELOW the response it
  // prompted. The placement is frozen into the event here, so it is stable across re-derives.
  // MUST be called only AFTER the corresponding dispatch (send_agent_message / refinePrototype /
  // requestChanges) SUCCEEDS — a failed send must never leave an orphan bubble implying the agent
  // received feedback it did not.
  // Multimodal: `images` (optional) are DISPLAY data URLs rendered as thumbnails in the bubble. OMITTED
  // when absent/empty so a text-only echo is unchanged. Stored verbatim on the event (frozen across
  // re-derives like the seq).
  // CONSECUTIVE ECHOES: the composer stays typable while the agent is active and its first frame can
  // lag, so a user may send two messages before any wire frame arrives. Both would land at
  // `lastWireSeq + 0.5` and collide on `nodeKey` (the keyed renderer would drop the first bubble). So
  // each echo since the last wire frame BISECTS the gap toward the next integer: +0.5 (first, unchanged),
  // then +0.75, +0.833… — strictly increasing, always < `lastWireSeq + 1` (the agent's reply), so
  // arrival order holds and no echo can collide with a wire seq or a later echo.
  appendUserMessage(text: string, images?: string[]): void {
    const seq = this.lastWireSeq + 0.5 + 0.5 * (1 - 1 / (this.echoCount + 1));
    this.echoCount++;
    this.events.push({
      __event: "user_message",
      seq,
      text,
      ...(images && images.length ? { images } : {}),
    });
  }

  // Echo a verbatim user message at an EXPLICIT seq (the history-replay counterpart to
  // appendUserMessage). Unlike the live echo — which derives its seq from `lastWireSeq + 0.5` so a
  // freshly-submitted message sorts after the frames seen so far — replayed transcript user turns
  // carry their TRUE file position as the seq, so they order against the surrounding assistant /
  // tool frames exactly as they appeared on disk. Does NOT touch `lastWireSeq` (replay assigns every
  // frame's seq from one external monotonic counter; there is no live wire to track).
  appendUserMessageAt(text: string, seq: number): void {
    this.events.push({ __event: "user_message", seq, text });
  }

  // Echo a verbatim SYSTEM message at an EXPLICIT seq (history-replay only). Mirrors
  // appendUserMessageAt but produces a dim SystemMessageNode instead of a user bubble — used for
  // harness-injected role:"user" plumbing records that the human did not type. Never touches
  // session state or `lastWireSeq` (replay assigns every seq from one external monotonic counter).
  appendSystemMessageAt(text: string, seq: number): void {
    this.events.push({ __event: "system_message", seq, text });
  }

  // Record that the user submitted answers for the AskUserQuestion request `id`. `seq` is assigned by
  // the controller. On derive this folds onto the matching question_request node (form → answers).
  appendQuestionAnswered(id: string, answers: AskUserQuestionAnswers, seq: number): void {
    this.events.push({ __event: "question_answered", seq, id, answers });
  }

  // Record that the held permission `id` was resolved (allow OR deny) — the ExitPlanMode resolve
  // path's counterpart to appendQuestionAnswered. `seq` is assigned by the controller. On derive
  // this clears the waiting-for-input override (no timeline node).
  appendPermissionResolved(id: string, seq: number): void {
    this.events.push({ __event: "permission_resolved", seq, id });
  }

  // The single accumulated quota-banner event, or null when none. The banner is a SINGLETON — at most
  // one node in the tree at a time — so we hold its event by reference and mutate it in place (a
  // waiting -> exhausted transition, or a resumed clear) rather than pushing a second event that would
  // derive into a duplicate row. Held separately from `events` (it is also pushed into `events` so it
  // sorts into the timeline) only to support the in-place update/clear.
  private quotaBanner: Extract<ModelEvent, { __event: "quota_banner" }> | null = null;

  // Append OR update the quota banner as a SINGLETON. The first call creates the event (placed at
  // `lastWireSeq + 0.5`, after the paused turn's last frame but before the resumed reply); subsequent
  // calls UPDATE the same event in place (e.g. waiting -> exhausted), so the banner is never
  // duplicated. The `state` "cleared" tombstone is set via clearQuotaBanner (onQuotaResumed), not here.
  appendQuotaBanner(info: {
    state: "waiting" | "exhausted";
    resetAt: number;
    remaining: number;
    source: string;
    // DEMO-ONLY (mock-animate): static remaining-ms override; production omits it. See
    // QuotaBannerNode.frozenRemainingMs.
    frozenRemainingMs?: number;
  }): void {
    // A quota-banner change (create OR in-place update) forces the next derive to fully replay: an
    // in-place update pushes NO new event, so the incremental fast path would never see it.
    this.quotaDirty = true;
    if (this.quotaBanner) {
      // Update the existing singleton in place — no new event, no duplicate node.
      this.quotaBanner.state = info.state;
      this.quotaBanner.resetAt = info.resetAt;
      this.quotaBanner.remaining = info.remaining;
      this.quotaBanner.source = info.source;
      this.quotaBanner.frozenRemainingMs = info.frozenRemainingMs;
      return;
    }
    const ev: Extract<ModelEvent, { __event: "quota_banner" }> = {
      __event: "quota_banner",
      seq: this.lastWireSeq + 0.5,
      state: info.state,
      resetAt: info.resetAt,
      remaining: info.remaining,
      source: info.source,
      ...(info.frozenRemainingMs !== undefined
        ? { frozenRemainingMs: info.frozenRemainingMs }
        : {}),
    };
    this.quotaBanner = ev;
    this.events.push(ev);
  }

  // Update the quota banner to a new state (e.g. waiting -> exhausted) — an alias for appendQuotaBanner
  // when one is known to exist, retained for call-site clarity. If none exists yet it creates one (so a
  // direct exhausted-without-prior-pause is still a single node).
  updateQuotaBanner(info: {
    state: "waiting" | "exhausted";
    resetAt: number;
    remaining: number;
    source: string;
    // DEMO-ONLY (mock-animate): static remaining-ms override; production omits it. Forwarded as-is.
    frozenRemainingMs?: number;
  }): void {
    this.appendQuotaBanner(info);
  }

  // Clear (tombstone) the quota banner — the onQuotaResumed counterpart. The singleton's `state` is set
  // to "cleared" so derive() produces NO node for it (the banner is logically removed) while the event
  // stays in `events` (harmless; it contributes nothing). Idempotent / inert when no banner exists.
  clearQuotaBanner(): void {
    if (this.quotaBanner) {
      this.quotaBanner.state = "cleared";
      // In-place mutation with no new event → force a full replay on the next derive.
      this.quotaDirty = true;
    }
  }

  // Reset (new session). Drops the retained derivation state so the next derive rebuilds from empty.
  reset(): void {
    this.events = [];
    this.lastWireSeq = -1;
    this.echoCount = 0;
    this.quotaBanner = null;
    this.acc = null;
    this.nextEventIndex = 0;
    this.maxProcessedSeq = -Infinity;
    this.quotaDirty = false;
  }

  // Derive the renderable tree from the accumulated events, amortized O(new events) per call. New
  // events are folded into the retained accumulator on the fast path unless one forces a full replay.
  // Pure w.r.t. `events` (never mutates the source list).
  derive(): RenderTree {
    // Decide fast path vs full replay by SCANNING the new events (no mutation): a first derive, a
    // dirtied quota banner, a terminal frame (result/exit/fatal error), or an out-of-order WIRE frame
    // (seq below the running max — the demotion/correlation ordering can't be patched incrementally)
    // all force a replay. The scan tracks a running max so an out-of-order pair WITHIN this batch is
    // caught too. Deciding before touching `acc` keeps the previous accumulator intact for
    // reconciliation.
    // INVARIANT[incremental-derive-equals-fresh-replay] (runtime-guard): the incremental fast path is taken only when it provably matches a from-scratch replay; a first derive, a dirtied quota banner, a terminal frame, or an out-of-order wire seq forces a full replay instead.
    //   prevents: an incrementally-fed model drifting from a fresh full replay (the storyboard oracle covers only the replay path).
    //   test: stream.incremental.test.ts incremental-equals-fresh equivalence battery over adversarial sequences
    let fallback = this.acc === null || this.quotaDirty;
    if (!fallback) {
      let running = this.maxProcessedSeq;
      for (let i = this.nextEventIndex; i < this.events.length; i++) {
        const ev = this.events[i];
        if (isTerminalEvent(ev)) {
          fallback = true;
          break;
        }
        if (isWireSeq(ev)) {
          if (seqOf(ev) < running) {
            fallback = true;
            break;
          }
          if (seqOf(ev) > running) running = seqOf(ev);
        }
      }
    }

    if (fallback) {
      this.acc = this.replayAll();
      this.nextEventIndex = this.events.length;
      let max = -Infinity;
      for (const ev of this.events) {
        if (isWireSeq(ev) && seqOf(ev) > max) max = seqOf(ev);
      }
      this.maxProcessedSeq = max;
      this.quotaDirty = false;
    } else {
      const acc = this.acc!;
      const sink = liveSink(acc);
      for (let i = this.nextEventIndex; i < this.events.length; i++) {
        const ev = this.events[i];
        // Continue the arrival-order segment count (a non-first system_init opens the next segment)
        // BEFORE stamping this event's segment — identical to the replay's arrival-order pass.
        if (isStream(ev) && ev.kind === "system_init") {
          if (acc.seenSystemInit) acc.segment++;
          acc.seenSystemInit = true;
        }
        consume(acc, ev, acc.segment, sink);
        if (isWireSeq(ev) && seqOf(ev) > this.maxProcessedSeq) this.maxProcessedSeq = seqOf(ev);
      }
      this.nextEventIndex = this.events.length;
    }

    const acc = this.acc!;
    // A FRESH array wrapper + a FRESH working object each call: callers mutate `tree.working` and hold
    // `tree.nodes`, and neither must poison the retained accumulator. The node OBJECTS are shared
    // (their identity is the renderer's DOM-reuse signal).
    return {
      nodes: [...acc.topNodes],
      permissionMode: acc.permissionMode,
      complete: acc.complete,
      working: deriveWorking(acc),
    };
  }

  // Build a full DeriveAccum from scratch by replaying every accumulated event. This is the O(n)
  // reference path: order-insensitive correlation + a stable seq sort so late-arriving frames resolve
  // regardless of wire order. Reconciles the rebuilt nodes against the PREVIOUS accumulator so
  // content-unchanged nodes keep their object identity.
  private replayAll(): DeriveAccum {
    const prev = this.acc;
    const acc = emptyAccum();

    // Assign a session SEGMENT to every event, in ARRIVAL order (NOT seq order — a resume resets the
    // wire seq, so seq order scrambles the two sessions together). A fresh sidecar — every session
    // RESUME (quota auto-resume OR manual post-end Send) goes through a fresh `start_agent_session` —
    // emits a NEW `system_init`; the FIRST system_init opens segment 0, each SUBSEQUENT one opens the
    // next segment. Synthetic frames (exit/error/notice at synthSeq) inherit the segment current at
    // their arrival point, so a session-end exit stays in the segment it ended. Keyed on the stable
    // event object reference so the seq-ordered consume loop can look each event's segment back up.
    // The final (segment, seenSystemInit) are stored on the accumulator so the fast path continues the
    // arrival-order count from here.
    // INVARIANT[segment-arrival-monotonic] (runtime-guard): each event gets a session-segment number in arrival order; each subsequent system_init opens the next segment.
    //   prevents: seq-order scrambling across a resume (which resets the wire seq)
    const segmentOf = new Map<ModelEvent, number>();
    {
      let segment = 0;
      let seenSystemInit = false;
      for (const ev of this.events) {
        if (isStream(ev) && ev.kind === "system_init") {
          if (seenSystemInit) segment++;
          seenSystemInit = true;
        }
        segmentOf.set(ev, segment);
      }
      acc.segment = segment;
      acc.seenSystemInit = seenSystemInit;
    }

    // Consume every event in seq order (a stable sort on a copy — never mutate the source list). The
    // `placed` list (everything except tool_results, which fold into their tool) accumulates in seq
    // order so group children come out ordered.
    const ordered = [...this.events].sort((a, b) => seqOf(a) - seqOf(b));
    const placed: Placed[] = [];
    const sink = batchSink(acc, placed);
    for (const ev of ordered) {
      consume(acc, ev, segmentOf.get(ev) ?? 0, sink);
    }

    foldAnswers(acc);
    demoteAbandonedTools(acc);
    assembleTopNodes(acc, placed);
    if (prev) reconcileIdentity(acc, prev);
    return acc;
  }
}

// Where a consumed event's render output goes. The full replay collects nodes into a flat list for a
// single sorted assembly and lets the finalize passes fold answers / annotate groups; the incremental
// fast path instead inserts nodes into the LIVE topNodes/groups and folds/annotates in place. consume
// stays placement-agnostic by delegating all three to the sink.
interface DeriveSink {
  // A produced render node + the parent_tool_use_id it belongs under (null = top level).
  emit(node: RenderNode, parent: string | null): void;
  // Patch a text node already in the tree (a streaming-delta append or the terminal commit) and
  // return the now-authoritative node. The full replay mutates it in place (still held in `placed`);
  // the fast path replaces it copy-on-write so a prior derive's node is never mutated.
  patchText(node: TextNode, patch: Partial<TextNode>): TextNode;
  // Correlate a tool_result onto its tool_use row (running → done/error). No-op if the id is unknown.
  correlateResult(toolUseId: string, content: unknown, isError: boolean): void;
  // The subagent metadata for `id` was just updated (a `subagent_started` frame) — sync the group.
  syncSubagentMeta(id: string): void;
  // The answers for question-request `id` were just recorded — fold them onto the question node.
  foldAnswer(id: string, answers: AskUserQuestionAnswers): void;
}

// Apply ONE event to the accumulator, with the session segment it was consumed in (arrival-order —
// the caller supplies it). Node placement + answer folds + group metadata sync go through `sink`;
// scalar updates, tool correlation, and the index maps mutate the accumulator directly. This is the
// single per-event transition shared by the full replay and the incremental fast path.
function consume(acc: DeriveAccum, ev: ModelEvent, segment: number, sink: DeriveSink): void {
  // Lexicographic-max update of the latest turn-terminal (segment, seq) — the demotion scope.
  const noteTerminal = (seq: number): void => {
    if (
      segment > acc.lastTerminalSeg ||
      (segment === acc.lastTerminalSeg && seq > acc.lastTerminalSeq)
    ) {
      acc.lastTerminalSeg = segment;
      acc.lastTerminalSeq = seq;
    }
  };

  if (isStream(ev)) {
    // Any non-terminal stream frame implies a turn is generating → activate the indicator (the
    // per-kind cases below de-activate on `result`). This makes the indicator appear on the first
    // frame (system_init) before any explicit `status` arrives.
    if (ev.kind !== "result") acc.active = true;
    // Any frame proving the turn progressed means the interactive hold (if any) was released — the
    // SDK emits no frames for the turn while a canUseTool hold is pending.
    switch (ev.kind) {
      case "assistant_text":
      case "assistant_text_delta":
      case "tool_use":
      case "tool_result":
      case "status":
      case "mode_change":
      case "result":
        acc.pendingInteractiveId = null;
        break;
    }
    switch (ev.kind) {
      case "system_init":
        acc.permissionMode = ev.permission_mode;
        break;
      case "status":
        // Label-only progress signal — update the live indicator (does NOT add a timeline node).
        acc.latestStatusLabel = ev.label;
        break;
      case "quota_exceeded":
        // INERT here. A non-fatal quota notice that travels via agent-stream (NOT agent-error). It
        // adds NO timeline node, does NOT flip `complete`, and does NOT clear/seed `working` or
        // `active`. The waiting banner + auto-resume are owned by the orchestrator observer in a
        // LATER phase — this reducer stays a pure inert pass-through so the exhaustive
        // discriminated-union switch remains sound.
        break;
      case "subagent_started":
        // Record the subagent's identity + task, keyed by its tool_use_id (= the group key). This
        // adds NO timeline node directly — it seeds/annotates the subagent group in the grouping
        // pass, so the group appears (labeled) even before its first child arrives.
        acc.subagentMeta.set(ev.tool_use_id, {
          seq: ev.seq,
          subagentType: ev.subagent_type,
          description: ev.description,
          prompt: ev.prompt,
        });
        sink.syncSubagentMeta(ev.tool_use_id);
        break;
      case "assistant_text_delta": {
        // A live streaming chunk. The first delta for a block_uid mints + emits a growing text node;
        // each later delta appends its text verbatim to that node (never trimmed — a chunk carries
        // inter-word/paragraph spacing, so dropping a whitespace-only one would diverge from the
        // terminal block). Routed through the same sink/segment/parent machinery as assistant_text so
        // a subagent delta groups under its parent_tool_use_id.
        const key = liveKey(segment, ev.block_uid);
        const live = acc.liveTextByUid.get(key);
        if (!live) {
          const node: TextNode = {
            type: "text",
            seq: ev.seq,
            segment,
            text: ev.text,
            blockUid: ev.block_uid,
            live: true,
          };
          acc.liveTextByUid.set(key, node);
          sink.emit(node, ev.parent_tool_use_id);
        } else {
          const grown = sink.patchText(live, { text: live.text + ev.text });
          acc.liveTextByUid.set(key, grown);
        }
        break;
      }
      case "assistant_text": {
        // A streamed block carries `block_uid` correlating it to its live delta node: finalize that
        // node — the terminal text is authoritative over the concatenated chunks — and mark it
        // committed, so exactly one bubble finalizes in place (no flash, no duplicate).
        if (ev.block_uid !== undefined) {
          const key = liveKey(segment, ev.block_uid);
          const live = acc.liveTextByUid.get(key);
          if (live) {
            sink.patchText(live, { text: ev.text, live: false });
            acc.liveTextByUid.delete(key);
            break;
          }
          // block_uid present but no deltas seen (dropped, or the block produced none): emit a fresh
          // committed node carrying the uid so it keys stably, applying the whitespace drop.
          if (ev.text.trim() === "") break;
          sink.emit(
            { type: "text", seq: ev.seq, segment, text: ev.text, blockUid: ev.block_uid },
            ev.parent_tool_use_id,
          );
          break;
        }
        // No block_uid → exact pre-streaming behavior (preserves every hand-built-frame test).
        // Whitespace-only text frames render as empty bubbles (and a blank subagent child would seed
        // an empty group via its parent_tool_use_id) — drop them entirely.
        if (ev.text.trim() === "") break;
        sink.emit({ type: "text", seq: ev.seq, segment, text: ev.text }, ev.parent_tool_use_id);
        break;
      }
      case "tool_use": {
        const node: ToolNode = {
          type: "tool",
          seq: ev.seq,
          segment,
          id: ev.id,
          tool: ev.tool,
          input: ev.input,
          status: "running",
          result: null,
          isError: false,
        };
        acc.toolById.set(ev.id, node);
        acc.toolSegment.set(ev.id, segment);
        sink.emit(node, ev.parent_tool_use_id);
        break;
      }
      case "tool_result":
        // Correlate onto the matching tool_use by id (running → done/error). A result with no
        // matching tool_use is dropped (no orphan row) — the tool row is the unit of display. The
        // full replay mutates the fresh node in place; the fast path replaces it copy-on-write.
        sink.correlateResult(ev.tool_use_id, ev.content, ev.is_error);
        break;
      case "mode_change":
        acc.permissionMode = ev.mode;
        sink.emit({ type: "mode", seq: ev.seq, segment, mode: ev.mode }, null);
        break;
      case "result":
        acc.complete = true;
        // The turn finished — the working indicator must hide. A later status frame (next turn)
        // re-activates it; latestStatusLabel is cleared so the next turn re-seeds cleanly.
        acc.active = false;
        acc.latestStatusLabel = null;
        noteTerminal(ev.seq);
        sink.emit(
          {
            type: "result",
            seq: ev.seq,
            segment,
            isError: ev.is_error,
            result: ev.result,
            subtype: ev.subtype,
            // The verdict survives rebuilds ONLY because it lives on the stored frame.
            deliberateInterrupt: ev.deliberateInterrupt ?? false,
          },
          null,
        );
        break;
      case "permission_denied":
        sink.emit(
          {
            type: "permission_denied",
            seq: ev.seq,
            segment,
            tool: ev.tool,
            toolUseId: ev.tool_use_id,
            reasonType: ev.decision_reason_type,
            message: ev.message,
          },
          null,
        );
        break;
    }
    return;
  }

  if (isPermissionRequest(ev)) {
    acc.active = true; // a pending permission means the turn is live (awaiting review)
    // The agent is now blocked on the user (AskUserQuestion answers / ExitPlanMode review) — the
    // working indicator must say so instead of repeating a stale status label. UNLESS this hold was
    // already answered/resolved (its resolution arrived first — arrival order is free), in which case
    // it must not re-arm.
    if (!acc.resolvedInteractiveIds.has(ev.id)) acc.pendingInteractiveId = ev.id;
    if (ev.tool === "AskUserQuestion") {
      // An interactive question request: render the answer card. Pull the questions array off the
      // tool input (defensively coerced); the controller resolves it via resolve_tool_permission.
      const input = ev.input as { questions?: unknown } | null | undefined;
      const questions = Array.isArray(input?.questions)
        ? (input!.questions as AskUserQuestionItem[])
        : [];
      const node: QuestionRequestNode = {
        type: "question_request",
        seq: ev.seq,
        segment,
        id: ev.id,
        questions,
        // Seed from any answer ALREADY recorded — on the fast path the answered event can arrive
        // before its request (its synthetic seq sorts it after in a replay, but arrival order is
        // free), so the fold must also happen at request time, not only at answer time.
        answers: acc.answersById.get(ev.id) ?? null,
      };
      acc.questionNodesById.set(ev.id, node);
      sink.emit(node, null);
    } else {
      sink.emit(
        {
          type: "permission_request",
          seq: ev.seq,
          segment,
          id: ev.id,
          tool: ev.tool,
          agentId: ev.agent_id,
        },
        null,
      );
    }
    return;
  }

  if (ev.__event === "question_answered") {
    // A submitted answer set — record it, and fold it onto the matching question_request node (via
    // the sink, so the fast path updates the live node; the full replay's foldAnswers pass is
    // authoritative there). It produces NO standalone node, so a stray answered event with no
    // matching request is inert.
    acc.answersById.set(ev.id, ev.answers);
    acc.resolvedInteractiveIds.add(ev.id);
    sink.foldAnswer(ev.id, ev.answers);
    if (ev.id === acc.pendingInteractiveId) acc.pendingInteractiveId = null;
    return;
  }

  if (ev.__event === "permission_resolved") {
    // The held permission was resolved from the frontend (ExitPlanMode approve/deny) — clear the
    // waiting-for-input override NOW; the SDK's next frames may lag the click.
    acc.resolvedInteractiveIds.add(ev.id);
    if (ev.id === acc.pendingInteractiveId) acc.pendingInteractiveId = null;
    return;
  }

  if (ev.__event === "error") {
    // A fatal error ends the session → hide the working indicator (a non-fatal error leaves the turn
    // running, so it does NOT deactivate).
    if (ev.fatal) {
      acc.exited = true;
      acc.active = false;
      noteTerminal(ev.seq);
    }
    sink.emit(
      {
        type: "error",
        seq: ev.seq,
        segment,
        errorKind: ev.kind,
        message: ev.message,
        fatal: ev.fatal,
      },
      null,
    );
    return;
  }

  if (ev.__event === "notice") {
    // A plain notice — never touches session state (no exited/active flip). Pure render row.
    sink.emit({ type: "notice", seq: ev.seq, segment, message: ev.message }, null);
    return;
  }

  if (ev.__event === "user_message") {
    // A verbatim user-message echo — a top-level bubble. Never touches session state (it is a record
    // of what the user sent, not an agent signal); sorts into the timeline by its seq.
    sink.emit(
      {
        type: "user",
        seq: ev.seq,
        segment,
        text: ev.text,
        // Carry the display image URLs onto the node ONLY when present (omitted otherwise so a
        // text-only bubble renders no thumbnail row).
        ...(ev.images && ev.images.length ? { images: ev.images } : {}),
      },
      null,
    );
    return;
  }

  if (ev.__event === "system_message") {
    // A verbatim SYSTEM-message echo (harness-injected plumbing turn) — a top-level dim bubble. Never
    // touches session state; sorts into the timeline by its seq, exactly like user_message.
    sink.emit({ type: "system", seq: ev.seq, segment, text: ev.text }, null);
    return;
  }

  if (ev.__event === "quota_banner") {
    // The quota-banner singleton — a PURE render row. Never touches session state (no complete/
    // active/exited flip). A "cleared" tombstone (onQuotaResumed) produces NO node, so the banner is
    // logically removed; "waiting"/"exhausted" each derive the single banner node.
    if (ev.state !== "cleared") {
      sink.emit(
        {
          type: "quota-banner",
          seq: ev.seq,
          segment,
          state: ev.state,
          resetAt: ev.resetAt,
          remaining: ev.remaining,
          source: ev.source,
          // DEMO-ONLY (mock-animate) static-countdown override; undefined in production.
          frozenRemainingMs: ev.frozenRemainingMs,
        },
        null,
      );
    }
    return;
  }

  // exit — the session ended; the working indicator must hide.
  acc.exited = true;
  acc.active = false;
  noteTerminal(ev.seq);
  sink.emit({ type: "exit", seq: ev.seq, segment, code: ev.code }, null);
}

// Fold submitted answers onto their question_request nodes (form → chosen answers).
function foldAnswers(acc: DeriveAccum): void {
  for (const [id, answers] of acc.answersById) {
    const node = acc.questionNodesById.get(id);
    if (node) node.answers = answers;
  }
}

// Turn-end demotion (SEGMENT- + SEQ-SCOPED): a tool_use still "running" that is causally BEFORE the
// latest turn-terminal frame (`result`/`exit`/fatal error) never received its tool_result before that
// turn ended and never will — demote it to "interrupted" so its row stops pulsing forever. The
// scoping is load-bearing twice over: the model is session-scoped (one model across the orchestrator's
// many sequential turns AND across a session resume; `complete` is set on the FIRST result and never
// reset), so an UNSCOPED demotion would wrongly flip a still-running turn-N tool. We compare
// (segment, seq) LEXICOGRAPHICALLY: a tool in a LATER segment than the latest terminal frame (a fresh
// resumed-session tool — the resume reset the wire seq, so a raw seq compare would misfire) is left
// running; within the SAME segment the plain seq compare applies, so a genuinely-abandoned tool (a
// terminal frame after it in its own segment) still interrupts. Only RUNNING tools are touched;
// done/error tools already correlated.
// INVARIANT[turn-end-demotion-segment-and-seq-scoped] (reducer-total): a still-running tool is demoted to interrupted iff a turn-terminal frame is causally after it, compared (segment,seq) lexicographically.
//   prevents: a running turn-N tool flipped by an earlier turn's terminal, or a resumed-session tool flipped by the prior session's synthetic exit
function demoteAbandonedTools(acc: DeriveAccum): void {
  for (const tool of acc.toolById.values()) {
    if (tool.status !== "running") continue;
    const seg = acc.toolSegment.get(tool.id) ?? 0;
    const terminalIsAfter =
      acc.lastTerminalSeg > seg || (acc.lastTerminalSeg === seg && acc.lastTerminalSeq > tool.seq);
    if (terminalIsAfter) tool.status = "interrupted";
  }
}

// Group nodes with a non-null parent into a subagent group keyed by that parent, then order the top
// level by seq. The group's seq is the EARLIEST child seq (seeded from `subagent_started` metadata
// when present) so it sorts into the top-level timeline at the point its first activity appears.
// (Grouping key is the frozen parent_tool_use_id; NO name label is attached — none is frozen.)
// Children within a group come out in seq order because `placed` was built in seq order.
function assembleTopNodes(acc: DeriveAccum, placed: Placed[]): void {
  const topNodes: TopNode[] = [];
  acc.groupsById.clear();

  // Create-or-fetch a subagent group for `id`, applying any known metadata. Metadata may have arrived
  // before OR after the first child; this is order-independent because both the metadata seeding and
  // the placed-node pass funnel through here.
  const groupFor = (id: string): SubagentGroupNode => {
    let group = acc.groupsById.get(id);
    if (!group) {
      const meta = acc.subagentMeta.get(id);
      group = {
        type: "subagent",
        // Seed seq from metadata when present; the earliest-child fold below lowers it further.
        seq: meta ? meta.seq : Number.MAX_SAFE_INTEGER,
        agentId: id,
        subagentType: meta?.subagentType ?? null,
        description: meta?.description ?? null,
        prompt: meta?.prompt ?? null,
        children: [],
      };
      acc.groupsById.set(id, group);
      topNodes.push(group);
    }
    return group;
  };

  // Seed groups for every `subagent_started` frame FIRST — so a group appears (labeled) the instant
  // the subagent starts, even before any child node has arrived.
  for (const id of acc.subagentMeta.keys()) {
    groupFor(id);
  }

  for (const { node, parent } of placed) {
    if (parent === null) {
      topNodes.push(node);
      continue;
    }
    const group = groupFor(parent);
    group.children.push(node);
    // The group's seq tracks the earliest child so it sorts correctly in the timeline.
    if (node.seq < group.seq) group.seq = node.seq;
  }

  topNodes.sort((a, b) => a.seq - b.seq);
  acc.topNodes = topNodes;
}

// The controller's synthetic-seq base (index.ts `synthSeq = 1_000_000_000`): exit / error / notice /
// question_answered / permission_resolved carry a seq at or above this. A WIRE seq (real agent-stream
// / permission-request frames, plus the fractional `lastWireSeq + 0.5` echoes) is strictly below it.
// The fast path's monotonic gate tracks WIRE seqs only — a synthetic seq must never raise it (it sorts
// after every wire frame in the session, so it can always be appended without disengaging the gate).
const SYNTHETIC_SEQ_BASE = 1_000_000_000;

function isWireSeq(ev: ModelEvent): boolean {
  return seqOf(ev) < SYNTHETIC_SEQ_BASE;
}

// A turn-terminal event (result / exit / FATAL error). Terminals force a full replay so the turn-end
// demotion stays a single final pass and the deliberateInterrupt payload is re-read from the stored
// frame — decoupling the incremental path from the controller's in-place result-frame mutation.
function isTerminalEvent(ev: ModelEvent): boolean {
  if (isStream(ev)) return ev.kind === "result";
  if ("__event" in ev) {
    if (ev.__event === "exit") return true;
    if (ev.__event === "error") return ev.fatal;
  }
  return false;
}

// Insert `item` into a seq-sorted list, keeping equal-seq ties in ARRIVAL order (after existing
// equals) — matching the full replay's stable seq sort. Scans from the tail, so an item at/after the
// current max (the fast-path common case) is an O(1) append.
function insertSorted<T extends { seq: number }>(list: T[], item: T): void {
  let i = list.length;
  while (i > 0 && list[i - 1].seq > item.seq) i--;
  list.splice(i, 0, item);
}

// Create-or-fetch the LIVE subagent group for `id`, inserting a freshly-created group into topNodes at
// its seq. A group is created at the seq of its FIRST element (metadata seq when a `subagent_started`
// seeded it, else the first child's `seqHint`). On the fast path every later element has a seq >= that
// first one (the monotonic wire-seq gate), so the group's seq — the earliest element — never lowers
// and the group never needs repositioning. (An out-of-order earlier child would fail the gate and
// force a full replay instead.)
function ensureLiveGroup(acc: DeriveAccum, id: string, seqHint: number): SubagentGroupNode {
  let group = acc.groupsById.get(id);
  if (!group) {
    const meta = acc.subagentMeta.get(id);
    group = {
      type: "subagent",
      seq: meta ? meta.seq : seqHint,
      agentId: id,
      subagentType: meta?.subagentType ?? null,
      description: meta?.description ?? null,
      prompt: meta?.prompt ?? null,
      children: [],
    };
    acc.groupsById.set(id, group);
    insertSorted(acc.topNodes, group);
  }
  return group;
}

// Replace a subagent group with a patched COPY (copy-on-write), keeping topNodes + groupsById
// pointing at the new object. Any change to a group's content — a new child, an edited child, updated
// metadata — mints a new group object, so a group's identity is stable IFF its content is unchanged.
function cowGroup(
  acc: DeriveAccum,
  oldGroup: SubagentGroupNode,
  patch: Partial<SubagentGroupNode>,
): SubagentGroupNode {
  const newGroup: SubagentGroupNode = { ...oldGroup, ...patch };
  acc.groupsById.set(newGroup.agentId, newGroup);
  const gi = acc.topNodes.indexOf(oldGroup);
  if (gi !== -1) acc.topNodes[gi] = newGroup;
  return newGroup;
}

// Replace `oldNode` with `newNode` wherever it sits (top level or a group child), by object identity.
// A group child is replaced inside a COPIED children array on a COW'd group, so a held snapshot of the
// old tree keeps the old child AND the old group object.
function replaceNodeInTree(acc: DeriveAccum, oldNode: RenderNode, newNode: RenderNode): void {
  const top = acc.topNodes.indexOf(oldNode);
  if (top !== -1) {
    acc.topNodes[top] = newNode;
    return;
  }
  for (const group of acc.groupsById.values()) {
    const ci = group.children.indexOf(oldNode);
    if (ci !== -1) {
      const children = group.children.slice();
      children[ci] = newNode;
      cowGroup(acc, group, { children });
      return;
    }
  }
}

// The full-replay sink: collect nodes into `placed` for a single sorted assembly, and correlate
// results by mutating the FRESH tool node in place (the node in `placed` and in toolById are the same
// object during a replay). Answer folds and group-metadata annotation are handled authoritatively by
// the finalize passes (foldAnswers / assembleTopNodes), so they are no-ops here.
function batchSink(acc: DeriveAccum, placed: Placed[]): DeriveSink {
  return {
    emit: (node, parent) => placed.push({ node, parent }),
    // A replay builds fresh nodes, so mutate in place — the same object is held in `placed` and in
    // liveTextByUid, so both reflect the growth without an O(n) find/swap.
    patchText: (node, patch) => {
      Object.assign(node, patch);
      return node;
    },
    correlateResult: (toolUseId, content, isError) => {
      const target = acc.toolById.get(toolUseId);
      if (target) {
        target.status = isError ? "error" : "done";
        target.result = content;
        target.isError = isError;
      }
    },
    syncSubagentMeta: () => {},
    foldAnswer: () => {},
  };
}

// The fast-path sink: insert nodes into the LIVE topNodes / group children, and apply edits to earlier
// nodes copy-on-write so a node's object identity changes IFF its content changes.
// INVARIANT[derive-snapshot-isolation] (runtime-guard): the fast path edits an earlier node copy-on-write (a fresh object replaces the old), never mutating a node a prior derive() already handed out.
//   prevents: a caller-held tree mutating underneath the renderer's object-identity checks.
//   test: stream.incremental.test.ts identity test (a) — a correlating tool_result yields a NEW node while a tree held from before still shows 'running'
function liveSink(acc: DeriveAccum): DeriveSink {
  return {
    emit: (node, parent) => {
      if (parent === null) {
        insertSorted(acc.topNodes, node);
        return;
      }
      const group = ensureLiveGroup(acc, parent, node.seq);
      // COW: a new children array (the child appended at its sorted position) on a new group object,
      // so a group with a fresh child is a fresh object. Under the monotonic wire-seq gate the child's
      // seq is >= every existing child's, so it appends at the tail and the group's seq is unchanged.
      const children = group.children.slice();
      insertSorted(children, node);
      cowGroup(acc, group, { children });
    },
    // Copy-on-write: a grown/committed text node is a fresh object replacing the old one, so a prior
    // derive()'s node is never mutated (snapshot isolation) and the changed object identity signals
    // the renderer to refresh the bubble.
    patchText: (node, patch) => {
      const updated: TextNode = { ...node, ...patch };
      replaceNodeInTree(acc, node, updated);
      return updated;
    },
    correlateResult: (toolUseId, content, isError) => {
      const old = acc.toolById.get(toolUseId);
      if (!old) return;
      const updated: ToolNode = {
        ...old,
        status: isError ? "error" : "done",
        result: content,
        isError,
      };
      acc.toolById.set(toolUseId, updated);
      replaceNodeInTree(acc, old, updated);
    },
    syncSubagentMeta: (id) => {
      const meta = acc.subagentMeta.get(id);
      if (!meta) return;
      const existing = acc.groupsById.get(id);
      // Metadata before any child: create the (already-labeled) group. Otherwise COW the existing
      // group with the new label. meta.seq is >= the group's seq on the fast path, so seq is unchanged.
      if (!existing) {
        ensureLiveGroup(acc, id, meta.seq);
        return;
      }
      cowGroup(acc, existing, {
        subagentType: meta.subagentType,
        description: meta.description,
        prompt: meta.prompt,
      });
    },
    foldAnswer: (id, answers) => {
      const old = acc.questionNodesById.get(id);
      if (!old) return;
      const updated: QuestionRequestNode = { ...old, answers };
      acc.questionNodesById.set(id, updated);
      replaceNodeInTree(acc, old, updated);
    },
  };
}

// A stable identity key for a node, derivable from the node ALONE. Nodes with a natural id (tools,
// question / permission requests, subagent groups) key on it; the rest key on (segment, type, seq).
// The segment qualifier is load-bearing: a resume RESETS the wire seq to 0, so two same-type nodes at
// the same seq in different segments would collide on (type, seq) — and for DOM reuse a collision
// mis-slots an element (not merely a harmless byte-equal reuse). EXPORTED so the renderer keys DOM
// reuse with the SAME function the model's replay reconciliation uses (one keying rule, not two).
export function nodeKey(n: RenderNode | SubagentGroupNode): string {
  switch (n.type) {
    case "tool":
      return `tool:${n.id}`;
    case "question_request":
      return `question:${n.id}`;
    case "permission_request":
      return `perm:${n.id}`;
    case "subagent":
      return `group:${n.agentId}`;
    case "text":
      // A streamed block keys on its session-unique block_uid — stable across every delta and the
      // terminal commit, so all map to ONE cache slot / one bubble (and never collide across turns).
      // A non-streamed block keeps the (segment, type, seq) key.
      return n.blockUid !== undefined
        ? `${n.segment ?? 0}:text:uid:${n.blockUid}`
        : `${n.segment ?? 0}:${n.type}:${n.seq}`;
    default:
      return `${n.segment ?? 0}:${n.type}:${n.seq}`;
  }
}

// Key for the live-streaming-node map (DeriveAccum.liveTextByUid): a streamed block is scoped to BOTH
// its arrival segment AND its session-unique block_uid. A resume restarts the sidecar's block_uid
// counter at 0, so two segments each open a block "0"; the full replay consumes events in seq order,
// which interleaves segments (a resume resets the wire seq). Without the segment scope a new segment's
// block would cross-attach to an orphaned prior-segment node (a block interrupted before its
// terminal). Mirrors nodeKey's segment scoping — the same defect, the same guard.
function liveKey(segment: number, blockUid: string): string {
  return `${segment}:${blockUid}`;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Reconcile a freshly-rebuilt accumulator against the PREVIOUS one so that a node whose content is
// unchanged keeps its previous OBJECT IDENTITY; only changed/new nodes stay fresh objects. This makes
// object identity a faithful "content changed" signal across a full replay (a terminal-triggered
// fallback), so the renderer can key DOM reuse on it. Reused objects are re-linked into the fresh
// accumulator's index maps so later lookups (correlation, folds) hit the object that is actually in
// the tree.
// INVARIANT[replay-reconciles-node-identity] (runtime-guard): after a full replay, a content-unchanged node keeps its previous object identity (only changed/new nodes are fresh).
//   prevents: a full-replay fallback needlessly re-creating every node object and forcing the renderer to rebuild unchanged DOM
function reconcileIdentity(fresh: DeriveAccum, prev: DeriveAccum): void {
  const prevByKey = new Map<string, RenderNode | SubagentGroupNode>();
  for (const n of prev.topNodes) {
    prevByKey.set(nodeKey(n), n);
    if (n.type === "subagent") {
      for (const c of n.children) prevByKey.set(nodeKey(c), c);
    }
  }

  // Reuse the previous object for a leaf node when byte-equal; re-link it into the index maps.
  const reuseLeaf = (n: RenderNode): RenderNode => {
    const p = prevByKey.get(nodeKey(n));
    if (p && p.type === n.type && jsonEq(p, n)) {
      relinkNode(fresh, p);
      return p as RenderNode;
    }
    return n;
  };

  for (let i = 0; i < fresh.topNodes.length; i++) {
    const n = fresh.topNodes[i];
    if (n.type !== "subagent") {
      fresh.topNodes[i] = reuseLeaf(n);
      continue;
    }
    // Reconcile children first; then, if the whole group (with reconciled children) is byte-equal to
    // the previous group, reuse the previous group object too.
    for (let j = 0; j < n.children.length; j++) n.children[j] = reuseLeaf(n.children[j]);
    const p = prevByKey.get(nodeKey(n));
    if (p && p.type === "subagent" && jsonEq(p, n)) {
      fresh.topNodes[i] = p;
      fresh.groupsById.set(p.agentId, p);
      for (const c of p.children) relinkNode(fresh, c);
    }
  }
}

// Point the fresh accumulator's id-keyed indices at a reused (previous) node object, so a subsequent
// correlation / fold mutates the object that is actually in the tree.
function relinkNode(acc: DeriveAccum, node: RenderNode | SubagentGroupNode): void {
  if (node.type === "tool") acc.toolById.set(node.id, node);
  else if (node.type === "question_request") acc.questionNodesById.set(node.id, node);
}

function seqOf(ev: ModelEvent): number {
  return ev.seq;
}

function isStream(ev: ModelEvent): ev is AgentStream {
  // agent-stream frames carry one of the committed `kind` strings and no __event tag.
  return (
    !("__event" in ev) &&
    "kind" in ev &&
    ev.kind !== "tool_permission_requested"
  );
}

function isPermissionRequest(ev: ModelEvent): ev is ToolPermissionRequested {
  return (
    !("__event" in ev) &&
    "kind" in ev &&
    ev.kind === "tool_permission_requested"
  );
}
