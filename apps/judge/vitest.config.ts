import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Docker-backed tests start real containers; keep them sequential and give them time.
    fileParallelism: false,
    env: { LOG_LEVEL: "silent" },
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
