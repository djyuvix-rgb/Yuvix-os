import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { activeProvider, ResearchNotConfiguredError, webSearch } from "@/server/research/providers";
import { fetchPage } from "@/server/research/fetch";
import { memory } from "@/server/memory/store";
import { researchConfigured } from "@/server/env";

export const researchTools = [
  defineTool({
    name: "web_search",
    group: "research",
    autonomy: "level1",
    readOnly: true,
    description:
      "Search the live web. Use for anything current: labels and their submission policies, playlists and curators, promoters and venues, festival line-ups, distributors, competitor activity, platform algorithm changes, industry news, marketing tactics. " +
      "Results include a source-quality score per domain. Treat a single snippet as a lead, not a fact — open the important ones with web_fetch before acting on them.",
    schema: z.object({
      query: z.string().min(3),
      count: z.number().int().min(3).max(20).optional(),
    }),
    async execute(input) {
      if (!researchConfigured()) throw new ResearchNotConfiguredError();
      const results = await webSearch(input.query, input.count ?? 8);
      return {
        provider: activeProvider(),
        query: input.query,
        count: results.length,
        results: results.map((r) => ({
          title: r.title,
          url: r.url,
          domain: r.domain,
          snippet: r.snippet,
          publishedAt: r.publishedAt,
          sourceQuality: r.sourceQuality,
        })),
        guidance: "Snippets are summaries and are often outdated. Open any page whose content will drive a decision or a message to a real person.",
      };
    },
  }),

  defineTool({
    name: "web_fetch",
    group: "research",
    autonomy: "level1",
    readOnly: true,
    description:
      "Fetch a web page and extract its readable text. Use it to verify a claim from search, read a label's actual demo policy, or read an article properly. Always prefer this over trusting a snippet.",
    schema: z.object({
      url: z.string().url(),
      maxChars: z.number().int().min(1000).max(40_000).optional(),
    }),
    async execute(input) {
      const page = await fetchPage(input.url, input.maxChars ?? 12_000);
      return {
        url: page.finalUrl,
        title: page.title,
        domain: page.domain,
        sourceQuality: page.sourceQuality,
        fetchedAt: page.fetchedAt,
        truncated: page.truncated,
        text: page.text,
      };
    },
  }),

  defineTool({
    name: "research_topic",
    group: "research",
    autonomy: "level1",
    description:
      "Run a multi-source research pass on one question: searches, opens the strongest sources, and returns their content together with a cross-check report showing where sources agree and disagree. " +
      "Use this for decisions that matter (which labels fit a track, whether a tactic still works, what a distributor actually charges) rather than a single search. " +
      "Store what you conclude with memory_remember, and cite the URLs in your answer.",
    schema: z.object({
      question: z.string().min(5),
      searchQueries: z.array(z.string()).min(1).max(4).describe("Distinct phrasings — different queries surface different sources"),
      maxPages: z.number().int().min(1).max(6).optional(),
      storeConclusionAs: z.string().optional().describe("If set, the fetched evidence is filed under this title in memory"),
    }),
    async execute(input) {
      if (!researchConfigured()) throw new ResearchNotConfiguredError();

      const seen = new Set<string>();
      const hits = [];
      for (const q of input.searchQueries) {
        try {
          for (const r of await webSearch(q, 8)) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            hits.push(r);
          }
        } catch (err) {
          hits.push({ title: `Search failed for "${q}"`, url: "", snippet: String(err), domain: "", sourceQuality: 0 });
        }
      }

      const ranked = hits
        .filter((h) => h.url)
        .sort((a, b) => b.sourceQuality - a.sourceQuality)
        .slice(0, input.maxPages ?? 4);

      const pages = [];
      for (const hit of ranked) {
        try {
          const page = await fetchPage(hit.url, 8000);
          pages.push({
            url: page.finalUrl,
            title: page.title,
            domain: page.domain,
            sourceQuality: page.sourceQuality,
            fetchedAt: page.fetchedAt,
            excerpt: page.text,
          });
        } catch (err) {
          pages.push({ url: hit.url, title: hit.title, domain: hit.domain, sourceQuality: hit.sourceQuality, fetchedAt: new Date().toISOString(), excerpt: `[Could not fetch: ${String(err)}]` });
        }
      }

      if (input.storeConclusionAs && pages.length) {
        await memory.remember({
          layer: "business",
          kind: "reference",
          title: input.storeConclusionAs,
          content: `Question: ${input.question}\nSources consulted:\n${pages.map((p) => `- ${p.title} (${p.url})`).join("\n")}`,
          source: "research",
          sourceUrl: pages[0].url,
          confidence: 0.7,
        });
      }

      const readable = pages.filter((p) => !p.excerpt.startsWith("[Could not fetch"));
      return {
        question: input.question,
        searchHits: hits.length,
        pagesRead: readable.length,
        sources: pages,
        crossCheck: {
          independentDomains: new Set(readable.map((p) => p.domain)).size,
          highQualitySources: readable.filter((p) => p.sourceQuality >= 0.8).length,
          instruction:
            "Compare the excerpts before concluding. State agreement explicitly, name disagreements, and cite the URL next to each factual claim. " +
            (readable.length < 2 ? "Fewer than two sources were readable — say your answer is weakly sourced." : ""),
        },
      };
    },
  }),

  defineTool({
    name: "research_labels",
    group: "research",
    autonomy: "level1",
    description:
      "Find labels that could fit a specific track or the artist's sound. Runs targeted searches across genre, roster and demo-policy angles and returns raw evidence to evaluate. " +
      "It does NOT invent fit scores — read the evidence, then record each real candidate with label_upsert including a fitRationale and its sources. " +
      "Never output a submission email you did not read on the label's own page.",
    schema: z.object({
      genre: z.string().describe("e.g. melodic techno, progressive house, afro house"),
      soundDescriptors: z.array(z.string()).optional(),
      referenceArtists: z.array(z.string()).optional().describe("Artists whose labels are plausible targets"),
      region: z.string().optional(),
      maxPages: z.number().int().min(2).max(8).optional(),
    }),
    async execute(input) {
      if (!researchConfigured()) throw new ResearchNotConfiguredError();

      const queries = [
        `${input.genre} labels accepting demos ${new Date().getFullYear()}`,
        `best ${input.genre} record labels${input.region ? ` ${input.region}` : ""}`,
        ...(input.referenceArtists ?? []).slice(0, 3).map((a) => `${a} label releases discography`),
        ...(input.soundDescriptors?.length ? [`${input.soundDescriptors.join(" ")} ${input.genre} label roster`] : []),
      ];

      const seen = new Set<string>();
      const hits = [];
      for (const q of queries.slice(0, 5)) {
        try {
          for (const r of await webSearch(q, 8)) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            hits.push({ ...r, foundVia: q });
          }
        } catch {
          /* one failed query must not sink the whole pass */
        }
      }

      const pages = [];
      for (const hit of hits.sort((a, b) => b.sourceQuality - a.sourceQuality).slice(0, input.maxPages ?? 5)) {
        try {
          const page = await fetchPage(hit.url, 8000);
          pages.push({ url: page.finalUrl, title: page.title, domain: page.domain, sourceQuality: page.sourceQuality, excerpt: page.text });
        } catch {
          /* skip unreadable pages */
        }
      }

      return {
        genre: input.genre,
        searchHits: hits.length,
        candidateSources: hits.slice(0, 20).map((h) => ({ title: h.title, url: h.url, domain: h.domain, snippet: h.snippet, sourceQuality: h.sourceQuality })),
        pagesRead: pages,
        nextSteps: [
          "Extract only labels that actually appear in the evidence above.",
          "For each: open the label's own site to confirm the demo policy and submission route before recording it.",
          "Record each with label_upsert including fitScore, fitRationale and sources.",
          "Rank by fit to THIS artist's sound and stage, not by label prestige.",
        ],
        warning: "Roster and demo policies change constantly. Anything not confirmed on the label's own page this session is unverified.",
      };
    },
  }),
];
