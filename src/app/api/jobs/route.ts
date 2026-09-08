import { prisma } from "@/server/db/client";
import { authed, badRequest, readJson } from "@/server/api/helpers";
import { enqueue, registeredJobs } from "@/server/jobs/queue";
import { installJobHandlers } from "@/server/jobs/handlers";
import { parseObject } from "@/server/db/json";

export const GET = authed(async () => {
  installJobHandlers();
  const jobs = await prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  return {
    available: registeredJobs(),
    jobs: jobs.map((j) => ({
      id: j.id, name: j.name, status: j.status, attempts: j.attempts,
      runAfter: j.runAfter, finishedAt: j.finishedAt, lastError: j.lastError,
      result: parseObject<Record<string, unknown>>(j.resultJson, {}),
    })),
    note: "Jobs run in the worker process — start it with `npm run worker`.",
  };
});

export const POST = authed(async (user, request) => {
  installJobHandlers();
  const body = await readJson<{ name?: string; payload?: Record<string, unknown> }>(request);
  if (!body.name) badRequest("name is required");
  if (!registeredJobs().includes(body.name)) badRequest(`Unknown job "${body.name}". Available: ${registeredJobs().join(", ")}`);
  const job = await enqueue(body.name, { ...body.payload, userId: user.id });
  return { id: job.id, name: job.name, status: job.status };
});
