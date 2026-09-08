/**
 * JSON-text codecs.
 *
 * The schema stores structured blobs as TEXT so it runs unchanged on SQLite and
 * Postgres. These helpers are the only place that parsing happens, so a corrupt
 * or hand-edited row degrades to a default instead of throwing inside a route.
 */

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export const parseList = (raw: string | null | undefined): string[] => {
  const v = parseJson<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

export const parseArray = <T>(raw: string | null | undefined): T[] => {
  const v = parseJson<unknown>(raw, []);
  return Array.isArray(v) ? (v as T[]) : [];
};

export const parseObject = <T extends object>(raw: string | null | undefined, fallback: T): T => {
  const v = parseJson<unknown>(raw, fallback);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
};
