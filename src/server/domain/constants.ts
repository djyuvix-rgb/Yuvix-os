/**
 * Enum-like constants. The schema stores these as strings for portability, so
 * this file is the single source of truth for the allowed values, and Zod
 * schemas in the tool layer enforce them at the boundary.
 */

export const TRACK_STATUS = [
  "idea", "demo", "wip", "mixdown", "mastering", "ready", "signed", "scheduled", "released", "shelved",
] as const;
export type TrackStatus = (typeof TRACK_STATUS)[number];

export const RELEASE_STATUS = ["planned", "scheduled", "out", "cancelled"] as const;
export const RELEASE_TYPE = ["single", "ep", "album", "remix", "compilation"] as const;

/** CRM pipeline — shared by labels and contacts so "who do I chase" is one query. */
export const CRM_STATUS = [
  "discovered", "researched", "target", "contacted", "replied",
  "interested", "negotiating", "signed", "rejected", "follow_up", "inactive",
] as const;
export type CrmStatus = (typeof CRM_STATUS)[number];

/** Statuses that mean "a human is expecting something back from us". */
export const CRM_ACTIVE_STATUSES: readonly CrmStatus[] = [
  "target", "contacted", "replied", "interested", "negotiating", "follow_up",
];

export const TASK_STATUS = ["todo", "doing", "blocked", "done", "cancelled"] as const;
export const PROJECT_STATUS = ["planned", "active", "blocked", "done", "cancelled"] as const;
export const GOAL_LEVEL = ["vision", "annual", "quarterly", "monthly"] as const;
export const GOAL_STATUS = ["active", "achieved", "missed", "paused", "dropped"] as const;

export const PLATFORMS = [
  "instagram", "tiktok", "youtube", "youtube_shorts", "spotify",
  "soundcloud", "beatport", "bandcamp", "facebook", "x", "other",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CONTENT_STATUS = [
  "idea", "scripted", "filming", "editing", "ready", "scheduled", "published", "archived",
] as const;

export const CONTENT_FORMATS = ["reel", "short", "carousel", "story", "post", "longform", "live"] as const;

export const INCOME_CATEGORIES = [
  "streaming", "royalties", "gig", "production", "mixing", "mastering",
  "remix", "sync", "licensing", "sponsorship", "other",
] as const;

export const EXPENSE_CATEGORIES = [
  "promotion", "advertising", "software", "equipment", "artwork", "mixmaster",
  "distribution", "travel", "content", "management", "other",
] as const;

export const CAMPAIGN_PHASES = ["foundation", "build", "amplify", "launch", "sustain"] as const;
export type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

export const MEMORY_LAYERS = [
  "profile", "artist", "business", "crm", "project", "task",
  "decision", "campaign", "performance", "semantic",
] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const MEMORY_KINDS = [
  "fact", "assumption", "preference", "insight", "event", "lesson", "reference",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const INSIGHT_KINDS = [
  "opportunity", "risk", "bottleneck", "missed", "inefficiency", "recommendation",
] as const;

export const OUTREACH_PURPOSES = [
  "demo_submission", "booking", "collab", "press", "playlist", "follow_up", "other",
] as const;

/** Musical keys in Camelot + standard notation, used to validate track metadata. */
export const CAMELOT_KEYS = [
  "1A","1B","2A","2B","3A","3B","4A","4B","5A","5B","6A","6B",
  "7A","7B","8A","8B","9A","9B","10A","10B","11A","11B","12A","12B",
] as const;
