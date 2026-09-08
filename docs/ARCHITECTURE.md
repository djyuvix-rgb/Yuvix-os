# YUVIX OS — architecture

## The problem this shape solves

An artist-business agent fails in two specific ways, and the architecture is built
around preventing both.

**It invents things.** A fabricated submission email, an imagined playlist curator or a
made-up stream count does real damage: a wasted opportunity, a burned relationship, a
decision made on fiction. So facts have provenance, integrations that are not connected
return nothing rather than something plausible, and detectors carry their evidence.

**It does something irreversible.** Sending a demo to the wrong label, publishing the
wrong post, spending money. So autonomy is enforced by the executor, not by asking the
model nicely.

Everything below follows from those two constraints.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 App Router, React 19, TypeScript | One deployable for UI, API and agent runtime |
| Data | Prisma + SQLite (Postgres-portable) | Zero infrastructure to start; no model uses a SQLite-only feature |
| Vector | Embeddings in-table, cosine in process | No extra service; `pgvector` swaps in behind one function |
| Model | Anthropic SDK, native tool use | Streaming, parallel tool calls, no framework in between |
| Jobs | Database-backed queue + worker process | Survives restarts; one thing to run and back up |
| Styling | Tailwind CSS v4 | No component library to fight |

Portability rule: the schema avoids native enums, scalar lists and the `Json` scalar.
Enum-like values are strings validated by Zod at the tool boundary
(`src/server/domain/constants.ts`); structured blobs are JSON text with codecs that
degrade to a default instead of throwing (`src/server/db/json.ts`).

## The agent loop

`src/server/agent/loop.ts`

```
run created (persisted)
  └─ business context assembled      memory/context.ts   — live snapshot, ~1–2k tokens
  └─ plan                            agent/planner.ts    — fast model, JSON steps
  └─ act ─┬─ model turn              agent/loop.ts
          ├─ tool calls              agent/executor.ts   — the single enforcement gate
          └─ repeat until no tool calls or the step ceiling
  └─ verify                          agent/prompt.ts     — one self-check pass, only if tools ran
  └─ persist result, steps, cost
  └─ report + stream to the client
```

Three decisions worth naming:

**The loop does not execute the plan.** The plan is passed as guidance and the model
re-decides after every tool result, so a plan invalidated by evidence is abandoned rather
than completed pointlessly.

**The context snapshot is a map, not the data.** It lists what exists with ids; detail
comes from tools. That keeps runs cheap and stops the model answering from a stale
snapshot.

**Verification runs once, and only when the run actually did something.** A plain
question does not need it; a run that created twelve tasks does.

## Autonomy enforcement

`src/server/agent/executor.ts` is the only path from a tool name to a tool body, and it
enforces in this order:

1. **Existence** — unknown tool → recoverable error
2. **Schema** — Zod parse → recoverable error naming the bad field
3. **Autonomy**
   - Level 3: no execution path exists, and the tool is never in the model's tool list
   - Level 2: requires an `Approval` row with `status: "approved"` whose stored
     fingerprint matches `sha256(tool + stable-stringified args)`. Without one, an
     approval is created and the call returns "awaiting approval" — the tool body does
     not run
   - Level 1: executes
4. **Execute** — timed, traced, audited

The fingerprint uses a key-order-independent stable stringify, so an approval granted for
one action cannot be replayed with different arguments.

Registration itself is guarded: a Level 2 tool without a `preview()` and a Level 3 tool
without a `forbiddenReason` throw at startup rather than shipping a silent hole.

## Memory

Ten layers (`profile`, `artist`, `business`, `crm`, `project`, `task`, `decision`,
`campaign`, `performance`, `semantic`).

Structured domain rows are the source of truth for anything with a shape — releases,
contacts, tasks, finance. `MemoryItem` holds what has no table: lessons, preferences,
decision context, research conclusions — plus `entityType`/`entityId` pointers so one
recall surfaces both.

**Recall is hybrid.** A lexical prefilter in SQL bounds the candidate set, then cosine
re-ranking runs in process, blended with lexical overlap, a 90-day recency half-life and
stored confidence. The vector store is isolated in one function; moving to `pgvector`
touches `memory/store.ts` and nothing else.

**Facts and assumptions are different objects.** `kind: "fact"` defaults to 0.9
confidence, `kind: "assumption"` to 0.45, and the prompt requires them to be reported
differently. Corrections archive the old row with `supersededById` rather than deleting
it.

**Embeddings default to local.** A deterministic hashed n-gram embedder (word unigrams,
bigrams, character 4-grams, L2-normalised) means semantic memory works with no network
and no cost. `VOYAGE_API_KEY` swaps in genuine semantic vectors when retrieval quality
matters more than zero setup.

## Tools

73 tools in `src/server/tools/`, grouped: memory, goals, projects, music, crm, content,
campaign, finance, analytics, research, files, audio, intelligence, system.

Descriptions are written for the model and carry judgement, not just mechanics — when to
use the tool, what to do first, and what would be a misuse. `label_upsert` says to record
submission details only from research actually performed; `content_create` says a hook is
the first two seconds and must earn attention on its own; `crm_follow_up_queue` explains
why it excludes people contacted recently.

Read-only tools are marked and skip audit writes. Level 2 tools carry `preview()`, which
renders exactly what the operator is approving.

