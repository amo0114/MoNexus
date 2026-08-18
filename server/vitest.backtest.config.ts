import { defineConfig } from 'vitest/config'

// Isolated from the server suite: no Prisma, no TEST_DATABASE_URL, no network.
export default defineConfig({
  test: {
    name: 'value-policy-backtest',
    globals: false,
    include: ['src/modules/valuePolicyBacktest/**/*.test.ts'],
    fileParallelism: true,
    testTimeout: 20000,
    env: {
      NODE_ENV: 'test',
    },
  },
})
