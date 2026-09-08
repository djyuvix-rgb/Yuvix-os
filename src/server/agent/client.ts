import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/server/env";
import { log } from "@/server/logger";

let client: Anthropic | null = null;

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      "The agent has no model access: ANTHROPIC_API_KEY is not set. " +
        "Add it to .env and restart. Everything else in YUVIX OS (panels, records, reviews, audio analysis) works without it.",
    );
    this.name = "AgentNotConfiguredError";
  }
}

export function anthropic(): Anthropic {
  if (!env.anthropicApiKey) throw new AgentNotConfiguredError();
  if (!client) {
    client = new Anthropic({
      apiKey: env.anthropicApiKey,
      baseURL: env.anthropicBaseUrl,
      maxRetries: 0, // we retry ourselves so backoff is observable in the logs
    });
  }
  return client;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Retries transient API failures with exponential backoff and jitter. Anything
 * non-retryable (a 400 from a malformed request) fails fast so the bug surfaces.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || RETRYABLE.has(status);
      if (!retryable || attempt === attempts) break;
      const delay = Math.min(2 ** attempt * 500, 8000) + Math.random() * 400;
      log.warn("agent.api.retry", { label, attempt, status, delayMs: Math.round(delay) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Approximate spend, for the run's cost column. Rates are USD per 1M tokens. */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES[model] ?? RATES["claude-sonnet-5"];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
