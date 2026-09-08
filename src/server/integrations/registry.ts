import { prisma } from "@/server/db/client";
import { hasEnv, missingEnv } from "@/server/env";
import { toJson } from "@/server/db/json";

/**
 * Integration registry.
 *
 * Each entry declares which environment variables it needs and how to obtain
 * them. Status is derived from whether those variables are actually present —
 * never asserted. Nothing here simulates an API: an integration that is not
 * configured reports itself as not configured, and the agent tells the operator
 * exactly what to set rather than inventing data.
 */
export interface IntegrationSpec {
  key: string;
  name: string;
  requiredEnv: string[];
  purpose: string;
  setup: string;
}

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    key: "spotify",
    name: "Spotify",
    requiredEnv: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    purpose: "Catalogue and playlist lookups. Note: monthly listeners and per-track stream counts are only available in Spotify for Artists, not the public API — those still come from you or a CSV export.",
    setup: "Create an app at developer.spotify.com/dashboard, then set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
  },
  {
    key: "youtube",
    name: "YouTube Data API",
    requiredEnv: ["YOUTUBE_API_KEY"],
    purpose: "Public video and channel statistics for your channel and for competitor research.",
    setup: "Enable the YouTube Data API v3 in Google Cloud Console, create an API key, set YOUTUBE_API_KEY.",
  },
  {
    key: "soundcloud",
    name: "SoundCloud",
    requiredEnv: ["SOUNDCLOUD_CLIENT_ID"],
    purpose: "Track and profile statistics, repost and comment activity.",
    setup: "SoundCloud API registration is currently restricted; request access at soundcloud.com/you/apps, then set SOUNDCLOUD_CLIENT_ID.",
  },
  {
    key: "email",
    name: "Email sending",
    requiredEnv: ["SMTP_URL"],
    purpose: "Lets approved outreach drafts actually be delivered instead of handed back for manual sending.",
    setup: "Set SMTP_URL to an smtp:// or smtps:// connection string from your mail provider.",
  },
  {
    key: "instagram",
    name: "Instagram / Meta",
    requiredEnv: ["META_ACCESS_TOKEN", "IG_BUSINESS_ACCOUNT_ID"],
    purpose: "Post insights and follower metrics for a Business or Creator account.",
    setup: "Requires a Meta app with instagram_manage_insights, a Business account linked to a Facebook Page, and a long-lived token.",
  },
  {
    key: "tiktok",
    name: "TikTok",
    requiredEnv: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    purpose: "Video performance data for a registered Business account.",
    setup: "Apply for TikTok for Developers access; approval is required before any data is available.",
  },
];

/** Syncs the registry into the database and recomputes each status from the environment. */
export async function syncIntegrations() {
  for (const spec of INTEGRATIONS) {
    const configured = hasEnv(...spec.requiredEnv);
    await prisma.integration.upsert({
      where: { key: spec.key },
      create: {
        key: spec.key,
        name: spec.name,
        status: configured ? "configured" : "not_configured",
        requiredEnvJson: toJson(spec.requiredEnv),
        configJson: toJson({ purpose: spec.purpose, setup: spec.setup }),
        lastCheckedAt: new Date(),
      },
      update: {
        name: spec.name,
        status: configured ? "configured" : "not_configured",
        requiredEnvJson: toJson(spec.requiredEnv),
        configJson: toJson({ purpose: spec.purpose, setup: spec.setup }),
        lastCheckedAt: new Date(),
      },
    });
  }
  return INTEGRATIONS.map((spec) => ({
    key: spec.key,
    name: spec.name,
    configured: hasEnv(...spec.requiredEnv),
    missing: missingEnv(...spec.requiredEnv),
    purpose: spec.purpose,
    setup: spec.setup,
  }));
}
