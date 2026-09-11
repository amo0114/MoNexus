import { expect, test } from '@playwright/test'
import {
  SEED_ACCOUNTS,
  fillWizardOfferAttributes,
  fillWizardPublicationDetails,
  loginAs,
} from './helpers'

const PRESET_PRODUCT_NAME = `E2E预设素材全链路-${Date.now()}`

test.describe.serial('Product preset lifecycle E2E', () => {
  let productId = 0

  test('merchant creates product with preset, saves, reopens in edit page, and publishes for buyer display', async ({
    page,
  }) => {
    // 1. Merchant logs in and opens wizard
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant/products/new')
    await expect(page.getByTestId('product-create-wizard')).toBeVisible({ timeout: 10_000 })

    // Select template: fixed_content
    await page.getByTestId('template-fixed_content').click()
    await page.getByTestId('wizard-next').click()

    // Fill basic info
    await page.getByTestId('wizard-name').fill(PRESET_PRODUCT_NAME)

    // Open preset selection panel and pick AI Token preset
    await page.getByTestId('product-image-presets-toggle').click()
    await expect(page.getByTestId('product-image-presets-panel')).toBeVisible()

    const aiTokenPresetBtn = page.getByTestId('product-preset-ai_token')
    await expect(aiTokenPresetBtn).toBeVisible()
    await aiTokenPresetBtn.click()

    // Verify preset is reflected in image list
    const imageList = page.getByTestId('product-images-list')
    await expect(imageList.locator('img')).toHaveCount(1, { timeout: 10_000 })
    const imageSrc = await imageList.locator('img').first().getAttribute('src')
    expect(imageSrc).toContain('/assets/presets/preset_ai_token.webp')

    // Verify LivePreviewSandbox in wizard renders the preset image
    const sandboxCover = page.getByTestId('live-preview-sandbox').locator('img').first()
    await expect(sandboxCover).toBeVisible()
    const sandboxCoverSrc = await sandboxCover.getAttribute('src')
    expect(sandboxCoverSrc).toContain('/assets/presets/preset_ai_token.webp')

    // Fill category & publication details
    const category = page.getByTestId('product-category-select')
    if (!(await category.inputValue())) {
      await category.selectOption({ index: 1 })
    }
    await fillWizardPublicationDetails(page)
    await page.getByTestId('wizard-next').click()

    // Step 2: pricing
    await page.getByTestId('wizard-price').fill('10')
    await fillWizardOfferAttributes(page)
    await page.getByTestId('wizard-next').click()

    // Step 3: fulfillment
    await page.getByRole('radio', { name: '外部链接' }).check()
    await page.getByTestId('fixed-content-input').fill('https://example.com/preset-delivery')
    await page.getByTestId('wizard-next').click()

    // Step 4: save draft
    await page.getByTestId('wizard-save-draft').click()
    await expect(page.getByTestId('wizard-step-availability')).toBeVisible({ timeout: 10_000 })

    // Step 5: availability -> publication readiness
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('publication-ready')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('publication-publish').click()
    await expect(page).toHaveURL(/\/merchant(?:\/|$)/, { timeout: 10_000 })

    // 2. Re-open edit page and verify preset preservation
    await page.getByRole('button', { name: '商品管理' }).click()
    await page.getByTestId('merchant-product-search').fill(PRESET_PRODUCT_NAME)
    const productRow = page.locator('tbody tr').filter({ hasText: PRESET_PRODUCT_NAME }).first()
    await expect(productRow).toBeVisible({ timeout: 10_000 })

    await productRow.getByRole('button', { name: '编辑' }).click()
    await expect(page).toHaveURL(/\/merchant\/products\/(\d+)\/edit/, { timeout: 10_000 })
    const match = page.url().match(/\/merchant\/products\/(\d+)\/edit/)
    expect(match).toBeTruthy()
    productId = Number(match![1])

    // Verify preset image is in the edit page image list
    const editImageList = page.getByTestId('product-images-list')
    await expect(editImageList.locator('img')).toHaveCount(1, { timeout: 10_000 })
    const editImgSrc = await editImageList.locator('img').first().getAttribute('src')
    expect(editImgSrc).toContain('/assets/presets/preset_ai_token.webp')

    // Verify LivePreviewSandbox in edit page displays the preset image
    const editSandboxCover = page.getByTestId('live-preview-sandbox').locator('img').first()
    await expect(editSandboxCover).toBeVisible()
    const editSandboxSrc = await editSandboxCover.getAttribute('src')
    expect(editSandboxSrc).toContain('/assets/presets/preset_ai_token.webp')

    // 3. Buyer visits product detail page and verifies preset image display
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${productId}`)
    await expect(page.getByTestId('product-gallery')).toBeVisible({ timeout: 10_000 })

    // Verify 4:3 main gallery displays the preset WebP image
    const galleryMain = page.getByTestId('product-gallery-main')
    await expect(galleryMain).toBeVisible({ timeout: 10_000 })
    const galleryImgSrc = await galleryMain.getAttribute('src')
    expect(galleryImgSrc).toContain('/assets/presets/preset_ai_token.webp')
  })
})
