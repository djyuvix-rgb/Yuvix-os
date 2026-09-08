import { authed } from "@/server/api/helpers";
import { syncIntegrations } from "@/server/integrations/registry";
import { agentConfigured, researchConfigured, missingEnv } from "@/server/env";
import { activeProvider } from "@/server/research/providers";

/**
 * Connection status for everything external.
 *
 * Reports what is actually configured and what to set to change that. It never
 * reports a capability the system does not have.
 */
export const GET = authed(async () => {
  const integrations = await syncIntegrations();
  return {
    agent: {
      configured: agentConfigured(),
      missing: missingEnv("ANTHROPIC_API_KEY"),
      note: agentConfigured()
        ? null
        : "Set ANTHROPIC_API_KEY in .env to enable the agent. Panels, records, reviews and audio analysis work without it.",
    },
    research: {
      configured: researchConfigured(),
      provider: activeProvider(),
      note: researchConfigured()
        ? null
        : "Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY or SERPER_API_KEY to enable web research. Until then the agent will say it cannot look things up rather than guessing.",
    },
    integrations,
  };
});

export const POST = authed(async () => ({ integrations: await syncIntegrations() }));
