// Shell geometry while the product detail route loads (proposal-stage evidence).
//
// Usage, from the repository root on the revision under test:
//   npm run build
//   npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
//   node openspec/changes/stabilize-product-shell-geometry/evidence/shell-check.mjs <out-dir>
//
// All /api requests are stubbed. Per viewport, the ProductDetailPage JS chunk is
// held for the whole run while its CSS chunk is held, then released:
//   t0 = route fallback painted, detail CSS not yet applied
//   t1 = detail CSS applied, still on the route fallback (JS held)
//   t2 = page rendered after the JS chunk is released
// Measured: header shell (.navbar-shell) and footer (.chrome-bound inside
// <footer>) horizontal edges; <main> content box after padding. Exit code is 1 when any box differs between t0 and t2.
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5299'
const OUT = process.argv[2] ?? 'shell-check-out'
mkdirSync(OUT, { recursive: true })
const VIEWPORTS = [[390, 900], [768, 900], [1024, 900], [1279, 900], [1280, 900], [1920, 1000]]
const PRODUCT = {
  id: 42, name: '外壳核验商品', description: 'desc', type: '充值卡密', icon: 'box', imageUrl: '', images: [],
  price: 100, stock: 10, stockMode: 'limited', sales: 0, merchant: null, visibility: 'public',
  offers: [{ id: 7, name: '默认规格', price: 100, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 10, sales: 0 }],
}
const held = () => { let release; const promise = new Promise((r) => { release = r }); return { promise, release } }
// Header and footer: horizontal edges only (their y follows page height).
// Main: content box, i.e. where page content starts after padding.
const boxes = (page) => page.evaluate(() => {
  const edges = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) } }
  const content = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    const pl = parseFloat(cs.paddingLeft); const pr = parseFloat(cs.paddingRight); const pt = parseFloat(cs.paddingTop)
    return { x: Math.round(r.x + pl), y: Math.round(r.y + pt), w: Math.round(r.width - pl - pr) }
  }
  return { header: edges(document.querySelector('.navbar-shell')), main: content(document.querySelector('main')), footer: edges(document.querySelector('footer .chrome-bound')) }
})

const revision = execSync('git rev-parse HEAD').toString().trim()
const dirty = execSync('git status --porcelain').toString().trim() !== ''
const results = { revision, dirty, base: BASE, viewports: [] }
const moved = []
const browser = await chromium.launch()
for (const [width, height] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const page = await ctx.newPage()
  const css = held(); const js = held()
  let cssApplied = null
  await page.route('**/assets/ProductDetailPage-*.css', async (route) => { await css.promise; await route.continue() })
  await page.route('**/assets/ProductDetailPage-*.js', async (route) => { await js.promise; await route.continue() })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/products/42') return route.fulfill({ json: PRODUCT })
    if (path === '/product-templates') return route.fulfill({ json: { templates: [] } })
    if (path.startsWith('/products/42/reviews')) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'stub' } } })
  })
  await page.goto(`${BASE}/product/42`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[role="status"][aria-label="正在加载页面"]')
  const t0 = await boxes(page)
  css.release()
  cssApplied = await page.waitForFunction(() => [...document.styleSheets].some((s) => (s.href ?? '').includes('ProductDetailPage-')), null, { timeout: 15000 }).then(() => true, () => false)
  await page.waitForTimeout(100)
  const t1 = await boxes(page)
  js.release()
  await page.getByText('外壳核验商品').first().waitFor()
  const t2 = await boxes(page)
  const changed = JSON.stringify(t0) !== JSON.stringify(t2)
  if (changed) moved.push(`${width}x${height}`)
  results.viewports.push({ viewport: `${width}x${height}`, cssApplied, t0, t1, t2, changed })
  await ctx.close()
}
await browser.close()
results.moved = moved
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(moved.length ? `SHELL MOVED at ${moved.join(', ')}` : 'SHELL STABLE')
process.exit(moved.length ? 1 : 0)
