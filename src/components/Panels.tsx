"use client";

import { useEffect, useState } from "react";
import { Markdown } from "./markdown";

export type PanelKey =
  | "today" | "projects" | "releases" | "contacts" | "analytics"
  | "finance" | "content" | "music" | "strategy" | "memory" | "approvals" | "system";

const fetchJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
};

export function Panel({ panel, refreshKey, onChanged }: { panel: PanelKey; refreshKey: number; onChanged: () => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const url =
      panel === "today" ? "/api/dashboard"
        : panel === "approvals" ? "/api/approvals"
          : panel === "system" ? "/api/integrations"
            : `/api/panels?panel=${panel}`;

    fetchJson<Record<string, unknown>>(url)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [panel, refreshKey]);

  if (loading && !data) return <Muted>Loading…</Muted>;
  if (error) return <Muted tone="danger">{error}</Muted>;
  if (!data) return null;

  switch (panel) {
    case "today": return <Today data={data} />;
    case "approvals": return <Approvals data={data} onChanged={onChanged} />;
    case "projects": return <Projects data={data} />;
    case "releases": return <Releases data={data} />;
    case "contacts": return <Contacts data={data} />;
    case "content": return <Content data={data} />;
    case "finance": return <Finance data={data} />;
    case "analytics": return <Analytics data={data} />;
    case "music": return <Music data={data} />;
    case "strategy": return <Strategy data={data} />;
    case "memory": return <Memory data={data} />;
    case "system": return <System data={data} />;
  }
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function Muted({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <p className={`px-4 py-6 text-xs ${tone === "danger" ? "text-[var(--color-danger)]" : "text-[var(--color-text-faint)]"}`}>
      {children}
    </p>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        {title}
        {count != null && <span className="text-[var(--color-text-faint)]">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-[var(--color-text-faint)]">{children}</p>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="card mb-1.5 px-3 py-2 text-xs">{children}</div>;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/* ── panels ──────────────────────────────────────────────────────────────── */

function Today({ data }: { data: Record<string, unknown> }) {
  const priorities = obj(data.priorities);
  const items = arr<Record<string, unknown>>(priorities.items);
  const counters = obj(data.counters);
  const artist = data.artist ? obj(data.artist) : null;
  const system = obj(data.system);

  return (
    <div>
      {artist && (
        <div className="card mb-4 p-3">
          <div className="text-sm font-semibold">{String(artist.name)}</div>
          {artist.tagline ? <div className="mt-0.5 text-xs text-[var(--color-text-dim)]">{String(artist.tagline)}</div> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {arr<string>(artist.genres).map((g) => <span key={g} className="pill">{g}</span>)}
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Open tasks" value={num(counters.openTasks)} />
        <Stat label="Overdue" value={num(counters.overdueTasks)} tone={num(counters.overdueTasks) > 0 ? "warn" : undefined} />
        <Stat label="Approvals" value={num(counters.pendingApprovals)} tone={num(counters.pendingApprovals) > 0 ? "accent" : undefined} />
      </div>

      {!system.agentConfigured && (
        <div className="card mb-4 border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] p-3 text-xs">
          <div className="font-medium text-[var(--color-warn)]">The agent has no model access</div>
          <p className="mt-1 text-[var(--color-text-dim)]">
            Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code> and restart. Everything else here still works.
          </p>
        </div>
      )}

      <Section title="Today" count={items.length}>
        {items.length === 0 ? (
          <Empty>{arr<string>(priorities.notes)[0] ?? "Nothing scheduled."}</Empty>
        ) : (
          items.map((item, i) => (
            <Row key={String(item.id)}>
              <div className="flex items-start gap-2">
                <span className="mt-px w-4 shrink-0 text-[var(--color-text-faint)]">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{String(item.title)}</div>
                  <div className="mt-1 leading-relaxed text-[var(--color-text-dim)]">{String(item.why)}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span className="pill">{String(item.type)}</span>
                    {item.dueDate && item.dueDate !== "—" ? <span className="pill">due {String(item.dueDate)}</span> : null}
                    {item.effortMin ? <span className="pill">{String(item.effortMin)}m</span> : null}
                  </div>
                </div>
              </div>
            </Row>
          ))
        )}
        {arr<string>(priorities.notes).map((n, i) => (
          <p key={i} className="mt-2 text-[11px] italic text-[var(--color-warn)]">{n}</p>
        ))}
      </Section>

      <Section title="Insights" count={arr(data.insights).length}>
        {arr<Record<string, unknown>>(data.insights).length === 0 ? (
          <Empty>No open insights. Run insights_scan from chat to check for new ones.</Empty>
        ) : (
          arr<Record<string, unknown>>(data.insights).map((i) => (
            <Row key={String(i.id)}>
              <div className="flex items-center gap-2">
                <span className={`pill ${num(i.severity) <= 2 ? "pill-danger" : "pill-warn"}`}>{String(i.kind)}</span>
                <span className="font-medium">{String(i.title)}</span>
              </div>
              <p className="mt-1 leading-relaxed text-[var(--color-text-dim)]">{String(i.body)}</p>
              {arr<Record<string, unknown>>(i.evidence).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {arr<Record<string, unknown>>(i.evidence).map((e, k) => (
                    <span key={k} className="pill">{String(e.label)}: {String(e.value)}</span>
                  ))}
                </div>
              )}
            </Row>
          ))
        )}
      </Section>

      <Section title="Upcoming releases" count={arr(data.releases).length}>
        {arr<Record<string, unknown>>(data.releases).length === 0 ? (
          <Empty>Nothing scheduled in the next 30 days.</Empty>
        ) : (
          arr<Record<string, unknown>>(data.releases).map((r) => (
            <Row key={String(r.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{String(r.title)}</span>
                <span className="text-[var(--color-text-faint)]">{String(r.releaseDate)} · {String(r.daysAway)}d</span>
              </div>
              <div className="mt-1">
                {r.hasCampaign ? <span className="pill pill-ok">campaign active</span> : <span className="pill pill-danger">no campaign</span>}
              </div>
            </Row>
          ))
        )}
      </Section>

      <Section title="Goals" count={arr(data.goals).length}>
        {arr<Record<string, unknown>>(data.goals).length === 0 ? (
          <Empty>No goals set. Ask the agent to build your goal hierarchy.</Empty>
        ) : (
          arr<Record<string, unknown>>(data.goals).map((g) => (
            <Row key={String(g.id)}>
              <div className="flex items-center justify-between gap-2">
                <span><span className="pill mr-2">{String(g.level)}</span>{String(g.title)}</span>
                {g.pct != null && <span className="text-[var(--color-text-faint)]">{String(g.pct)}%</span>}
              </div>
              {g.pct != null && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.min(100, num(g.pct))}%` }} />
                </div>
              )}
            </Row>
          ))
        )}
      </Section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" | "accent" }) {
  return (
    <div className="card px-3 py-2">
      <div className={`text-lg font-semibold ${tone === "warn" ? "text-[var(--color-warn)]" : tone === "accent" ? "text-[#b9a6ff]" : ""}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
    </div>
  );
}

function Approvals({ data, onChanged }: { data: Record<string, unknown>; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const approvals = arr<Record<string, unknown>>(data.approvals);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    try {
      await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  return (
    <div>
      <Section title="Waiting on you" count={pending.length}>
        {pending.length === 0 ? (
          <Empty>Nothing needs your approval. Level 2 actions — sending messages, publishing, spending — appear here before they happen.</Empty>
        ) : (
          pending.map((a) => (
            <div key={String(a.id)} className="card mb-2 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{String(a.title)}</span>
                <span className="pill pill-warn">{String(a.tool)}</span>
              </div>
              <p className="mt-1 text-[var(--color-text-dim)]">{String(a.description)}</p>
              {arr<string>(a.details).length > 0 && (
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg)] p-2 text-[11px] leading-relaxed text-[var(--color-text-dim)]">
                  {arr<string>(a.details).join("\n")}
                </pre>
              )}
              {a.riskNotes ? <p className="mt-2 text-[11px] text-[var(--color-warn)]">⚠ {String(a.riskNotes)}</p> : null}
              <div className="mt-3 flex gap-2">
                <button className="btn btn-ok" disabled={busy === a.id} onClick={() => decide(String(a.id), "approve")}>Approve & run</button>
                <button className="btn btn-danger" disabled={busy === a.id} onClick={() => decide(String(a.id), "reject")}>Reject</button>
              </div>
            </div>
          ))
        )}
      </Section>

      {decided.length > 0 && (
        <Section title="History" count={decided.length}>
          {decided.map((a) => (
            <Row key={String(a.id)}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{String(a.title)}</span>
                <span className={`pill ${a.status === "executed" ? "pill-ok" : a.status === "rejected" ? "pill-danger" : ""}`}>{String(a.status)}</span>
              </div>
            </Row>
          ))}
        </Section>
      )}
    </div>
  );
}

function Projects({ data }: { data: Record<string, unknown> }) {
  const projects = arr<Record<string, unknown>>(data.projects);
  const tasks = arr<Record<string, unknown>>(data.tasks);
  return (
    <div>
      <Section title="Projects" count={projects.length}>
        {projects.length === 0 ? <Empty>No active projects.</Empty> : projects.map((p) => (
          <Row key={String(p.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(p.name)}</span>
              <span className="text-[var(--color-text-faint)]">{String(p.done)}/{String(p.total)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="pill">{String(p.type)}</span>
              <span className="pill">P{String(p.priority)}</span>
              {p.goal ? <span className="pill pill-accent">{String(p.goal)}</span> : null}
              {p.dueDate ? <span className="pill">due {String(p.dueDate)}</span> : null}
            </div>
          </Row>
        ))}
      </Section>
      <Section title="Open tasks" count={tasks.length}>
        {tasks.length === 0 ? <Empty>No open tasks.</Empty> : tasks.map((t) => (
          <Row key={String(t.id)}>
            <div className="flex items-start justify-between gap-2">
              <span className={t.overdue ? "text-[var(--color-warn)]" : ""}>{String(t.title)}</span>
              {t.dueDate ? <span className="shrink-0 text-[var(--color-text-faint)]">{String(t.dueDate)}</span> : null}
            </div>
            {t.rationale ? <p className="mt-1 text-[var(--color-text-faint)]">{String(t.rationale)}</p> : null}
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Releases({ data }: { data: Record<string, unknown> }) {
  const releases = arr<Record<string, unknown>>(data.releases);
  const tracks = arr<Record<string, unknown>>(data.tracks);
  return (
    <div>
      <Section title="Releases" count={releases.length}>
        {releases.length === 0 ? <Empty>No releases recorded.</Empty> : releases.map((r) => (
          <Row key={String(r.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(r.title)}</span>
              <span className="text-[var(--color-text-faint)]">{String(r.releaseDate ?? "—")}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="pill">{String(r.status)}</span>
              <span className="pill">{String(r.label)}</span>
              {num(r.djSupports) > 0 ? <span className="pill pill-ok">{String(r.djSupports)} DJ supports</span> : null}
              {num(r.playlists) > 0 ? <span className="pill pill-ok">{String(r.playlists)} playlists</span> : null}
            </div>
          </Row>
        ))}
      </Section>
      <Section title="Tracks" count={tracks.length}>
        {tracks.length === 0 ? <Empty>No tracks recorded yet.</Empty> : tracks.map((t) => (
          <Row key={String(t.id)}>
            <div className="flex items-center justify-between gap-2">
              <span>{String(t.title)}</span>
              <span className="pill">{String(t.status)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[var(--color-text-faint)]">
              {t.genre ? <span>{String(t.genre)}</span> : null}
              {t.bpm ? <span>{String(t.bpm)} BPM</span> : null}
              {t.key ? <span>{String(t.key)}</span> : null}
              {t.deadline ? <span>deadline {String(t.deadline)}</span> : null}
            </div>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Contacts({ data }: { data: Record<string, unknown> }) {
  const contacts = arr<Record<string, unknown>>(data.contacts);
  const labels = arr<Record<string, unknown>>(data.labels);
  const outreach = arr<Record<string, unknown>>(data.outreach);
  return (
    <div>
      <Section title="Contacts" count={contacts.length}>
        {contacts.length === 0 ? <Empty>CRM is empty. Ask the agent to research and add the people who matter.</Empty> : contacts.map((c) => (
          <Row key={String(c.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(c.name)}</span>
              <span className={`pill ${c.due ? "pill-warn" : ""}`}>{String(c.status)}</span>
            </div>
            <div className="mt-0.5 text-[var(--color-text-dim)]">
              {[c.role, c.company].filter(Boolean).map(String).join(" · ")}
            </div>
            {c.nextAction ? <div className="mt-1 text-[var(--color-text-faint)]">Next: {String(c.nextAction)} {c.nextActionAt ? `(${String(c.nextActionAt)})` : ""}</div> : null}
          </Row>
        ))}
      </Section>
      <Section title="Labels" count={labels.length}>
        {labels.length === 0 ? <Empty>No labels researched yet.</Empty> : labels.map((l) => (
          <Row key={String(l.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(l.name)}</span>
              {l.fitScore != null ? <span className="pill pill-accent">fit {Math.round(num(l.fitScore))}</span> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              <span className="pill">{String(l.status)}</span>
              {l.tier ? <span className="pill">{String(l.tier)}</span> : null}
            </div>
            {l.fitRationale ? <p className="mt-1 text-[var(--color-text-faint)]">{String(l.fitRationale)}</p> : null}
          </Row>
        ))}
      </Section>
      {outreach.length > 0 && (
        <Section title="Outreach drafts" count={outreach.length}>
          {outreach.map((o) => (
            <Row key={String(o.id)}>
              <div className="flex items-center justify-between gap-2">
                <span>{String(o.target)}</span>
                <span className={`pill ${o.status === "sent" ? "pill-ok" : ""}`}>{String(o.status)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[var(--color-text-faint)]">{String(o.body).slice(0, 400)}</p>
            </Row>
          ))}
        </Section>
      )}
    </div>
  );
}

function Content({ data }: { data: Record<string, unknown> }) {
  const pieces = arr<Record<string, unknown>>(data.pieces);
  const pillars = arr<Record<string, unknown>>(data.pillars);
  return (
    <div>
      {pillars.length > 0 && (
        <Section title="Content pillars" count={pillars.length}>
          {pillars.map((p) => (
            <Row key={String(p.id)}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{String(p.name)}</span>
                <span className="pill">{String(p.sharePct)}%</span>
              </div>
              {p.description ? <p className="mt-1 text-[var(--color-text-faint)]">{String(p.description)}</p> : null}
            </Row>
          ))}
        </Section>
      )}
      <Section title="Content" count={pieces.length}>
        {pieces.length === 0 ? <Empty>No content planned. Ask for a content plan built on what has actually worked.</Empty> : pieces.map((c) => (
          <Row key={String(c.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(c.title)}</span>
              <span className="pill">{String(c.status)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1.5 text-[var(--color-text-faint)]">
              <span>{String(c.platform)}/{String(c.format)}</span>
              {c.scheduledFor ? <span>· {String(c.scheduledFor)}</span> : null}
              {c.pillar ? <span>· {String(c.pillar)}</span> : null}
            </div>
            {c.hook ? <p className="mt-1.5 text-[var(--color-text-dim)]">Hook: {String(c.hook)}</p> : null}
            {c.performance ? (
              <div className="mt-1.5 flex gap-1.5">
                <span className="pill">{String(obj(c.performance).views ?? 0)} views</span>
                <span className="pill">{String(obj(c.performance).likes ?? 0)} likes</span>
              </div>
            ) : null}
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Finance({ data }: { data: Record<string, unknown> }) {
  const totals = obj(data.totals);
  const byMonth = arr<Record<string, unknown>>(data.byMonth);
  const entries = arr<Record<string, unknown>>(data.entries);
  const max = Math.max(1, ...byMonth.map((m) => Math.max(num(m.income), num(m.expense))));

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Income" value={`€${num(totals.income).toFixed(0)}`} />
        <Stat label="Expenses" value={`€${num(totals.expense).toFixed(0)}`} />
        <Stat label="Profit" value={`€${num(totals.profit).toFixed(0)}`} tone={num(totals.profit) < 0 ? "warn" : undefined} />
      </div>

      {byMonth.length > 0 && (
        <Section title="By month">
          <div className="card p-3">
            {byMonth.map((m) => (
              <div key={String(m.month)} className="mb-2 last:mb-0">
                <div className="mb-1 flex justify-between text-[11px] text-[var(--color-text-faint)]">
                  <span>{String(m.month)}</span>
                  <span>€{num(m.income).toFixed(0)} / €{num(m.expense).toFixed(0)}</span>
                </div>
                <div className="flex gap-1">
                  <div className="h-1.5 rounded-full bg-[var(--color-ok)]" style={{ width: `${(num(m.income) / max) * 50}%` }} />
                  <div className="h-1.5 rounded-full bg-[var(--color-danger)]" style={{ width: `${(num(m.expense) / max) * 50}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Entries" count={entries.length}>
        {entries.length === 0 ? <Empty>No income or expenses recorded. Tell the agent what you earned and spent and it will track ROI per release.</Empty> : entries.map((e) => (
          <Row key={String(e.id)}>
            <div className="flex items-center justify-between gap-2">
              <span>{String(e.description ?? e.category)}</span>
              <span className={e.direction === "income" ? "text-[var(--color-ok)]" : "text-[var(--color-danger)]"}>
                {e.direction === "income" ? "+" : "−"}€{num(e.amountEur).toFixed(2)}
              </span>
            </div>
            <div className="mt-0.5 text-[var(--color-text-faint)]">{String(e.category)} · {String(e.occurredAt)}</div>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Analytics({ data }: { data: Record<string, unknown> }) {
  const series = arr<Record<string, unknown>>(data.series);
  const content = arr<Record<string, unknown>>(data.content);
  return (
    <div>
      {data.note ? <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-faint)]">{String(data.note)}</p> : null}
      <Section title="Metrics" count={series.length}>
        {series.length === 0 ? <Empty>No measurements recorded.</Empty> : series.map((s) => {
          const points = arr<Record<string, unknown>>(s.points);
          const latest = points[points.length - 1];
          const first = points[0];
          const delta = points.length > 1 ? num(latest.value) - num(first.value) : null;
          return (
            <Row key={String(s.key)}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[var(--color-text-dim)]">{String(s.key)}</span>
                <span className="font-medium">{num(latest?.value).toLocaleString()}</span>
              </div>
              <div className="mt-0.5 text-[var(--color-text-faint)]">
                {points.length} measurement{points.length === 1 ? "" : "s"}
                {delta != null && <span className={delta >= 0 ? " text-[var(--color-ok)]" : " text-[var(--color-danger)]"}> · {delta >= 0 ? "+" : ""}{delta.toLocaleString()}</span>}
              </div>
            </Row>
          );
        })}
      </Section>
      <Section title="Content performance" count={content.length}>
        {content.length === 0 ? <Empty>No content performance logged.</Empty> : content.map((c) => (
          <Row key={String(c.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{String(c.title)}</span>
              <span>{num(c.views).toLocaleString()} views</span>
            </div>
            <div className="mt-0.5 text-[var(--color-text-faint)]">{String(c.platform)}/{String(c.format)} · {String(c.publishedAt ?? "—")}</div>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Music({ data }: { data: Record<string, unknown> }) {
  const analyses = arr<Record<string, unknown>>(data.analyses);
  const files = arr<Record<string, unknown>>(data.files);
  return (
    <div>
      <Section title="Audio analyses" count={analyses.length}>
        {analyses.length === 0 ? (
          <Empty>
            No analyses yet. Put a WAV in <code>workspace/Music/Masters</code> and ask the agent to analyse it — it measures LUFS, true peak, dynamics, stereo width and phase, and explains what they mean.
          </Empty>
        ) : analyses.map((a) => (
          <Row key={String(a.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(a.track)}</span>
              <span className="text-[var(--color-text-faint)]">{String(a.at)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {a.lufs != null ? <span className="pill">{String(a.lufs)} LUFS</span> : null}
              {a.truePeak != null ? <span className="pill">{String(a.truePeak)} dBTP</span> : null}
              {a.crest != null ? <span className="pill">crest {String(a.crest)}</span> : null}
              {a.phase != null ? <span className="pill">phase {String(a.phase)}</span> : null}
            </div>
            {a.summary ? <p className="mt-1.5 text-[var(--color-text-dim)]">{String(a.summary)}</p> : null}
            {arr<Record<string, unknown>>(a.issues).filter((i) => i.severity !== "info").map((i, k) => (
              <p key={k} className="mt-1 text-[var(--color-warn)]">⚠ {String(i.message)}</p>
            ))}
          </Row>
        ))}
      </Section>
      <Section title="Music files" count={files.length}>
        {files.length === 0 ? <Empty>No files in the Music workspace folder.</Empty> : files.map((f) => (
          <Row key={String(f.path)}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px]">{String(f.path)}</span>
              <span className="shrink-0 text-[var(--color-text-faint)]">{String(f.sizeKb)} KB</span>
            </div>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function Strategy({ data }: { data: Record<string, unknown> }) {
  const goals = arr<Record<string, unknown>>(data.goals);
  const decisions = arr<Record<string, unknown>>(data.decisions);
  const review = data.latestReview ? obj(data.latestReview) : null;
  const roots = goals.filter((g) => !g.parentId);
  const childrenOf = (id: unknown) => goals.filter((g) => g.parentId === id);

  return (
    <div>
      <Section title="Goal hierarchy" count={goals.length}>
        {goals.length === 0 ? <Empty>No goals yet. Ask: “build my goal hierarchy for this year”.</Empty> : roots.map((g) => (
          <div key={String(g.id)} className="mb-2">
            <Row>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{String(g.title)}</span>
                <span className="pill">{String(g.level)}</span>
              </div>
            </Row>
            <div className="ml-4 border-l border-[var(--color-border)] pl-3">
              {childrenOf(g.id).map((c) => (
                <div key={String(c.id)}>
                  <Row>
                    <div className="flex items-center justify-between gap-2">
                      <span>{String(c.title)}</span>
                      {c.target != null ? <span className="text-[var(--color-text-faint)]">{String(c.current ?? 0)}/{String(c.target)}</span> : null}
                    </div>
                  </Row>
                  <div className="ml-4 border-l border-[var(--color-border)] pl-3">
                    {childrenOf(c.id).map((gc) => (
                      <Row key={String(gc.id)}>
                        <span className="text-[var(--color-text-dim)]">{String(gc.title)}</span>
                      </Row>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Decision log" count={decisions.length}>
        {decisions.length === 0 ? <Empty>No decisions logged yet.</Empty> : decisions.map((d) => (
          <Row key={String(d.id)}>
            <div className="font-medium">{String(d.question)}</div>
            <div className="mt-1 text-[var(--color-text-dim)]">→ {String(d.chosen ?? d.recommendation)}</div>
            <p className="mt-1 text-[var(--color-text-faint)]">{String(d.reasoning)}</p>
            {d.uncertainty ? <p className="mt-1 text-[var(--color-warn)]">Uncertainty: {String(d.uncertainty)}</p> : null}
          </Row>
        ))}
      </Section>

      {review && (
        <Section title="Latest weekly review">
          <div className="card p-3">
            <div className="mb-2 text-[11px] text-[var(--color-text-faint)]">{String(review.period)}</div>
            <Markdown text={String(review.markdown ?? "")} />
          </div>
        </Section>
      )}
    </div>
  );
}

function Memory({ data }: { data: Record<string, unknown> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const items = arr<Record<string, unknown>>(data.items);
  const stats = obj(data.stats);
  const runs = arr<Record<string, unknown>>(data.runs);
  const shown = results ?? items;

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) { setResults(null); return; }
    const res = await fetch(`/api/memory?q=${encodeURIComponent(query)}`);
    const data = (await res.json()) as { results?: Record<string, unknown>[] };
    setResults(data.results ?? []);
  };

  return (
    <div>
      <form onSubmit={search} className="mb-4 flex gap-2">
        <input className="input" placeholder="Search memory…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" type="submit">Search</button>
      </form>

      <Section title={results ? "Search results" : "Recent memories"} count={shown.length}>
        <p className="mb-2 text-[11px] text-[var(--color-text-faint)]">{num(stats.total)} memories stored</p>
        {shown.length === 0 ? <Empty>Nothing stored yet.</Empty> : shown.map((m) => (
          <Row key={String(m.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(m.title)}</span>
              <span className={`pill ${m.kind === "fact" ? "pill-ok" : m.kind === "assumption" ? "pill-warn" : ""}`}>{String(m.kind)}</span>
            </div>
            <p className="mt-1 text-[var(--color-text-dim)]">{String(m.content).slice(0, 400)}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="pill">{String(m.layer)}</span>
              <span className="pill">conf {num(m.confidence).toFixed(2)}</span>
              <span className="pill">{String(m.source)}</span>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Recent agent runs" count={runs.length}>
        {runs.map((r) => (
          <Row key={String(r.id)}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{String(r.objective)}</span>
              <span className={`pill ${r.status === "completed" ? "pill-ok" : r.status === "failed" ? "pill-danger" : "pill-warn"}`}>{String(r.status)}</span>
            </div>
            <div className="mt-0.5 text-[var(--color-text-faint)]">{num(r.tokens).toLocaleString()} tokens · ${num(r.costUsd).toFixed(4)}</div>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function System({ data }: { data: Record<string, unknown> }) {
  const agent = obj(data.agent);
  const research = obj(data.research);
  const integrations = arr<Record<string, unknown>>(data.integrations);

  return (
    <div>
      <Section title="Core">
        <Row>
          <div className="flex items-center justify-between">
            <span>Agent model access</span>
            <span className={`pill ${agent.configured ? "pill-ok" : "pill-danger"}`}>{agent.configured ? "connected" : "not configured"}</span>
          </div>
          {agent.note ? <p className="mt-1 text-[var(--color-text-faint)]">{String(agent.note)}</p> : null}
        </Row>
        <Row>
          <div className="flex items-center justify-between">
            <span>Web research{research.provider ? ` (${String(research.provider)})` : ""}</span>
            <span className={`pill ${research.configured ? "pill-ok" : "pill-warn"}`}>{research.configured ? "connected" : "not configured"}</span>
          </div>
          {research.note ? <p className="mt-1 text-[var(--color-text-faint)]">{String(research.note)}</p> : null}
        </Row>
      </Section>

      <Section title="Platform integrations" count={integrations.length}>
        <p className="mb-2 text-[11px] leading-relaxed text-[var(--color-text-faint)]">
          Nothing here is simulated. An integration that is not connected returns no data, and the agent will
          say so rather than estimating numbers.
        </p>
        {integrations.map((i) => (
          <Row key={String(i.key)}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{String(i.name)}</span>
              <span className={`pill ${i.configured ? "pill-ok" : ""}`}>{i.configured ? "connected" : "not connected"}</span>
            </div>
            <p className="mt-1 text-[var(--color-text-dim)]">{String(i.purpose)}</p>
            {!i.configured && (
              <>
                <p className="mt-1 text-[var(--color-text-faint)]">{String(i.setup)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {arr<string>(i.missing).map((m) => <span key={m} className="pill">{m}</span>)}
                </div>
              </>
            )}
          </Row>
        ))}
      </Section>
    </div>
  );
}
