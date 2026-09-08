# YUVIX OS

An operating system for an independent electronic music career.

Not a chatbot with a system prompt. YUVIX OS is an autonomous agent with planning,
tool use, structured memory, web research, an approval system and a persistent model of
your business — so you can give it an **outcome** ("grow Yuvix this year", "I have a
track out in four weeks") and it works out the steps, does what it safely can, and asks
you only when the decision is genuinely yours.

```
you ──▶ understand ──▶ recall ──▶ plan ──▶ select tools ──▶ act ──▶ verify ──▶ persist ──▶ report
                          ▲                                  │
                          └────────────── memory ◀────────────┘
```

## What it does

|  |  |
|---|---|
| **Agent core** | A real tool-calling loop over 73 tools, with planning, self-verification, structured tracing and cost accounting |
| **Memory** | Ten structured layers plus semantic search; facts and assumptions are stored and reported differently |
| **Music** | Tracks, releases, labels, DJ support, playlist placements, splits, metadata |
| **Campaigns** | A deterministic release-campaign engine: a phased timeline generated backwards from the release date and adapted to your real hours and budget |
| **CRM** | An industry pipeline with a follow-up queue that respects a quiet period, so it never pushes you into spamming anyone |
| **Content** | Pillars, a calendar, written hooks and captions, and performance analysis with honest sample sizes |
| **Business** | Income, expenses, per-release ROI, experiments |
| **Intelligence** | Nine detectors that raise opportunities, risks and bottlenecks — each carrying the evidence behind it |
| **Reviews** | Daily prioritisation with a reason per item and a capacity check; a weekly CEO review built only from recorded data |
| **Audio** | Real DSP: ITU-R BS.1770-4 LUFS, true peak, loudness range, stereo width, phase, mono compatibility, spectrum, BPM and key — explained in plain language |
| **Files** | An organised workspace the agent can read and write, with path containment |
| **Safety** | Three autonomy levels enforced in code, an approval inbox, and a full audit log |

## Quick start

```bash
npm install
cp .env.example .env          # then set AUTH_SECRET and ANTHROPIC_API_KEY
npm run setup                 # generate the client, create the database, seed the workspace
npm run dev                   # http://localhost:3000 — the first visit creates your account
npm run worker                # in a second terminal: background jobs and recurring reviews
```

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Configuration

Everything is environment-driven; no secret is ever hard-coded or logged.

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | yes | Signs session tokens |
| `DATABASE_URL` | yes | SQLite by default (`file:./yuvix.db`) |
| `ANTHROPIC_API_KEY` | for the agent | Without it, panels, records, reviews and audio analysis still work; chat returns a clear "not configured" message |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` | for research | Any one enables web research. Without one the agent says it cannot look things up rather than guessing |
| `YUVIX_WORKSPACE_DIR` | no | Where your files live (default `./workspace`) |
| `YUVIX_MODEL`, `YUVIX_FAST_MODEL` | no | Models for reasoning and for planning |
| `VOYAGE_API_KEY` | no | Better semantic recall; the default is a local lexical embedder that needs no network |

Platform integrations (Spotify, YouTube, SoundCloud, email, Instagram, TikTok) are
registered in the **System** panel with the exact variables each one needs. Until an
integration is connected it returns nothing and the agent says so.
**No integration is ever simulated.**

## Autonomy — enforced in code, not by prompting

| Level | Behaviour | Examples |
|---|---|---|
| **1 — automatic** | Runs immediately | Research, analysis, drafting, planning, creating internal records |
| **2 — approval** | Creates an approval request; the tool body cannot run until you approve, and the approval is fingerprinted to those exact arguments | Sending outreach, publishing content, moving files, deleting memories |
| **3 — never** | Has no execution path and is never exposed to the model | Signing contracts, transferring money |

A Level 2 action approved for one set of arguments cannot be replayed with different
ones — the executor recomputes the fingerprint before running. Every consequential
action is written to an audit log.

## Commands

`/today` `/week` `/goals` `/releases` `/content` `/research` `/labels` `/outreach`
`/contacts` `/analytics` `/finance` `/projects` `/strategy` `/memory` `/brainstorm`
`/analyze` `/plan` `/execute` `/review` — and plain language works everywhere.

## Audio analysis

Drop a WAV in `workspace/Music/Masters` and ask for an analysis. The engine measures
integrated LUFS (BS.1770-4, verified against the standard's reference tone to within
0.1 dB), short-term max, loudness range, a 4×-oversampled true peak, crest factor,
stereo width, phase correlation, mono compatibility, low-end width below 120 Hz, an
octave-band spectrum, clipping, and BPM/key with confidence values.

Findings come back in plain language — *"your sub is spread across the stereo field and
will lose power on a club system"* — not as a table of numbers. It is a measurement
engine, not a mastering certification, and it says so.

MP3/FLAC/M4A are not decoded; bounce a WAV, which is what you would send a label anyway.

## Development

```bash
npm run dev         # app
npm run worker      # background jobs
npm test            # DSP accuracy, autonomy enforcement, campaign engine, memory, path containment
npm run typecheck
npm run db:studio   # browse the database
```

## Moving to Postgres

Change `provider` to `"postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at
your database, and run `npm run db:push`. No model uses a SQLite-only feature.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
