import { registerTools, allTools } from "@/server/agent/registry";
import { memoryTools } from "./memory";
import { workTools } from "./work";
import { musicTools } from "./music";
import { crmTools } from "./crm";
import { contentTools } from "./content";
import { financeTools } from "./finance";
import { analyticsTools } from "./analytics";
import { researchTools } from "./research";
import { fileTools } from "./files";
import { audioTools } from "./audio";
import { campaignTools } from "./campaign";
import { intelligenceTools } from "./intelligence";

let registered = false;

/**
 * Registers every tool exactly once.
 *
 * Called at the top of any entry point that can run the agent (API routes, the
 * job worker, tests). Registration is idempotent so Next.js module reloading in
 * development does not trip the duplicate-name guard.
 */
export function registerAllTools() {
  if (registered) return allTools();
  registerTools([
    ...memoryTools,
    ...workTools,
    ...musicTools,
    ...crmTools,
    ...contentTools,
    ...financeTools,
    ...analyticsTools,
    ...researchTools,
    ...fileTools,
    ...audioTools,
    ...campaignTools,
    ...intelligenceTools,
  ]);
  registered = true;
  return allTools();
}

export { allTools };
