import { prisma } from "@/server/db/client";
import { parseObject, toJson } from "@/server/db/json";
import type { CampaignPhase } from "@/server/domain/constants";

/**
 * Release campaign engine.
 *
 * The timeline is generated in code, not by the model, for three reasons: it is
 * deterministic, it is cheap, and a release plan that silently drops the
 * distribution deadline because a model was creative is a real business failure.
 * The agent's job is to enrich this skeleton — the copy, the targets, the
 * judgement — not to remember the mechanics.
 */

export interface CampaignResources {
  weeklyHours: number;
  monthlyBudgetEur: number;
  hasArtwork: boolean;
  hasVideoCapability: boolean;
  hasLabel: boolean;
  distributorLeadDays: number;
}

export interface GeneratedTask {
  title: string;
  rationale: string;
  offsetDays: number; // negative = before release day
  impact: number;
  effortMin: number;
  phase: CampaignPhase;
  /** Dropped when the resource this needs is absent. */
  requires?: keyof CampaignResources | "budget" | "video";
}

const TEMPLATE: GeneratedTask[] = [
  // ── Foundation: 8–6 weeks out ──────────────────────────────────────────
  { phase: "foundation", offsetDays: -56, impact: 5, effortMin: 60, title: "Lock the release decision: self-release or pitch", rationale: "Everything downstream — timeline, artwork, budget, promo — depends on this. Deciding late compresses every other stage." },
  { phase: "foundation", offsetDays: -56, impact: 4, effortMin: 45, title: "Write the release positioning: what this track is and who it is for", rationale: "One paragraph that every caption, pitch and press line is derived from. Without it the campaign says something slightly different everywhere." },
  { phase: "foundation", offsetDays: -52, impact: 5, effortMin: 30, title: "Finalise metadata: title, artist credit, ISRC, splits, genre, BPM, key", rationale: "Distributors reject or delay releases over metadata. Splits agreed after release turn into disputes." },
  { phase: "foundation", offsetDays: -49, impact: 4, effortMin: 120, title: "Commission or finish artwork", rationale: "Artwork gates the pre-save, the teaser assets and the distributor upload. It is the most common cause of a slipped release date.", requires: "hasArtwork" },
  { phase: "foundation", offsetDays: -45, impact: 4, effortMin: 60, title: "Final master check and reference against comparable releases", rationale: "A master that fails on a club system or gets turned down by streaming normalisation wastes the whole campaign." },

  // ── Build: 6–4 weeks out ───────────────────────────────────────────────
  { phase: "build", offsetDays: -42, impact: 5, effortMin: 45, title: "Upload to the distributor or deliver to the label", rationale: "Playlist consideration needs the release in the system weeks ahead. Late delivery forfeits editorial pitching entirely." },
  { phase: "build", offsetDays: -40, impact: 4, effortMin: 30, title: "Set up the pre-save / pre-order link", rationale: "Pre-saves convert existing audience into first-day streams, which is the signal algorithmic playlists respond to." },
  { phase: "build", offsetDays: -38, impact: 4, effortMin: 90, title: "Shoot the raw content batch for the campaign", rationale: "Batching removes the daily 'what do I post' decision, which is what actually kills content consistency.", requires: "hasVideoCapability" },
  { phase: "build", offsetDays: -35, impact: 5, effortMin: 60, title: "Build the DJ and curator promo list with a personal reason for each name", rationale: "A list of 20 people you can say something specific to beats a blast to 200. Generic promos are deleted." },
  { phase: "build", offsetDays: -33, impact: 4, effortMin: 45, title: "Pitch to editorial playlists through the distributor's tool", rationale: "Most platforms require the pitch before release day; miss the window and the option is gone for this release." },
  { phase: "build", offsetDays: -30, impact: 3, effortMin: 45, title: "Draft the press one-sheet and short bio for this release", rationale: "Anyone who covers or books you asks for this. Having it ready converts interest before it cools." },

  // ── Amplify: 4–2 weeks out ─────────────────────────────────────────────
  { phase: "amplify", offsetDays: -28, impact: 4, effortMin: 30, title: "Announce the release with the first teaser", rationale: "The announcement starts the audience's anticipation window; a release nobody saw coming has no first-day spike." },
  { phase: "amplify", offsetDays: -25, impact: 4, effortMin: 60, title: "Send private promos to the DJ list", rationale: "DJs need lead time to fit a track into sets and radio shows before release week." },
  { phase: "amplify", offsetDays: -21, impact: 3, effortMin: 45, title: "Post teaser 2: the hook moment of the track", rationale: "The strongest 8 bars do more work than any description of the track." },
  { phase: "amplify", offsetDays: -18, impact: 3, effortMin: 45, title: "Post behind-the-scenes: how this track was made", rationale: "Process content builds the artist brand rather than only promoting one song, and it outlives the release." },
  { phase: "amplify", offsetDays: -14, impact: 3, effortMin: 60, title: "Follow up with DJs and curators who have not responded", rationale: "One polite follow-up roughly doubles response rates. A second does not — it costs the relationship." },
  { phase: "amplify", offsetDays: -12, impact: 3, effortMin: 45, title: "Set up and budget the paid promotion test", rationale: "A small controlled spend tells you whether paid reach works for this audience before the release, when it is still useful.", requires: "budget" },

  // ── Launch: release week ───────────────────────────────────────────────
  { phase: "launch", offsetDays: -7, impact: 4, effortMin: 30, title: "Release-week countdown post", rationale: "Reminds the people who saw the announcement three weeks ago and have forgotten." },
  { phase: "launch", offsetDays: -3, impact: 4, effortMin: 30, title: "Prepare all release-day assets so nothing is made on the day", rationale: "Release day is for responding to people, not for editing video." },
  { phase: "launch", offsetDays: 0, impact: 5, effortMin: 60, title: "Release day: post across every platform and update all links", rationale: "First-day engagement is what platform algorithms weight most heavily." },
  { phase: "launch", offsetDays: 0, impact: 5, effortMin: 45, title: "Personally message the people who supported the track", rationale: "The single highest-return hour of the campaign. Relationships compound across releases; a broadcast post does not." },
  { phase: "launch", offsetDays: 1, impact: 3, effortMin: 30, title: "Share early reactions and repost supporter stories", rationale: "Social proof on day two extends the spike instead of letting it decay." },
  { phase: "launch", offsetDays: 3, impact: 3, effortMin: 30, title: "Post the release-week performance moment or DJ footage", rationale: "Shows the track in its real context, which converts far better than a static cover image.", requires: "hasVideoCapability" },

  // ── Sustain: post-release ──────────────────────────────────────────────
  { phase: "sustain", offsetDays: 7, impact: 4, effortMin: 45, title: "Week 1 analysis: streams, saves, playlist adds, best content", rationale: "Save rate and playlist adds in week one predict whether the track has legs. This is the moment to decide whether to invest more." },
  { phase: "sustain", offsetDays: 10, impact: 3, effortMin: 45, title: "Thank supporters and log every DJ play with evidence", rationale: "Builds the support record that makes the next label pitch credible." },
  { phase: "sustain", offsetDays: 14, impact: 3, effortMin: 60, title: "Second content wave for the same track", rationale: "Most independent releases die because promotion stops on day two while discovery is still running." },
  { phase: "sustain", offsetDays: 21, impact: 3, effortMin: 45, title: "Pitch to independent and curator playlists that fit the track", rationale: "Independent curators consider tracks well after release, unlike editorial." },
  { phase: "sustain", offsetDays: 28, impact: 4, effortMin: 60, title: "Campaign retro: what worked, what did not, what to change next time", rationale: "Without a written retro the next campaign repeats the same mistakes. This is what makes release N+1 better than release N." },
  { phase: "sustain", offsetDays: 30, impact: 3, effortMin: 30, title: "Decide the follow-up: remix, next single, or consolidate", rationale: "Release cadence is the strongest driver of independent growth. Deciding late creates a gap." },
];

