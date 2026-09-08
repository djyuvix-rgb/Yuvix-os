/**
 * Structured logging. Everything the agent does is observable: one JSON line
 * per event, with a run id when the event happened inside an agent run.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: Level = (process.env.YUVIX_LOG_LEVEL as Level) ?? (process.env.YUVIX_VERBOSE === "1" ? "debug" : "info");

/** Keys whose values must never reach a log line. */
const REDACT = /(api[-_]?key|secret|password|token|authorization|cookie|bearer)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…[truncated]`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN]) return;
  const line = { ts: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => emit("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
  /** Times an async operation and logs its duration and outcome. */
  async time<T>(event: string, data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      emit("debug", `${event}.ok`, { ...data, ms: Date.now() - t0 });
      return result;
    } catch (err) {
      emit("error", `${event}.fail`, { ...data, ms: Date.now() - t0, error: errorMessage(err) });
      throw err;
    }
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
