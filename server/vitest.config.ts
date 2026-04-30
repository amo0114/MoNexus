import { defineConfig } from 'vitest/config'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required to run tests without truncating the development database')
}

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      PORT: '3099',
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: 'test-secret-key-at-least-32-characters-long!!',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
    },
  },
})
