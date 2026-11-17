// One-off browser evidence for align-route-loading-skeletons (review attachment,
// not part of any E2E suite or CI job).
//
// Usage, from the repository root on the revision under review:
//   npm run build
//   npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
//   node openspec/changes/align-route-loading-skeletons/evidence/loading-check.mjs <out-dir>
//
// All /api requests are stubbed in the browser; no backend or database is used.
// Scenarios, per viewport:
//   A. Hold the ProductDetailPage JS chunk, then the product API. Measure the
//      skeleton gallery and summary column in phase 1 (route chunk) and phase 2
//      (product data), then the real gallery/purchase column once loaded.
//   B. Hold the ProductDetailPage CSS and JS chunks together, then release both.
//      Reports how far the phase-1 skeleton moves once the detail CSS applies.
//   C. /terms (outside the shell) and /shops/7 (grid) chunk placeholders.
// Exits 1 when a hard check fails; layout deltas are reported, not judged.
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5299'
const OUT = process.argv[2] ?? 'loading-check-out'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  [390, 900], [767, 900], [768, 900], [1023, 900], [1024, 900],
  [1279, 900], [1280, 900], [1280, 720], [1920, 1000],
]
const PRODUCT = {
  id: 42, name: '骨架核验商品', description: 'desc', type: '充值卡密', icon: 'box', imageUrl: '', images: [],
  price: 100, stock: 10, stockMode: 'limited', sales: 0, merchant: null, visibility: 'public',
  offers: [{ id: 7, name: '默认规格', price: 100, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 10, sales: 0 }],
}
const LOADING = '[role="status"][aria-label^="正在加载"]'

function held() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

async function stubApi(page, productGate) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/products/42') {
      if (productGate) await productGate.promise
      return route.fulfill({ json: PRODUCT })
    }
    if (path === '/product-templates') return route.fulfill({ json: { templates: [] } })
    if (path.startsWith('/products/42/reviews')) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'stub' } } })
  })
}

async function hold(page, pattern, gate) {
  await page.route(pattern, async (route) => { await gate.promise; await route.continue() })
}

const rect = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}, selector)
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const SKELETON_GALLERY = '[data-skeleton-part="gallery"] > *'
const SKELETON_SUMMARY = '[data-skeleton-part="summary"]'
function realSelectors(width) {
  if (width >= 1024) return { gallery: ".pd-gallery-slot [data-testid='product-gallery'] > div > div:last-child", summary: '.pd-purchase' }
  if (width >= 768) return { gallery: "[data-testid='product-gallery']", summary: null }
  return { gallery: '.pm-gallery', summary: null }
}

const revision = execSync('git rev-parse HEAD').toString().trim()
const dirty = execSync('git status --porcelain').toString().trim() !== ''
const results = { revision, dirty, base: BASE, viewports: [] }
const failures = []
const browser = await chromium.launch()

