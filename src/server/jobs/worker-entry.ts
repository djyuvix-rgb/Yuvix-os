/**
 * Standalone worker process: `npm run worker`.
 *
 * Kept separate from the Next.js server so long jobs cannot block requests and
 * so the worker can be scaled or restarted independently.
 */
import "@/server/load-env";
import { claimNext, newWorkerId, reclaimStale, runJob } from "./queue";
import { ensureRecurringJobs, installJobHandlers } from "./handlers";
import { log } from "@/server/logger";

const POLL_MS = 5000;
const workerId = newWorkerId();
let running = true;

async function main() {
  installJobHandlers();
  log.info("worker.started", { workerId });

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  let tick = 0;
  while (running) {
    try {
      if (tick % 12 === 0) {
        await reclaimStale();
        await ensureRecurringJobs();
      }
      const job = await claimNext(workerId);
      if (job) {
        log.info("worker.job.start", { jobId: job.id, name: job.name });
        await runJob(job);
        continue; // drain the queue before sleeping again
      }
    } catch (err) {
      log.error("worker.tick.failed", { error: String(err) });
    }
    tick++;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log.info("worker.stopped", { workerId });
  process.exit(0);
}

main().catch((err) => {
  log.error("worker.crashed", { error: String(err) });
  process.exit(1);
});
