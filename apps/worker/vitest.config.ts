import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../desk/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    env: { LOG_LEVEL: "silent" },
  },
});