const PHASE_LABELS: Record<CampaignPhase, string> = {
  foundation: "8–6 weeks: foundation",
  build: "6–4 weeks: build",
  amplify: "4–2 weeks: amplify",
  launch: "Release week: launch",
  sustain: "Post-release: sustain",
};

export interface GenerateOptions {
  releaseId: string;
  releaseDate: Date;
  resources: CampaignResources;
  createTasks?: boolean;
}

export interface GeneratedCampaign {
  campaignId: string;
  projectId: string;
  name: string;
  compressed: boolean;
  leadDays: number;
  droppedTasks: { title: string; reason: string }[];
  stages: { name: string; phase: string; start: string; end: string; taskCount: number }[];
  tasks: { id: string; title: string; dueDate: string; phase: string }[];
  warnings: string[];
}

/**
 * Builds the campaign. When there is less lead time than the template assumes,
 * the timeline is compressed proportionally rather than truncated, so the
 * ordering of dependencies survives — and the caller is told what was lost.
 */
export async function generateCampaign(options: GenerateOptions): Promise<GeneratedCampaign> {
  const release = await prisma.release.findUnique({ where: { id: options.releaseId } });
  if (!release) throw new Error(`Release ${options.releaseId} not found`);

  const dayMs = 86_400_000;
  const leadDays = Math.round((options.releaseDate.getTime() - Date.now()) / dayMs);
  const warnings: string[] = [];
  const dropped: { title: string; reason: string }[] = [];

  const compressed = leadDays < 56 && leadDays > 0;
  // Pre-release offsets are scaled to fit the real lead time; post-release ones
  // are absolute and never move.
  const scale = compressed ? Math.max(leadDays, 1) / 56 : 1;

  if (leadDays < 0) {
    warnings.push(`The release date is ${Math.abs(leadDays)} days in the past. Only post-release work is scheduled.`);
  } else if (leadDays < 14) {
    warnings.push(
      `Only ${leadDays} days of lead time. Editorial playlist pitching (needs ~4 weeks) and most DJ promo lead time are already gone. ` +
        "The realistic goal for this release is a clean launch and a strong post-release push, not a full campaign.",
    );
  } else if (leadDays < 42) {
    warnings.push(`${leadDays} days of lead time compresses the plan. Distribution and playlist pitching deadlines are the binding constraint — do those first.`);
  }

  const { resources } = options;
  const applicable = TEMPLATE.filter((task) => {
    if (task.requires === "budget" && resources.monthlyBudgetEur <= 0) {
      dropped.push({ title: task.title, reason: "No promotion budget recorded" });
      return false;
    }
    if (task.requires === "hasVideoCapability" && !resources.hasVideoCapability) {
      dropped.push({ title: task.title, reason: "No video capability recorded — replace with photo or audio-led content" });
      return false;
    }
    if (task.requires === "hasArtwork" && resources.hasArtwork) {
      dropped.push({ title: task.title, reason: "Artwork already exists" });
      return false;
    }
    if (task.offsetDays < 0 && leadDays > 0) {
      const scheduled = Math.round(task.offsetDays * scale);
      if (Math.abs(scheduled) > leadDays) {
        dropped.push({ title: task.title, reason: `Needs ${Math.abs(task.offsetDays)} days of lead time; only ${leadDays} available` });
        return false;
      }
    }
    if (task.offsetDays < 0 && leadDays <= 0) {
      dropped.push({ title: task.title, reason: "Release date has passed" });
      return false;
    }
    return true;
  });

  // Capacity check: does the plan fit in the hours the operator actually has?
  const totalMinutes = applicable.reduce((s, t) => s + t.effortMin, 0);
  const weeks = Math.max(1, (leadDays + 30) / 7);
  const weeklyLoad = totalMinutes / 60 / weeks;
  if (resources.weeklyHours > 0 && weeklyLoad > resources.weeklyHours * 0.6) {
    warnings.push(
      `This plan averages ${weeklyLoad.toFixed(1)} h/week against ${resources.weeklyHours} h/week of stated capacity, and it is only the release work — ` +
        "cut the lowest-impact tasks rather than starting all of them and finishing none.",
    );
  }

  const project = await prisma.project.create({
    data: {
      name: `Release: ${release.title}`,
      summary: `Campaign for ${release.title}, out ${options.releaseDate.toISOString().slice(0, 10)}.`,
      type: "release",
      status: "active",
      priority: 1,
      dueDate: new Date(options.releaseDate.getTime() + 30 * dayMs),
      contextJson: toJson({ releaseId: release.id, leadDays, compressed }),
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      name: `${release.title} release campaign`,
      type: "release",
      releaseId: release.id,
      projectId: project.id,
      startDate: new Date(),
      endDate: new Date(options.releaseDate.getTime() + 30 * dayMs),
      status: "running",
      budgetEur: release.budgetEur ?? resources.monthlyBudgetEur,
      objectiveJson: toJson({
        primary: `Launch ${release.title} with the strongest first week the available lead time and resources allow`,
        kpis: [
          { metric: "first_week_streams", target: null, note: "Set a target once a baseline from a previous release exists" },
          { metric: "playlist_adds", target: null },
          { metric: "dj_supports", target: null },
          { metric: "followers_gained", target: null },
        ],
      }),
    },
  });

  const phases: CampaignPhase[] = ["foundation", "build", "amplify", "launch", "sustain"];
  const stages = [];
  for (const [index, phase] of phases.entries()) {
    const phaseTasks = applicable.filter((t) => t.phase === phase);
    if (phaseTasks.length === 0) continue;
    const offsets = phaseTasks.map((t) => (t.offsetDays < 0 ? Math.round(t.offsetDays * scale) : t.offsetDays));
    const start = new Date(options.releaseDate.getTime() + Math.min(...offsets) * dayMs);
    const end = new Date(options.releaseDate.getTime() + Math.max(...offsets) * dayMs);
    await prisma.campaignStage.create({
      data: {
        campaignId: campaign.id,
        name: PHASE_LABELS[phase],
        phase,
        orderIndex: index,
        startDate: start,
        endDate: end,
        goal: phaseTasks[0]?.rationale.slice(0, 200),
      },
    });
    stages.push({
      name: PHASE_LABELS[phase],
      phase,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      taskCount: phaseTasks.length,
    });
  }

  const createdTasks = [];
  if (options.createTasks !== false) {
    for (const task of applicable) {
      const offset = task.offsetDays < 0 ? Math.round(task.offsetDays * scale) : task.offsetDays;
      const due = new Date(options.releaseDate.getTime() + offset * dayMs);
      const created = await prisma.task.create({
        data: {
          title: `${release.title}: ${task.title}`,
          details: `Campaign phase: ${PHASE_LABELS[task.phase]}`,
          rationale: task.rationale,
          projectId: project.id,
          impact: task.impact,
          priority: task.impact >= 5 ? 1 : task.impact >= 4 ? 2 : 3,
          effortMin: task.effortMin,
          dueDate: due,
        },
      });
      createdTasks.push({
        id: created.id,
        title: created.title,
        dueDate: due.toISOString().slice(0, 10),
        phase: task.phase,
      });
    }
  }

  return {
    campaignId: campaign.id,
    projectId: project.id,
    name: campaign.name,
    compressed,
    leadDays,
    droppedTasks: dropped,
    stages,
    tasks: createdTasks,
    warnings,
  };
}

/** Reads the artist's real capacity so the campaign is planned against it. */
export async function currentResources(overrides: Partial<CampaignResources> = {}): Promise<CampaignResources> {
  const artist = await prisma.artistProfile.findFirst();
  const extra = parseObject<Record<string, unknown>>(artist?.resourcesJson, {});
  return {
    weeklyHours: artist?.weeklyHours ?? 0,
    monthlyBudgetEur: artist?.monthlyBudgetEur ?? 0,
    hasArtwork: Boolean(extra.hasArtwork),
    hasVideoCapability: extra.hasVideoCapability !== false,
    hasLabel: Boolean(extra.hasLabel),
    distributorLeadDays: typeof extra.distributorLeadDays === "number" ? extra.distributorLeadDays : 21,
    ...overrides,
  };
}
