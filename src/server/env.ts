/**
 * Central environment access.
 *
 * Rule: no secret is ever read outside this module, and no secret value is
 * ever logged, persisted, or returned to the client. Callers ask
 * `isConfigured(...)` to branch behaviour; they never see the value unless they
 * are the adapter that needs it.
 */

const bool = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "file:./yuvix.db",
  workspaceDir: process.env.YUVIX_WORKSPACE_DIR ?? "./workspace",
  authSecret: process.env.AUTH_SECRET ?? "",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
  model: process.env.YUVIX_MODEL ?? "claude-opus-5",
  fastModel: process.env.YUVIX_FAST_MODEL ?? "claude-sonnet-5",
  maxSteps: num(process.env.YUVIX_MAX_STEPS, 24),

  braveKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  tavilyKey: process.env.TAVILY_API_KEY ?? "",
  serperKey: process.env.SERPER_API_KEY ?? "",

  embeddingProvider: (process.env.YUVIX_EMBEDDING_PROVIDER ?? "local") as "local" | "voyage",
  voyageKey: process.env.VOYAGE_API_KEY ?? "",

  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? "",
  soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? "",

  verboseLogs: bool(process.env.YUVIX_VERBOSE),
} as const;

/** True when every named env var is present and non-empty. */
export function hasEnv(...keys: string[]): boolean {
  return keys.every((k) => (process.env[k] ?? "").trim().length > 0);
}

/** Which of the named env vars are missing — used to tell the user what to set. */
export function missingEnv(...keys: string[]): string[] {
  return keys.filter((k) => (process.env[k] ?? "").trim().length === 0);
}

export const agentConfigured = () => env.anthropicApiKey.trim().length > 0;
export const researchConfigured = () =>
  [env.braveKey, env.tavilyKey, env.serperKey].some((k) => k.trim().length > 0);
