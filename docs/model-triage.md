# Model triage for the multiplan pipeline

An auditable justification for the per-plan model-triage mapping used by the
claude-multiplan app. The pipeline exposes each node's task **domain**
structurally, so the model chosen for a node can be decided deterministically
from `(stage, phase)` (plus the sizer's `scale`) without any LLM or keyword
classification.

## 1. The three models — per-domain benchmarks

| Domain / benchmark | Sonnet 5 | Opus 4.8 | Fable 5 |
|---|---|---|---|
| Agentic coding — SWE-bench Pro | 63.2 | 69.2 | **80.3** |
| SWE-bench Verified | — | — | **95.0** |
| Terminal-Bench 2.1 | 80.4 | ~74.6 | **88.0** |
| Frontier coding — FrontierCode Diamond | — | 13.4 | **29.3** |
| Math — USAMO | 79.5 | **96.7** | saturated (retired) |
| Deep reasoning — HLE (no tools) | 43.2 | **49.8** | — |
| Deep reasoning — HLE (with tools) | 57.4 | 57.9 | **64.5** |
| Web research — BrowseComp | **84.7 (@ ~1/3 token cost of Opus)** | 84.7 | — |
| Computer use — OSWorld-Verified | 81.2 | 83.4 | **85.0** |
| Cost $/M (input / output) | 3 / 15 (intro 2/10) | 5 / 25 | 10 / 50 |
| Relative speed | fastest | mid | slowest |

Some Fable 5 figures are vendor-stated.

## 2. Reading the benchmarks

- **Opus 4.8 wins deep math and reasoning.** It tops USAMO (96.7 vs Sonnet's
  79.5) and HLE without tools (49.8 vs 43.2). When a node's job is to reason
  hard rather than to type code fast, Opus is the pick.
- **Sonnet 5 is the cost-efficient agentic pick.** It matches Opus on
  BrowseComp web research (84.7) at roughly one-third the token cost, stays
  within ~6 points on coding benchmarks at 40–60% lower cost, and is the
  fastest of the three. Anthropic recommends Sonnet 5 for most agentic coding.
- **Fable 5 is the most capable AND the most expensive model.** At $10/$50 and
  the slowest of the three, it is built for frontier, long-horizon, multi-day
  autonomous coding: it nearly doubles Opus on FrontierCode Diamond (29.3 vs
  13.4), and its lead grows with task length. It is **not** a lightweight or
  fast model. This corrects an earlier prototype assumption that reached for
  "Fable 5 auto" on a trivial "regenerate goldens" task — exactly the kind of
  short, cheap job Fable is wrong for.

## 3. Deterministic, domain-aware triage mapping

The multiplan pipeline already tells us each node's domain: it is encoded
structurally in the node's `(stage, phase)` and, for leaf coding work, in the
sizer's `scale` verdict. No classifier is needed — the mapping is a lookup.

| Domain | Node `(stage, phase)` | Model / effort | Rationale |
|---|---|---|---|
| Visual prototyping / intent | `open/clarifying-intent`, `open/prototype-review` | Sonnet 5 / high | fast + cheap throwaway UI iteration; near-Opus coding |
| Web research / codebase recon | `open/recon` | Sonnet 5 / high | BrowseComp parity with Opus at ~1/3 token cost |
| Deep reasoning — sizing, decomposition, plan authoring, parent-review | `open/sizing`, `open/decomposing`, `open/awaiting-decomposition-approval`, `leaf/drafting`, `leaf/awaiting-approval`, `split/reviewing` | Opus 4.8 / high | leads math & reasoning |
| Coding execution — standard single | `leaf/executing`, sizer `scale: standard` | Sonnet 5 / medium | near-Opus coding at far lower cost/latency |
| Coding execution — large single | `leaf/executing`, sizer `scale: large` | Opus 4.8 / high | strong coder, cheaper/faster than Fable |
| Coding execution — huge single | `leaf/executing`, sizer `scale: huge` | Fable 5 / high | frontier/long-horizon; lead grows with task length |

## 4. Why the leaf coding model comes from the sizer's `scale`

The app decomposes aggressively. Anything large-and-decomposable becomes a
`split` — routed to Opus for decomposition — with smaller leaf children, so
frontier-scale coding rarely lands on a single leaf. Fable's real home is a
cohesive `single` sub-plan that the sizer deliberately chose **not** to split.

The sizer already assesses scope (from recon) and emits a 3-way `scale`
verdict that routes the leaf coding model directly:

- `scale: standard` → Sonnet 5 (near-Opus coding, far lower cost/latency)
- `scale: large` → Opus 4.8 (strong coder, cheaper and faster than Fable)
- `scale: huge` → Fable 5 (frontier / long-horizon; its lead grows with length)

A `split` verdict is never a coding leaf — it is always decomposition, and
therefore always Opus.

## 5. Runtime precedence & known limitations

### 5.1 Active-node model precedence

Every **active** node's runtime model is resolved by domain triage, not by the
global header picker. `effectiveModel(node)` is the node's explicit override if
one is set, else `phaseModel(node)` — the deterministic `(stage, phase)` domain
model. A `leaf/executing` node carrying no stamp defaults to the Sonnet 5 /
medium *coding* default, **not** the global header pick.

The global header picker (`resolveModelOptions()`) is the fallback **only**
where the orchestrator passes no per-node model: terminal / acceptance-window
dispatches that have no active node, and any adapter caller that omits
`execution`.

A consequence worth stating plainly: a resumed pre-feature (legacy) ledger that
lands on a stampless leaf therefore runs on the domain **coding default**
(Sonnet 5 / medium) rather than the header pick. Legacy runs keep working — but
their model is domain-triaged, not the old global pick. This is a deliberate
reconciliation: domain-aware defaults beat a stale global pick.

### 5.2 Effort is session-level

The runtime applies per-plan models through the SDK's `Query.setModel(model?)`,
which switches the **model only**, not the reasoning effort. Effort is
therefore established once at session start and does not change per phase. In
practice a Sonnet coding phase whose nominal effort is `medium` actually runs
at the session effort — a valid, if slightly over-powered, configuration.

Session effort is **genesis-high on a fresh run, the resumed node's effort on a
resume.** On resume / quota-resume the session effort is re-established from the
*resumed* node's stamped effort (e.g. a standard-scale leaf resumes at Sonnet 5
/ medium). Because `setModel` is model-only, that effort then persists across
the rest of the resumed run.

