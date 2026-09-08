import { authed, badRequest } from "@/server/api/helpers";
import { memory } from "@/server/memory/store";
import type { MemoryLayer } from "@/server/domain/constants";

/** Semantic search over memory, for the MEMORY panel's search box. */
export const GET = authed(async (_user, request) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  if (!query) badRequest("q is required");
  const layer = url.searchParams.get("layer") as MemoryLayer | null;

  const results = await memory.recall(query, {
    limit: 20,
    ...(layer ? { layers: [layer] } : {}),
  });
  return { query, count: results.length, results };
});
