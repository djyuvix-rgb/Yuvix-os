"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

type TraceEvent =
  | { kind: "plan"; steps: { id: number; step: string; tool?: string }[] }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: string; ok?: boolean; summary?: string; autonomy?: string; durationMs?: number }
  | { kind: "approval"; approvalId: string; title: string; description: string; details: string[] }
  | { kind: "verify"; notes: string }
  | { kind: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace?: TraceEvent[];
}

const SLASH_COMMANDS: { command: string; prompt: string; label: string }[] = [
  { command: "/today", prompt: "What should I do today? Use daily_priorities and explain why each item matters.", label: "Today's priorities" },
  { command: "/week", prompt: "Run the weekly CEO review and give me the full structured output.", label: "Weekly review" },
  { command: "/goals", prompt: "Show my goal hierarchy and tell me honestly which goals are off pace.", label: "Goals" },
  { command: "/releases", prompt: "Show my releases and unreleased tracks, and flag anything without a campaign or a plan.", label: "Releases" },
  { command: "/content", prompt: "Analyse what content has actually worked and build the next content plan from it.", label: "Content" },
  { command: "/research", prompt: "Research this topic thoroughly and cite your sources: ", label: "Research" },
  { command: "/labels", prompt: "Find and rank labels that fit my sound right now. Research them properly and record each with a fit rationale.", label: "Labels" },
  { command: "/outreach", prompt: "Who should I contact this week, and why? Draft personalised messages for the top three.", label: "Outreach" },
  { command: "/contacts", prompt: "Show my CRM: who is in each pipeline stage and who is going cold.", label: "Contacts" },
  { command: "/analytics", prompt: "Show what my numbers actually say. Be explicit about what you cannot see.", label: "Analytics" },
  { command: "/finance", prompt: "Give me the financial picture: revenue, expenses, profit, and where the money is going.", label: "Finance" },
  { command: "/projects", prompt: "Show my projects and tasks, and tell me what is blocked or overdue.", label: "Projects" },
  { command: "/strategy", prompt: "Given everything you know about my business, what is the strategic picture and the single highest-leverage move right now?", label: "Strategy" },
  { command: "/memory", prompt: "What do you know about me and my business? Show the key facts and flag the assumptions.", label: "Memory" },
  { command: "/brainstorm", prompt: "Brainstorm with me. Give me genuinely different options, not variations of the same idea: ", label: "Brainstorm" },
  { command: "/analyze", prompt: "Analyse this properly and tell me what it means for the business: ", label: "Analyze" },
  { command: "/plan", prompt: "Turn this into a real plan with projects and dated tasks: ", label: "Plan" },
  { command: "/execute", prompt: "Execute this as far as you can without my approval, then tell me exactly what is waiting on me: ", label: "Execute" },
  { command: "/review", prompt: "Review the state of my business and tell me what I am getting wrong.", label: "Review" },
];

