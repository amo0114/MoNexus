import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Frontend unit tests: single unified config (catalog/merch component tests +
// pure-logic realtime/utils tests). jsdom is a superset of node for the
// pure-logic suites, so one environment covers both. DOM-driven component
// tests rely on the jsdom environment, globals, and the shared setup file.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': srcDir,
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
