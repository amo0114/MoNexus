// Shared Catalog/Merch component and accessibility test setup.
import { afterEach, expect } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toHaveNoViolations } from 'vitest-axe/dist/matchers.js'

expect.extend({ toHaveNoViolations })

// Ensure React's act() environment is enabled and the DOM is cleaned between
// component tests (independent of vitest `globals`).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement window.matchMedia; appStore.showToast reads it to
// route notifications. Provide a minimal query-only stub (test infra only).
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}
afterEach(() => {
  cleanup()
})