export function Chat({ onDataChanged }: { onDataChanged: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [liveTrace, setLiveTrace] = useState<TraceEvent[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, liveTrace]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;

      const expanded = SLASH_COMMANDS.find((c) => text.trim() === c.command || text.trim().startsWith(`${c.command} `));
      const message = expanded
        ? expanded.prompt + text.trim().slice(expanded.command.length).trim()
        : text;

      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);
      setInput("");
      setShowCommands(false);
      setStreaming(true);
      setLiveTrace([]);

      const controller = new AbortController();
      abortRef.current = controller;
      const trace: TraceEvent[] = [];
      let answer = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, conversationId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const line = chunk.replace(/^data: /, "").trim();
            if (!line || line === "[DONE]") continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            switch (event.type) {
              case "conversation":
                setConversationId(event.conversationId as string);
                break;
              case "plan":
                trace.push({ kind: "plan", steps: event.steps as { id: number; step: string; tool?: string }[] });
                break;
              case "thinking":
                trace.push({ kind: "thinking", text: event.text as string });
                break;
              case "tool_start":
                trace.push({ kind: "tool", tool: event.tool as string, autonomy: event.autonomy as string });
                break;
              case "tool_end": {
                const open = [...trace].reverse().find((t) => t.kind === "tool" && t.tool === event.tool && t.ok === undefined);
                if (open && open.kind === "tool") {
                  open.ok = event.ok as boolean;
                  open.summary = event.summary as string;
                  open.durationMs = event.durationMs as number;
                }
                break;
              }
              case "approval_required":
                trace.push({
                  kind: "approval",
                  approvalId: event.approvalId as string,
                  title: event.title as string,
                  description: event.description as string,
                  details: (event.details as string[]) ?? [],
                });
                onDataChanged();
                break;
              case "verification":
                trace.push({ kind: "verify", notes: event.notes as string });
                break;
              case "text":
                answer = event.text as string;
                break;
              case "error":
                trace.push({ kind: "error", message: event.message as string });
                break;
              case "run_finished":
                if (!answer) answer = (event.result as string) ?? "";
                break;
            }
            setLiveTrace([...trace]);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          trace.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: answer || "The run ended without producing an answer. Check the trace above.",
          trace: [...trace],
        },
      ]);
      setLiveTrace([]);
      setStreaming(false);
      abortRef.current = null;
      onDataChanged();
    },
    [conversationId, streaming, onDataChanged],
  );

  const filtered = input.startsWith("/")
    ? SLASH_COMMANDS.filter((c) => c.command.startsWith(input.split(" ")[0]))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.length === 0 && !streaming && <EmptyState onPick={send} />}

          {messages.map((m) => (
            <div key={m.id}>
              {m.role === "user" ? (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--color-surface-2)] px-4 py-2.5 text-sm">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div>
                  {m.trace && m.trace.length > 0 && <Trace events={m.trace} collapsed />}
                  <Markdown text={m.content} />
                </div>
              )}
            </div>
          ))}

          {streaming && (
            <div>
              <Trace events={liveTrace} />
              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text-faint)]">
                <span className="thinking-dot">●</span> working…
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <div className="mx-auto max-w-3xl">
          {showCommands && filtered.length > 0 && (
            <div className="card mb-2 max-h-56 overflow-y-auto p-1.5">
              {filtered.map((c) => (
                <button
                  key={c.command}
                  onClick={() => { setInput(`${c.command} `); setShowCommands(false); }}
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-surface-2)]"
                >
                  <span className="font-mono text-[var(--color-accent)]">{c.command}</span>
                  <span className="text-[var(--color-text-dim)]">{c.label}</span>
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); void send(input); }}
            className="flex items-end gap-2"
          >
            <textarea
              className="input resize-none py-2.5"
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              placeholder="Give me an outcome, not instructions. Try /today, or “grow Yuvix this year”."
              value={input}
              onChange={(e) => { setInput(e.target.value); setShowCommands(e.target.value.startsWith("/")); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
                if (e.key === "Escape") setShowCommands(false);
              }}
              disabled={streaming}
            />
            {streaming ? (
              <button type="button" className="btn btn-danger" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const starters = [
    "Help me grow my music career.",
    "What should I do today?",
    "Find labels that fit my sound.",
    "I have a new track coming out in 4 weeks.",
    "Make me a content plan.",
  ];
  return (
    <div className="pt-10">
      <h2 className="text-xl font-semibold tracking-tight">What are we building today?</h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-[var(--color-text-dim)]">
        Give an outcome and it will work out the steps — researching, planning, creating projects
        and tasks, and asking you only when a decision is genuinely yours.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {starters.map((s) => (
          <button key={s} onClick={() => onPick(s)} className="btn text-xs">{s}</button>
        ))}
      </div>
    </div>
  );
}

function Trace({ events, collapsed = false }: { events: TraceEvent[]; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  if (events.length === 0) return null;

  const toolCount = events.filter((e) => e.kind === "tool").length;

  return (
    <div className="mb-3">
      {collapsed && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mb-1.5 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
        >
          {open ? "▾" : "▸"} {toolCount} tool call{toolCount === 1 ? "" : "s"}
        </button>
      )}
      {open && (
        <div className="space-y-1.5 border-l border-[var(--color-border)] pl-3 text-[11px]">
          {events.map((event, i) => {
            if (event.kind === "plan") {
              return (
                <div key={i} className="text-[var(--color-text-dim)]">
                  <div className="mb-0.5 font-medium text-[var(--color-text)]">Plan</div>
                  {event.steps.map((s) => (
                    <div key={s.id} className="pl-2">
                      {s.id}. {s.step}
                      {s.tool && <span className="ml-1 font-mono text-[var(--color-text-faint)]">{s.tool}</span>}
                    </div>
                  ))}
                </div>
              );
            }
            if (event.kind === "thinking") {
              return <div key={i} className="italic text-[var(--color-text-faint)]">{event.text.slice(0, 400)}</div>;
            }
            if (event.kind === "tool") {
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className={event.ok === false ? "text-[var(--color-danger)]" : event.ok ? "text-[var(--color-ok)]" : "text-[var(--color-text-faint)]"}>
                    {event.ok === false ? "✕" : event.ok ? "✓" : "○"}
                  </span>
                  <span className="font-mono text-[var(--color-text-dim)]">{event.tool}</span>
                  {event.autonomy === "level2" && <span className="pill pill-warn">approval</span>}
                  {event.summary && <span className="truncate text-[var(--color-text-faint)]">{event.summary}</span>}
                  {event.durationMs != null && <span className="ml-auto text-[var(--color-text-faint)]">{event.durationMs}ms</span>}
                </div>
              );
            }
            if (event.kind === "approval") {
              return (
                <div key={i} className="rounded-md border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] p-2">
                  <div className="font-medium text-[var(--color-warn)]">Approval required: {event.title}</div>
                  <div className="mt-0.5 text-[var(--color-text-dim)]">{event.description}</div>
                  <div className="mt-1 text-[var(--color-text-faint)]">Open the Approvals panel to decide.</div>
                </div>
              );
            }
            if (event.kind === "verify") {
              return <div key={i} className="text-[var(--color-ok)]">✓ {event.notes}</div>;
            }
            return <div key={i} className="text-[var(--color-danger)]">✕ {event.message}</div>;
          })}
        </div>
      )}
    </div>
  );
}
