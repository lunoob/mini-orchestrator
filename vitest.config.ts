import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fork worker 通过 env 继承 NODE_OPTIONS 获取更大堆空间
    env: {
      NODE_OPTIONS: "--max-old-space-size=8192",
    },
  },
})
