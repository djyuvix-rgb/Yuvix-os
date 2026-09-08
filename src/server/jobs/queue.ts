import { randomUUID } from "node:crypto";
import { prisma } from "@/server/db/client";
import { parseObject, toJson } from "@/server/db/json";
import { errorMessage, log } from "@/server/logger";

/**
 * Database-backed job queue.
 *
 * Deliberately not Redis/BullMQ: the workload is a handful of jobs per day, and
 * a queue in the same database means one thing to run, one thing to back up, and
 * jobs that survive a restart. Locking is optimistic via updateMany on the
 * queued row, which is safe with multiple workers on both SQLite and Postgres.
 */

export type JobHandler = (payload: Record<string, unknown>, ctx: { jobId: string }) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(name: string, handler: JobHandler) {
  handlers.set(name, handler);
}

export function registeredJobs(): string[] {
  return [...handlers.keys()];
}

export async function enqueue(
  name: string,
  payload: Record<string, unknown> = {},
  options: { runAfter?: Date; priority?: number; maxAttempts?: number } = {},
) {
  const job = await prisma.job.create({
    data: {
      name,
      payloadJson: toJson(payload),
      runAfter: options.runAfter ?? new Date(),
      priority: options.priority ?? 3,
      maxAttempts: options.maxAttempts ?? 3,
    },
  });
  log.info("job.enqueued", { jobId: job.id, name });
  return job;
}

/** Claims one job atomically. Returns null when nothing is due. */
export async function claimNext(workerId: string) {
  const candidates = await prisma.job.findMany({
    where: { status: "queued", runAfter: { lte: new Date() } },
    orderBy: [{ priority: "asc" }, { runAfter: "asc" }],
    take: 5,
  });

  for (const candidate of candidates) {
    const claimed = await prisma.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", lockedAt: new Date(), lockedBy: workerId, startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 1) return prisma.job.findUnique({ where: { id: candidate.id } });
  }
  return null;
}

export async function runJob(job: { id: string; name: string; payloadJson: string; attempts: number; maxAttempts: number }) {
  const handler = handlers.get(job.name);
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "failed", lastError: `No handler registered for "${job.name}"`, finishedAt: new Date() },
    });
    return;
  }

  try {
    const result = await handler(parseObject<Record<string, unknown>>(job.payloadJson, {}), { jobId: job.id });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "completed", resultJson: toJson(result ?? {}), finishedAt: new Date(), lastError: null },
    });
    log.info("job.completed", { jobId: job.id, name: job.name });
  } catch (err) {
    const message = errorMessage(err);
    const exhausted = job.attempts >= job.maxAttempts;
    await prisma.job.update({
      where: { id: job.id },
      data: exhausted
        ? { status: "failed", lastError: message, finishedAt: new Date() }
        : {
            status: "queued",
            lastError: message,
            // Exponential backoff so a transient API outage does not burn every attempt at once.
            runAfter: new Date(Date.now() + 2 ** job.attempts * 60_000),
            lockedAt: null,
            lockedBy: null,
          },
    });
    log.error("job.failed", { jobId: job.id, name: job.name, attempt: job.attempts, exhausted, error: message });
  }
}

/** Releases jobs whose worker died mid-run so they are retried rather than stuck. */
export async function reclaimStale(olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const { count } = await prisma.job.updateMany({
    where: { status: "running", lockedAt: { lt: cutoff } },
    data: { status: "queued", lockedAt: null, lockedBy: null, lastError: "Reclaimed after worker timeout" },
  });
  if (count) log.warn("job.reclaimed", { count });
  return count;
}

export function newWorkerId(): string {
  return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
}