for (const [width, height] of VIEWPORTS) {
  const tag = `${width}x${height}`
  const row = { viewport: tag }

  // A. JS chunk, then product API.
  {
    const reduce = width === 390
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduce ? 'reduce' : 'no-preference' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    const js = held(); const api = held()
    await hold(page, '**/assets/ProductDetailPage-*.js', js)
    await stubApi(page, api)
    await page.goto(`${BASE}/product/42`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`${LOADING} [data-testid="product-detail-skeleton"]`)
    const phase1 = { gallery: await rect(page, SKELETON_GALLERY), summary: await rect(page, SKELETON_SUMMARY), overflow: await overflow(page) }
    const statusCount = await page.locator(LOADING).count()
    const nested = await page.locator(`${LOADING} [role="status"]`).count()
    await page.screenshot({ path: join(OUT, `${tag}-A1-route-chunk.png`) })
    js.release()
    await page.waitForSelector('[data-testid="product-detail-loading"]')
    const phase2 = { gallery: await rect(page, SKELETON_GALLERY), summary: await rect(page, SKELETON_SUMMARY), overflow: await overflow(page) }
    const leaked = await page.getByText('骨架核验商品').count()
    const focusable = await page.locator('[data-testid="product-detail-skeleton"] :is(a, button, input, select, textarea, [tabindex])').count()
    const anim = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('[data-testid="product-detail-skeleton"] .animate-pulse'))
      return { duration: cs.animationDuration, iterations: cs.animationIterationCount }
    })
    await page.screenshot({ path: join(OUT, `${tag}-A2-product-api.png`) })
    api.release()
    await page.waitForSelector('[data-testid="product-detail-loading"]', { state: 'detached' })
    await page.getByText('骨架核验商品').first().waitFor()
    const real = realSelectors(width)
    const loaded = {
      gallery: await rect(page, real.gallery),
      summary: real.summary ? await rect(page, real.summary) : null,
      overflow: await overflow(page),
    }
    await page.screenshot({ path: join(OUT, `${tag}-A3-loaded.png`) })
    row.A = { phase1, phase2, loaded, statusCount, nested, leaked, focusable, anim, reducedMotion: reduce, pageErrors: errors.length }
    if (statusCount !== 1 || nested || leaked || focusable || errors.length) failures.push(`${tag} A structure`)
    if (phase1.overflow > 0 || phase2.overflow > 0 || loaded.overflow > 0) failures.push(`${tag} A overflow`)
    if (JSON.stringify(phase1) !== JSON.stringify(phase2)) failures.push(`${tag} A phase1≠phase2`)
    if (reduce && !(anim.iterations === '1' && parseFloat(anim.duration) < 0.01)) failures.push(`${tag} reduced motion`)
    await ctx.close()
  }

  // B. Detail CSS held together with the JS chunk.
  {
    const ctx = await browser.newContext({ viewport: { width, height } })
    const page = await ctx.newPage()
    const chunk = held()
    await hold(page, '**/assets/ProductDetailPage-*.js', chunk)
    await hold(page, '**/assets/ProductDetailPage-*.css', chunk)
    await stubApi(page, held())
    await page.goto(`${BASE}/product/42`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`${LOADING} [data-testid="product-detail-skeleton"]`)
    const noCss = { gallery: await rect(page, SKELETON_GALLERY), summary: await rect(page, SKELETON_SUMMARY), overflow: await overflow(page) }
    chunk.release()
    await page.waitForSelector('[data-testid="product-detail-loading"]')
    const withCss = { gallery: await rect(page, SKELETON_GALLERY), summary: await rect(page, SKELETON_SUMMARY), overflow: await overflow(page) }
    row.B = { noCss, withCss }
    if (noCss.overflow > 0 || withCss.overflow > 0) failures.push(`${tag} B overflow`)
    await ctx.close()
  }

  // C. Placeholders outside the product route.
  row.C = {}
  for (const [path, chunkPattern, selector] of [
    ['/terms', '**/assets/LegalDocumentPage-*.js', `${LOADING}.min-h-screen`],
    ['/shops/7', '**/assets/ShopPage-*.js', '[data-fallback-kind="storefront"]'],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height } })
    const page = await ctx.newPage()
    const gate = held()
    await hold(page, chunkPattern, gate)
    await stubApi(page, null)
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(selector)
    const o = await overflow(page)
    const shapes = await page.locator(`${selector} .animate-pulse`).count()
    await page.screenshot({ path: join(OUT, `${tag}-C${path.replace(/\W+/g, '_')}.png`) })
    gate.release()
    row.C[path] = { overflow: o, shapes }
    if (o > 0 || shapes === 0) failures.push(`${tag} C ${path}`)
    await ctx.close()
  }
  results.viewports.push(row)
}

await browser.close()
results.failures = failures
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(failures.length ? `FAIL ${failures.join('; ')}` : 'ALL HARD CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
