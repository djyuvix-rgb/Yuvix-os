import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

/**
 * Gives a test file its own SQLite database.
 *
 * Vitest runs each file in its own fork, so setting DATABASE_URL here — before
 * any dynamic `import()` constructs the Prisma client — keeps files from
 * clobbering each other's data when they run in parallel.
 */
export function useTestDatabase(name: string) {
  const file = `test-${name}.db`;
  rmSync(`prisma/${file}`, { force: true });
  rmSync(`prisma/${file}-journal`, { force: true });
  process.env.DATABASE_URL = `file:./${file}`;
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: `file:./${file}` },
    stdio: "pipe",
  });
}
