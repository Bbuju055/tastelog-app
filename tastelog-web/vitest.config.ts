import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Match typical Next.js tsconfig alias: "@/*" -> "./src/*"
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
