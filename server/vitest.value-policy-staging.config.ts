import { defineConfig } from 'vitest/config'

// Pure staging-governance guard tests: no Prisma, Redis, or network.
export default defineConfig({
  test: {
    name: 'value-policy-staging-governance',
    globals: false,
    include: ['src/modules/valuePolicy/stagingGovernanceInput.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
    },
  },
})
