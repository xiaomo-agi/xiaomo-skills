import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/concurrency.test.ts"], // 独立脚本，需手动运行
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text"],
    },
  },
});
