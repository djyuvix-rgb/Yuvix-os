import { env } from "@/server/env";
import { log } from "@/server/logger";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Local provider: deterministic hashed feature vectors over word unigrams,
 * bigrams and character 4-grams, then L2-normalised.
 *
 * This is a real lexical embedding — it is not a language model, so it captures
 * overlap rather than deep semantics. It exists so semantic memory works with
 * zero external dependencies and zero cost. Set YUVIX_EMBEDDING_PROVIDER=voyage
 * for genuine semantic retrieval.
 */
class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = "local-hash-v1";
  readonly dimensions = 384;

  private hash(token: string, salt: number): number {
    // FNV-1a, salted so the three feature families do not collide systematically.
    let h = 0x811c9dc5 ^ salt;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return Math.abs(h) % this.dimensions;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const words = this.tokenize(text);

    for (const w of words) vec[this.hash(w, 1)] += 1;
    for (let i = 0; i < words.length - 1; i++) vec[this.hash(`${words[i]}_${words[i + 1]}`, 2)] += 0.7;

    const flat = words.join(" ");
    for (let i = 0; i + 4 <= flat.length; i++) vec[this.hash(flat.slice(i, i + 4), 3)] += 0.25;

    // Sublinear term scaling keeps one repeated word from dominating.
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] > 0 ? 1 + Math.log(vec[i]) : 0;

    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }
}

/** Voyage AI — strong retrieval quality, used when VOYAGE_API_KEY is present. */
class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = "voyage-3";
  readonly dimensions = 1024;

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.voyageKey}`,
      },
      body: JSON.stringify({ input: texts, model: "voyage-3", input_type: "document" }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => Float32Array.from(d.embedding));
  }
}

let cached: EmbeddingProvider | null = null;

export function embeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  if (env.embeddingProvider === "voyage" && env.voyageKey) {
    cached = new VoyageEmbeddingProvider();
  } else {
    if (env.embeddingProvider === "voyage") {
      log.warn("memory.embeddings.fallback", { reason: "VOYAGE_API_KEY missing", using: "local" });
    }
    cached = new LocalEmbeddingProvider();
  }
  return cached;
}

export function encodeVector(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

export function decodeVector(encoded: string): Float32Array {
  const buf = Buffer.from(encoded, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
