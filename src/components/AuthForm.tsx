"use client";

import { useState } from "react";

export function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(mode === "setup"
            ? { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
            : {}),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-[11px] font-medium tracking-[0.25em] text-[var(--color-text-faint)]">
            YUVIX
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">OS</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-dim)]">
            {mode === "setup"
              ? "Create the owner account. This is the only account with full control over your business data, so use a real password — there is no default."
              : "Sign in to your artist business."}
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-5">
          {mode === "setup" && (
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--color-text-dim)]">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Yuvix" />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs text-[var(--color-text-dim)]">Email</span>
            <input
              className="input" type="email" required autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-[var(--color-text-dim)]">
              Password{mode === "setup" && " (10+ characters)"}
            </span>
            <input
              className="input" type="password" required
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              minLength={mode === "setup" ? 10 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && (
            <p className="rounded-md border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Working…" : mode === "setup" ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