## Campaign engine

`src/server/campaign/generator.ts` — deliberately deterministic code, not a model call.

A release plan that silently drops the distribution deadline because a model was creative
is a real business failure. So the 29-step template lives in code with per-task rationale,
impact and effort, and the engine:

- Scales pre-release offsets to the actual lead time instead of truncating, preserving
  dependency order
- Drops tasks whose resource does not exist (no budget → no paid promotion) and reports
  what it dropped and why
- Checks total effort against the artist's stated weekly hours and warns when the plan
  does not fit
- Creates a project, phased stages and dated tasks in one pass

The agent supplies the judgement on top: targets, copy, and which labels to approach.

## Proactive intelligence

`src/server/intelligence/detectors.ts` — nine deterministic rules over data the system
actually holds:

release without a campaign · outreach gone silent · content-format signal · spend without
attributable return · release cadence · overdue bottleneck · shelved finished music ·
researched-but-unapproached labels · goals behind pace

Every insight carries typed evidence. A rule that would need data the system cannot see
(live Spotify numbers, ad-platform spend) does not exist — the system says it cannot see
that instead of implying it is watching. `dedupeKey` embeds a time bucket, so a standing
problem resurfaces on a sensible cadence rather than daily or never.

Sample sizes are reported honestly: a content-format finding from three posts is labelled
anecdotal, not presented as a strategy.

## Reviews

`daily_priorities` scores explicitly — urgency from due date (steep once overdue), impact,
parent-project priority, quick-win bonus — so ordering is stable and explainable, and
every item carries its reason. Tasks blocked by unfinished dependencies are excluded.
The list is checked against daily capacity derived from the artist's stated weekly hours.

`weekly_review` builds "what happened / what matters / what worked / what failed / what I
learned / what to do next / top 5" strictly from recorded data. Empty sections stay empty:
where nothing was measured, that emptiness is the finding.

## Audio

`src/server/audio/` — a real DSP chain, dependency-free.

- `wav.ts` — RIFF/WAVE for PCM 16/24/32-bit, float 32/64, `WAVE_FORMAT_EXTENSIBLE`
- `dsp.ts` — biquads, K-weighting filters designed for the actual sample rate, iterative
  radix-2 FFT, correlation
- `loudness.ts` — BS.1770-4 integrated loudness with the absolute −70 LUFS and relative
  −10 LU gates, EBU R128 loudness range, 4× oversampled true peak
- `analyze.ts` — stereo geometry, spectrum, clipping, spectral-flux BPM with parabolic
  peak refinement, Krumhansl-Kessler key detection with Camelot mapping, and the rule set
  that turns numbers into findings

Two accuracy notes: coefficients are derived per sample rate, so 44.1 kHz measures
correctly rather than being treated as 48 kHz; and true peak interpolates only around
near-peak samples, which makes a full-track measurement tractable without changing the
result. A −20 dBFS 1 kHz tone measures −19.99 LUFS, verified in the test suite.

BPM below 0.25 confidence returns `null`. A number the analyser cannot actually detect is
an invented number.

## Safety

- **Auth** — scrypt password hashing, random session tokens stored only as hashes, first
  run creates the owner (no default credentials), every data route asserts a session
- **Secrets** — read only in `src/server/env.ts`, never persisted, never returned to the
  client; the logger redacts any key matching `key|secret|password|token|auth|cookie`
- **Path containment** — every workspace path resolves against the root and is rejected if
  it escapes, so no tool argument or fetched page can reach the host filesystem
- **SSRF** — `research/fetch.ts` refuses non-HTTP protocols and private, loopback and
  cloud-metadata addresses
- **Audit** — every tool execution, block, approval request and decision is recorded
- **Rendering** — agent output goes through a small markdown renderer with no
  `dangerouslySetInnerHTML`, so model output can never become markup

## Jobs

A `Job` table with optimistic locking (`updateMany` on the queued row), exponential
backoff, attempt limits and stale-lock reclamation. Recurring work — insight scans every
12 hours, the weekly review, approval expiry — re-queues only when nothing is pending, so
restarts cannot pile up duplicates. Handlers: `insights.scan`, `review.weekly`,
`agent.run`, `approvals.expire`.

## Layout

```
prisma/schema.prisma          34 models
src/server/
  agent/      loop, planner, executor, registry, prompt, client, types
  memory/     store, context, embeddings
  tools/      13 modules, 73 tools
  research/   providers (Brave/Tavily/Serper), page fetch + extraction
  audio/      wav, dsp, loudness, analyze
  campaign/   generator
  intelligence/ detectors, reviews
  jobs/       queue, handlers, worker-entry
  files/      workspace
  auth/       session, bootstrap
  integrations/ registry
src/app/      routes + API
src/components/ Shell, Chat, Panels, markdown
tests/        DSP accuracy, autonomy, campaign engine, memory, containment
```

## What is deliberately not built

- **No fake integrations.** Spotify, Instagram and TikTok are registered with their real
  requirements and return nothing until connected.
- **No scraping of platforms that forbid it.** Where an API is restricted, the setup notes
  say so.
- **No auto-send.** Even with an email integration connected, delivery requires an
  approval.
- **No invented benchmarks.** The system will not tell you what a "good" first-week stream
  count is without data to ground it.
