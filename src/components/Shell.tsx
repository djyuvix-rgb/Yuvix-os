"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Panel, type PanelKey } from "./Panels";

const PANELS: { key: PanelKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "approvals", label: "Approvals" },
  { key: "projects", label: "Projects" },
  { key: "releases", label: "Releases" },
  { key: "contacts", label: "Contacts" },
  { key: "content", label: "Content" },
  { key: "music", label: "Music" },
  { key: "analytics", label: "Analytics" },
  { key: "finance", label: "Finance" },
  { key: "strategy", label: "Strategy" },
  { key: "memory", label: "Memory" },
  { key: "system", label: "System" },
];

export function Shell({ userName }: { userName: string }) {
  const [panel, setPanel] = useState<PanelKey>("today");
  const [refreshKey, setRefreshKey] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // A single lightweight poll keeps the approval badge honest without turning
  // the whole shell into a polling loop.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/approvals");
        if (!res.ok) return;
        const data = (await res.json()) as { pending?: number };
        if (!cancelled) setPendingApprovals(data.pending ?? 0);
      } catch {
        /* offline is not an error worth surfacing here */
      }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refreshKey]);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-52 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 py-4">
          <div className="text-[10px] font-medium tracking-[0.25em] text-[var(--color-text-faint)]">YUVIX</div>
          <div className="text-lg font-semibold leading-tight tracking-tight">OS</div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {PANELS.map((p) => (
            <button
              key={p.key}
              onClick={() => { setPanel(p.key); setPanelOpen(true); }}
              className={`mb-0.5 flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                panel === p.key && panelOpen
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              }`}
            >
              {p.label}
              {p.key === "approvals" && pendingApprovals > 0 && (
                <span className="pill pill-warn">{pendingApprovals}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] px-3 py-3">
          <div className="truncate text-[11px] text-[var(--color-text-dim)]">{userName}</div>
          <button
            onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }}
            className="mt-1 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Chat onDataChanged={refresh} />
        </div>

        {panelOpen && (
          <div className="flex w-[26rem] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
              <span className="text-[13px] font-medium">{PANELS.find((p) => p.key === panel)?.label}</span>
              <div className="flex items-center gap-1">
                <button onClick={refresh} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Refresh">↻</button>
                <button onClick={() => setPanelOpen(false)} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="Hide panel">✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <Panel panel={panel} refreshKey={refreshKey} onChanged={refresh} />
            </div>
          </div>
        )}

        {!panelOpen && (
          <button
            onClick={() => setPanelOpen(true)}
            className="border-l border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            ‹
          </button>
        )}
      </main>
    </div>
  );
}
