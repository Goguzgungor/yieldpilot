import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Unit tests live next to the lib modules (src/lib/*.test.ts) and in tests/.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Never treat App Router route files / build output as tests.
    exclude: ["node_modules/**", ".next/**", "dist/**", "src/app/**"],
    environment: "node",
    passWithNoTests: true,
  },
});
