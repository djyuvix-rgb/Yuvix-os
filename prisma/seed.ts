/**
 * Bootstrap, not fixtures.
 *
 * This seeds infrastructure only — the workspace tree and the integration
 * registry. It deliberately creates no artist, releases or contacts: fake
 * business data in a system whose core promise is "never invent facts" would
 * poison the first real conversation.
 */
import "../src/server/load-env";
import { ensureWorkspace, WORKSPACE_TREE } from "../src/server/files/workspace";
import { syncIntegrations } from "../src/server/integrations/registry";
import { prisma } from "../src/server/db/client";

async function main() {
  const root = await ensureWorkspace();
  console.log(`✓ Workspace ready at ${root}`);
  console.log(`  ${WORKSPACE_TREE.join(", ")}`);

  const integrations = await syncIntegrations();
  const connected = integrations.filter((i) => i.configured);
  console.log(`✓ ${integrations.length} integrations registered, ${connected.length} connected`);
  for (const i of integrations.filter((x) => !x.configured)) {
    console.log(`  · ${i.name}: needs ${i.missing.join(", ")}`);
  }

  const users = await prisma.user.count();
  console.log(
    users === 0
      ? "→ No account yet. Start the app and open http://localhost:3000 to create the owner account."
      : `✓ ${users} account(s) exist. Sign in at http://localhost:3000`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
