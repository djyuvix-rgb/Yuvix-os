import { prisma } from "@/server/db/client";
import { parseList, toJson } from "@/server/db/json";
import { cosine, decodeVector, embeddingProvider, encodeVector } from "./embeddings";
import type { MemoryKind, MemoryLayer } from "@/server/domain/constants";
import { log } from "@/server/logger";

export interface RememberInput {
  layer: MemoryLayer;
  kind: MemoryKind;
  title: string;
  content: string;
  /** 0..1. Facts stated by the user default high; inferences default low. */
  confidence?: number;
  source?: string;
  sourceUrl?: string;
  tags?: string[];
  entityType?: string;
  entityId?: string;
  /** When set, the previous memory with this exact title in this layer is archived. */
  supersedeSameTitle?: boolean;
}

export interface RecallOptions {
  layers?: MemoryLayer[];
  kinds?: MemoryKind[];
  entityType?: string;
  entityId?: string;
  limit?: number;
  /** Below this cosine score, results are dropped even if nothing else matched. */
  minScore?: number;
}

export interface RecalledMemory {
  id: string;
  layer: string;
  kind: string;
  title: string;
  content: string;
  confidence: number;
  source: string;
  sourceUrl: string | null;
  tags: string[];
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
  score: number;
}

/**
 * Structured-first memory.
 *
 * Domain rows (releases, contacts, tasks) are the source of truth for facts
 * with a shape. This store holds the things that do not have a table: lessons,
 * preferences, decisions' context, research conclusions — plus pointers back to
 * domain rows so one recall can surface both.
 */
export const memory = {
  async remember(input: RememberInput) {
    const confidence =
      input.confidence ??
      (input.kind === "fact" ? 0.9 : input.kind === "assumption" ? 0.45 : 0.65);

    if (input.supersedeSameTitle) {
      await prisma.memoryItem.updateMany({
        where: { layer: input.layer, title: input.title, isArchived: false },
        data: { isArchived: true },
      });
    }

    const item = await prisma.memoryItem.create({
      data: {
        layer: input.layer,
        kind: input.kind,
        title: input.title,
        content: input.content,
        confidence,
        source: input.source ?? "user",
        sourceUrl: input.sourceUrl ?? null,
        tagsJson: toJson(input.tags ?? []),
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });

    await this.index(item.id, `${input.title}\n${input.content}`);
    log.debug("memory.remember", { id: item.id, layer: input.layer, kind: input.kind });
    return item;
  },

  /** Computes and stores the embedding for a memory. Failure is non-fatal. */
  async index(memoryId: string, text: string) {
    try {
      const provider = embeddingProvider();
      const [vec] = await provider.embed([text]);
      await prisma.memoryEmbedding.upsert({
        where: { memoryId },
        create: {
          memoryId,
          model: provider.id,
          dimensions: provider.dimensions,
          vector: encodeVector(vec),
        },
        update: { model: provider.id, dimensions: provider.dimensions, vector: encodeVector(vec) },
      });
    } catch (err) {
      // Keyword recall still works without a vector, so we log and move on.
      log.warn("memory.index.failed", { memoryId, error: String(err) });
    }
  },

  /**
   * Hybrid recall: lexical prefilter in SQL, then cosine re-rank in process.
   *
   * The prefilter keeps this O(candidates) rather than O(all memories), which
   * matters once the store has thousands of rows. The vector store interface is
   * isolated here so swapping to pgvector is a change to this function only.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecalledMemory[]> {
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.05;

    const where = {
      isArchived: false,
      ...(options.layers?.length ? { layer: { in: options.layers } } : {}),
      ...(options.kinds?.length ? { kind: { in: options.kinds } } : {}),
      ...(options.entityType ? { entityType: options.entityType } : {}),
      ...(options.entityId ? { entityId: options.entityId } : {}),
    };

    const candidates = await prisma.memoryItem.findMany({
      where,
      include: { embedding: true },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    if (candidates.length === 0) return [];

    const provider = embeddingProvider();
    let queryVec: Float32Array | null = null;
    try {
      [queryVec] = await provider.embed([query]);
    } catch (err) {
      log.warn("memory.recall.embed_failed", { error: String(err) });
    }

    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

    const scored = candidates.map((item) => {
      const haystack = `${item.title} ${item.content}`.toLowerCase();
      const lexical = terms.length
        ? terms.filter((t) => haystack.includes(t)).length / terms.length
        : 0;

      let semantic = 0;
      if (queryVec && item.embedding && item.embedding.dimensions === provider.dimensions) {
        semantic = cosine(queryVec, decodeVector(item.embedding.vector));
      }

      // Recency nudge: a 90-day half-life, capped so old lessons still surface.
      const ageDays = (Date.now() - item.updatedAt.getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / 90) * 0.1;

      const score = semantic * 0.6 + lexical * 0.3 + recency + item.confidence * 0.05;
      return { item, score };
    });

    const top = scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Usage stats let the agent (and the Memory panel) show what actually gets used.
    if (top.length) {
      await prisma.memoryItem.updateMany({
        where: { id: { in: top.map((t) => t.item.id) } },
        data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
      });
    }

    return top.map(({ item, score }) => ({
      id: item.id,
      layer: item.layer,
      kind: item.kind,
      title: item.title,
      content: item.content,
      confidence: item.confidence,
      source: item.source,
      sourceUrl: item.sourceUrl,
      tags: parseList(item.tagsJson),
      entityType: item.entityType,
      entityId: item.entityId,
      createdAt: item.createdAt,
      score: Number(score.toFixed(4)),
    }));
  },

  async forget(id: string, reason: string) {
    const item = await prisma.memoryItem.update({
      where: { id },
      data: { isArchived: true },
    });
    log.info("memory.forget", { id, reason });
    return item;
  },

  /** Replaces a memory, keeping the audit trail via supersededById. */
  async update(id: string, input: RememberInput) {
    const created = await this.remember(input);
    await prisma.memoryItem.update({
      where: { id },
      data: { isArchived: true, supersededById: created.id },
    });
    return created;
  },

  async stats() {
    const grouped = await prisma.memoryItem.groupBy({
      by: ["layer", "kind"],
      where: { isArchived: false },
      _count: { _all: true },
    });
    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
    return { total, byLayerKind: grouped.map((g) => ({ layer: g.layer, kind: g.kind, count: g._count._all })) };
  },
};
