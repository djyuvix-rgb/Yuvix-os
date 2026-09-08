import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./db";

beforeAll(() => useTestDatabase("memory"));

describe("embeddings", () => {
  it("produces normalised, deterministic vectors", async () => {
    const { embeddingProvider } = await import("@/server/memory/embeddings");
    const provider = embeddingProvider();
    const [a] = await provider.embed(["melodic techno label with strong artwork"]);
    const [b] = await provider.embed(["melodic techno label with strong artwork"]);

    let norm = 0;
    for (const v of a) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("scores related text above unrelated text", async () => {
    const { embeddingProvider, cosine } = await import("@/server/memory/embeddings");
    const provider = embeddingProvider();
    const [query, related, unrelated] = await provider.embed([
      "melodic techno label demo submission",
      "submitting a demo to a melodic techno label",
      "tax deadline for the accountant in March",
    ]);
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("survives an encode/decode round trip", async () => {
    const { embeddingProvider, encodeVector, decodeVector } = await import("@/server/memory/embeddings");
    const [vec] = await embeddingProvider().embed(["round trip"]);
    const decoded = decodeVector(encodeVector(vec));
    expect(Array.from(decoded)).toEqual(Array.from(vec));
  });
});

describe("memory store", () => {
  it("stores, indexes and recalls a memory", async () => {
    const { memory } = await import("@/server/memory/store");
    await memory.remember({
      layer: "campaign",
      kind: "lesson",
      title: "Live DJ footage outperformed studio clips",
      content: "During the Yaka campaign, reels using live DJ footage got roughly 3x the views of studio process clips.",
      source: "user",
    });

    const results = await memory.recall("what content format worked on the last campaign");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toMatch(/Live DJ footage/);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("defaults facts to high confidence and assumptions to low", async () => {
    const { memory } = await import("@/server/memory/store");
    const fact = await memory.remember({ layer: "artist", kind: "fact", title: "Based in Berlin", content: "Operator stated they live in Berlin." });
    const guess = await memory.remember({ layer: "artist", kind: "assumption", title: "Prefers vinyl labels", content: "Inferred from two comments about record shops." });

    expect(fact.confidence).toBeGreaterThan(0.8);
    expect(guess.confidence).toBeLessThan(0.6);
  });

  it("archives the old version when a memory is corrected", async () => {
    const { memory } = await import("@/server/memory/store");
    const { prisma } = await import("@/server/db/client");

    const original = await memory.remember({ layer: "artist", kind: "fact", title: "Monthly budget", content: "€100/month." });
    const updated = await memory.update(original.id, {
      layer: "artist", kind: "fact", title: "Monthly budget", content: "€400/month from March.",
    });

    const old = await prisma.memoryItem.findUnique({ where: { id: original.id } });
    expect(old?.isArchived).toBe(true);
    expect(old?.supersededById).toBe(updated.id);

    const results = await memory.recall("monthly budget");
    expect(results.map((r) => r.id)).not.toContain(original.id);
  });

  it("returns nothing rather than something irrelevant when memory is empty on a topic", async () => {
    const { memory } = await import("@/server/memory/store");
    const results = await memory.recall("quantum chromodynamics lattice gauge theory", { minScore: 0.3 });
    expect(results).toHaveLength(0);
  });
});

describe("business context", () => {
  it("says a cold start is a cold start instead of inventing a profile", async () => {
    const { buildBusinessContext } = await import("@/server/memory/context");
    const context = await buildBusinessContext("grow my career");
    expect(context.markdown).toMatch(/No artist profile exists yet/);
    expect(context.markdown).toMatch(/Do not invent profile facts/);
  });

  it("reports when no integrations can supply live data", async () => {
    const { buildBusinessContext } = await import("@/server/memory/context");
    const context = await buildBusinessContext("how many listeners do I have");
    expect(context.markdown).toMatch(/no live platform data is available/i);
  });

  it("includes the artist profile once it exists", async () => {
    const { prisma } = await import("@/server/db/client");
    const { buildBusinessContext } = await import("@/server/memory/context");

    await prisma.artistProfile.create({
      data: { artistName: "Yuvix", genresJson: JSON.stringify(["melodic techno"]), weeklyHours: 12, monthlyBudgetEur: 200 },
    });
    const context = await buildBusinessContext("what is my positioning");
    expect(context.artist).toBe("Yuvix");
    expect(context.markdown).toMatch(/melodic techno/);
    expect(context.markdown).toMatch(/12 h\/week/);
  });
});

describe("json codecs", () => {
  it("degrades to a default on corrupt data instead of throwing", async () => {
    const { parseList, parseObject, parseArray } = await import("@/server/db/json");
    expect(parseList("not json at all")).toEqual([]);
    expect(parseObject("{broken", { a: 1 })).toEqual({ a: 1 });
    expect(parseArray("[]")).toEqual([]);
    expect(parseList('["a","b",3]')).toEqual(["a", "b"]);
  });
});
