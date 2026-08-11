import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

/**
 * Minimal test configuration for the Catalog Frontend (T-CAT-FE-001A).
 *
 * Scope is deliberately limited to `src/**` so server/ (backend) test suites
 * are never picked up by the frontend runner. `globals: true` enables
 * @testing-library/react auto-cleanup; setup registers jest-dom matchers.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
