/**
 * Loads .env for processes Next.js does not start (the job worker, the seed
 * script, tests). Next.js loads it automatically, so importing this there is
 * harmless — real environment variables always win.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const files = [".env.local", ".env"];
for (const file of files) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  try {
    // Node 20.12+ / 22: parses the file and sets only variables not already set.
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not take the process down; the missing variable
    // will surface as a clear "not configured" message instead.
  }
}
