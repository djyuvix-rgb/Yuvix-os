import { env, researchConfigured } from "@/server/env";
import { log } from "@/server/logger";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  /** 0..1 heuristic — how much weight this domain deserves for music-industry facts. */
  sourceQuality: number;
  domain: string;
}

export class ResearchNotConfiguredError extends Error {
  constructor() {
    super(
      "Web research is not configured. Set one of BRAVE_SEARCH_API_KEY, TAVILY_API_KEY or SERPER_API_KEY in .env and restart. " +
        "Until then no web lookup is possible — say so rather than answering from memory.",
    );
    this.name = "ResearchNotConfiguredError";
  }
}

/**
 * Domain credibility for music-industry research.
 *
 * This is a coarse prior, not truth. It exists so the agent weights a label's
 * own site above a content-farm listicle when the two disagree, and so
 * low-quality sources are visibly marked in the output.
 */
const DOMAIN_QUALITY: [RegExp, number][] = [
  [/(^|\.)(beatport|bandcamp|discogs|residentadvisor|ra\.co|musicbrainz)\.com?/i, 0.95],
  [/(^|\.)(spotify|soundcloud|youtube|apple)\.com/i, 0.9],
  [/(^|\.)(billboard|musicbusinessworldwide|musically|pitchfork|mixmag|djmag|xlr8r|attackmagazine)\.com?/i, 0.85],
  [/(^|\.)(wikipedia)\.org/i, 0.7],
  [/(^|\.)(reddit|quora|medium)\.com/i, 0.4],
  [/(blogspot|wordpress\.com|wixsite|weebly)/i, 0.35],
];

export function scoreDomain(url: string): { domain: string; quality: number } {
  let domain = "";
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return { domain: "unknown", quality: 0.3 };
  }
  for (const [pattern, score] of DOMAIN_QUALITY) if (pattern.test(domain)) return { domain, quality: score };
  // An official-looking label or artist site scores mid: primary but unverified.
  return { domain, quality: 0.6 };
}

async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  url.searchParams.set("freshness", "py"); // bias to the past year: industry facts go stale
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": env.braveKey },
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string; age?: string }[] } };
  return (json.web?.results ?? []).map((r) => {
    const { domain, quality } = scoreDomain(r.url);
    return { title: r.title, url: r.url, snippet: stripHtml(r.description ?? ""), publishedAt: r.age, domain, sourceQuality: quality };
  });
}

async function tavilySearch(query: string, count: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.tavilyKey,
      query,
      max_results: Math.min(count, 20),
      search_depth: "advanced",
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { results?: { title: string; url: string; content: string; published_date?: string }[] };
  return (json.results ?? []).map((r) => {
    const { domain, quality } = scoreDomain(r.url);
    return { title: r.title, url: r.url, snippet: r.content?.slice(0, 500) ?? "", publishedAt: r.published_date, domain, sourceQuality: quality };
  });
}

async function serperSearch(query: string, count: number): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": env.serperKey },
    body: JSON.stringify({ q: query, num: Math.min(count, 20) }),
  });
  if (!res.ok) throw new Error(`Serper search failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { organic?: { title: string; link: string; snippet: string; date?: string }[] };
  return (json.organic ?? []).map((r) => {
    const { domain, quality } = scoreDomain(r.link);
    return { title: r.title, url: r.link, snippet: r.snippet ?? "", publishedAt: r.date, domain, sourceQuality: quality };
  });
}

export function activeProvider(): "brave" | "tavily" | "serper" | null {
  if (env.braveKey) return "brave";
  if (env.tavilyKey) return "tavily";
  if (env.serperKey) return "serper";
  return null;
}

export async function webSearch(query: string, count = 8): Promise<SearchResult[]> {
  if (!researchConfigured()) throw new ResearchNotConfiguredError();
  const provider = activeProvider();
  log.debug("research.search", { provider, query });
  switch (provider) {
    case "brave":
      return braveSearch(query, count);
    case "tavily":
      return tavilySearch(query, count);
    case "serper":
      return serperSearch(query, count);
    default:
      throw new ResearchNotConfiguredError();
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
