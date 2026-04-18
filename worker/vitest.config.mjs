import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        isolatedStorage: true,
        wrangler: {
          configPath: "./wrangler.toml",
        },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
