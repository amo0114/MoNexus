import { chromium } from 'playwright'

async function run() {
  const browser = await chromium.launch({ headless: true })

  // 1. Desktop Light Mode
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/10-desktop-merchant-header.png' })

    // Scroll to Shop Card in Page Body
    const shopCard = page.locator('[data-testid="product-merchant-card"]').first()
    if (await shopCard.isVisible()) {
      await shopCard.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: 'outputs/product-audit/11-desktop-shop-card.png' })
    }

    // Click contact button to open Customer Service modal
    const contactBtn = page.locator('[data-testid="merchant-header-contact-btn"]').first()
    if (await contactBtn.isVisible()) {
      await contactBtn.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: 'outputs/product-audit/12-desktop-support-modal.png' })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    await page.close()
  }

  // 2. Mobile Mode (390x844)
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/13-mobile-merchant-strip.png' })

    // Scroll down to test the restored dynamic island pill and see the mobile bottom bar with Store, Support, Favorite
    await page.evaluate(() => window.scrollTo(0, 500))
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/14-mobile-buy-bar-and-pill.png' })

    // Click Support on mobile bottom bar
    const mobileSupportBtn = page.locator('[data-testid="mobile-bar-support-btn"]').first()
    if (await mobileSupportBtn.isVisible()) {
      await mobileSupportBtn.click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: 'outputs/product-audit/15-mobile-support-modal.png' })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }

    await page.close()
  }

  // 3. Desktop Dark Mode
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'outputs/product-audit/16-desktop-dark-mode.png' })
    await page.close()
  }

  await browser.close()
  console.log('Merchant design screenshots captured successfully!')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
