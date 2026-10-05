import { chromium } from 'playwright'

async function run() {
  const browser = await chromium.launch({ headless: true })

  // 1. Desktop Light Mode
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/01-desktop-product1-top.png' })

    // Scroll down halfway to see sticky sidebar and specs
    await page.evaluate(() => window.scrollTo(0, 700))
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/02-desktop-product1-scrolled.png' })

    // Click on image or zoom button to open lightbox
    const zoomBtn = page.locator('button[aria-label="全屏查看图片"]').first()
    if (await zoomBtn.isVisible()) {
      await zoomBtn.click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: 'outputs/product-audit/03-desktop-product1-lightbox.png' })
      // Close lightbox
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    await page.close()
  }

  // 2. Desktop Dark Mode
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark')
    })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/04-desktop-dark-top.png' })
    await page.evaluate(() => window.scrollTo(0, 800))
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'outputs/product-audit/05-desktop-dark-scrolled.png' })
    await page.close()
  }

  // 3. Product 843 (No Images / Virtual Asset)
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto('http://localhost:5173/product/843', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/06-desktop-product843-noimg.png' })
    await page.close()
  }

  // 4. Mobile View (iPhone 14 / 390x844)
  {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/07-mobile-top.png' })

    // Scroll down to check mobile navbar chrome and sticky section tabs
    await page.evaluate(() => window.scrollTo(0, 450))
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/08-mobile-scrolled.png' })

    // Scroll further down to reviews and footer
    await page.evaluate(() => window.scrollTo(0, 1100))
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'outputs/product-audit/09-mobile-reviews.png' })
    await page.close()
  }

  await browser.close()
  console.log('Screenshots captured successfully!')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
