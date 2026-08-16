import { defineConfig } from '@playwright/test'
import catalogOpsConfig from './playwright.catalog-ops.config'

/**
 * Asset regression lane: reuse the isolated Catalog-ops servers/DB contract
 * while selecting only the existing gallery and merchant-inventory specs.
 * Image2 concept/runtime delivery remains Deferred by AMD-CMI-012.
 */
export default defineConfig({
  ...catalogOpsConfig,
  testMatch: [
    'product-gallery-interactions.spec.ts',
  ],
})
