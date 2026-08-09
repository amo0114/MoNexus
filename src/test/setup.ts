// Shared test setup for merchandising component/contract/a11y tests.
// Registers jest-dom + vitest-axe matchers and cleans up after each test.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, expect } from 'vitest'
import { toHaveNoViolations } from 'vitest-axe/dist/matchers.js'

expect.extend({ toHaveNoViolations })

afterEach(() => {
  cleanup()
})
