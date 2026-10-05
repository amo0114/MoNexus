import { chromium } from 'playwright'
import fs from 'fs'

async function run() {
  if (!fs.existsSync('outputs/island-audit')) {
    fs.mkdirSync('outputs/island-audit', { recursive: true })
  }
  const browser = await chromium.launch({ headless: true })

  // 1. Mobile Light - Normal Top Nav
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'outputs/island-audit/01-mobile-light-normal-nav.png' })

    // 2. Mobile Light - Trigger "兑换成功" Island Activity
    await page.evaluate(() => {
      const store = window.__appStore?.getState()
      if (store) {
        store.triggerIslandActivity({
          kind: 'order_success',
          title: '兑换成功',
          badge: '即时下发',
          subtitle: '已扣除 3 积分 · 默认规格',
          actionLabel: '查看卡密',
          durationMs: 15000,
        })
      }
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'outputs/island-audit/02-mobile-light-order-success-island.png' })
    await page.close()
  }

  // 3. Mobile Dark - "兑换成功" Island
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark')
    })
    await page.goto('http://localhost:5173/product/1', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)

    await page.evaluate(() => {
      const store = window.__appStore?.getState()
      if (store) {
        store.triggerIslandActivity({
          kind: 'order_success',
          title: '兑换成功',
          badge: '即时下发',
          subtitle: '已扣除 3 积分 · 默认规格',
          actionLabel: '查看卡密',
          durationMs: 15000,
        })
      }
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'outputs/island-audit/03-mobile-dark-order-success-island.png' })
    await page.close()
  }

  await browser.close()
  console.log('Screenshots captured successfully!')
}

run().catch(console.error)