Full per-phase `{model, effort}` fidelity would require ending and resuming the
session (a respawn) at each phase boundary, which risks context loss. That
tradeoff is deliberately not taken; model-only switching is the accepted
behavior.

## Sources

- [Claude Sonnet 5 announcement](https://www.anthropic.com/news/claude-sonnet-5) — Sonnet 5 positioning, agentic-coding recommendation, pricing.
- [Claude Fable 5 / Mythos 5 announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5) — Fable 5 as the frontier long-horizon model.
- [Introducing Claude Fable 5 and Claude Mythos 5 (docs)](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5) — Fable 5 benchmark figures and intended use.
- [Sonnet 5 vs Opus 4.8 (llm-stats)](https://llm-stats.com/blog/research/claude-sonnet-5-vs-claude-opus-4-8) — head-to-head reasoning/coding comparison.
- [Sonnet 5 vs Sonnet 4.6 vs Opus 4.8 agentic-coding benchmarks (MarkTechPost)](https://www.marktechpost.com/2026/06/30/anthropic-claude-sonnet-5-vs-sonnet-4-6-vs-opus-4-8-agentic-coding-benchmarks-api-pricing-and-cost-performance-tradeoffs-compared/) — coding benchmarks, API pricing, cost/performance tradeoffs.
- [Sonnet 5 / Opus 4.8 / Fable 5 — when to use which (Digital Applied)](https://www.digitalapplied.com/blog/claude-sonnet-5-opus-4-8-fable-5-when-to-use-which-2026) — practical model-selection guidance across the three models.
