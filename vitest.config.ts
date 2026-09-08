import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // The DSP suite analyses real signals; give it room.
    testTimeout: 30_000,
    pool: "forks",
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
