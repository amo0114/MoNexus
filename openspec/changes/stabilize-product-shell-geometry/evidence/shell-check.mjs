// Shell geometry while the product detail route loads (review evidence for
// stabilize-product-shell-geometry; not part of any E2E suite or CI job).
//
// Usage, from the repository root on the revision under test:
//   npm run build
//   npx vite preview --port 5299 --strictPort --host 127.0.0.1 &
//   node openspec/changes/stabilize-product-shell-geometry/evidence/shell-check.mjs <out-dir> [--baseline <results.json>]
//
// All /api requests are stubbed in the browser. Two fixed external states:
//   guest  — no announcements, no email banner
//   member — signed-in user with an unverified email (email banner shown)
// Phases on a cold /product/42 load (detail CSS, detail JS and the product
// API each held, then released in this order):
//   t0 route fallback painted, detail CSS not applied
//   t1 detail CSS applied, JS still held
//   t2 page module rendered, product API still held (data-loading skeleton)
//   t3 product rendered
// Measured: horizontal edges and all paddings of the header shell, of every
// banner and of the footer row (their vertical position follows page height
// and is not compared); <main> content box (x, top, width) and paddings.
// Hard checks: each held resource was requested once, the detail CSS applied,
// required nodes exist, t0 = t1 = t2 = t3, and with --baseline t3 equals the
// baseline's t3. Member runs also check that after client-side navigation to
// /orders (URL, orders page and shell nodes asserted, no page errors) the shell
// equals a direct cold load of /orders.
// Styles: member, light and dark themes at 1024/1280/1920, fully loaded product
// page; computed max-width, paddings and backgrounds of the layout root,
// header, banners, main and footer. With --baseline they must equal the
// baseline's snapshot.
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5299'
const args = process.argv.slice(2)
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : 'shell-check-out'
const baselinePath = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : null
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [[390, 900], [767, 900], [768, 900], [1023, 900], [1024, 900], [1279, 900], [1280, 900], [1920, 1000]]
const PRODUCT = {
  id: 42, name: '外壳核验商品', description: 'desc', type: '充值卡密', icon: 'box', imageUrl: '', images: [],
  price: 100, stock: 10, stockMode: 'limited', sales: 0, merchant: null, visibility: 'public',
  offers: [{ id: 7, name: '默认规格', price: 100, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 10, sales: 0 }],
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
// Structurally valid but unsigned; only the browser-side session parser reads it.
const TOKEN = `${b64url({ alg: 'none' })}.${b64url({ userId: 9, sid: 'shell-check', exp: 4102444800 })}.x`
const MEMBER = { id: 9, email: 'member@example.test', nickname: '核验用户', role: 'user', points: 0, emailVerified: false, accountStatus: 'active' }
const LOADING = '[role="status"][aria-label^="正在加载"]'

const held = () => { let release; const promise = new Promise((r) => { release = r }); return { promise, release, hits: 0 } }

async function stubApi(page, productGate) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/products/42') {
      if (productGate) { productGate.hits += 1; await productGate.promise }
      return route.fulfill({ json: PRODUCT })
    }
    if (path === '/auth/me') return route.fulfill({ json: MEMBER })
    if (path === '/announcements') return route.fulfill({ json: [] })
    if (path === '/product-templates') return route.fulfill({ json: { templates: [] } })
    if (path.startsWith('/products/42/reviews')) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'stub' } } })
  })
}

async function newPage(width, height, mode, theme = null) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme)
  if (mode === 'member') {
    await ctx.addInitScript(([user, token]) => {
      localStorage.setItem('monexus-auth', JSON.stringify({ state: { user, isLoggedIn: true, accessToken: token, sessionId: 'shell-check' }, version: 0 }))
    }, [MEMBER, TOKEN])
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  return { ctx, page, errors }
}

const shell = (page) => page.evaluate(() => {
  const pad = (cs) => ['Top', 'Right', 'Bottom', 'Left'].map((s) => Math.round(parseFloat(cs[`padding${s}`])))
  const edges = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
    return { x: Math.round(r.x), w: Math.round(r.width), pad: pad(cs) }
  }
  const header = document.querySelector('.navbar-shell')
  const main = document.querySelector('main')
  const footer = document.querySelector('footer .chrome-bound')
  const banners = [...document.querySelectorAll('.chrome-bound')].filter((el) => el !== header && !el.closest('footer'))
  let mainBox = null
  if (main) {
    const r = main.getBoundingClientRect(); const cs = getComputedStyle(main); const p = pad(cs)
    mainBox = { x: Math.round(r.x + p[3]), top: Math.round(r.y + p[0]), w: Math.round(r.width - p[1] - p[3]), pad: p }
  }
  return {
    header: header && edges(header),
    banners: banners.map((el) => ({ id: el.getAttribute('data-testid') ?? el.className.split(' ')[0], ...edges(el) })),
    main: mainBox,
    footer: footer && edges(footer),
  }
})

const revision = execSync('git rev-parse HEAD').toString().trim()
const dirtyFiles = execSync('git status --porcelain').toString().trim().split('\n').filter(Boolean)
const results = { revision, dirtyFiles, base: BASE, baseline: baselinePath, runs: [] }
const failures = []
const fail = (msg) => failures.push(msg)
const browser = await chromium.launch()

for (const mode of ['guest', 'member']) {
  for (const [width, height] of VIEWPORTS) {
    const tag = `${mode}@${width}x${height}`
    const { ctx, page, errors } = await newPage(width, height, mode)
    const css = held(); const js = held(); const api = held()
    await page.route('**/assets/ProductDetailPage-*.css', async (route) => { css.hits += 1; await css.promise; await route.continue() })
    await page.route('**/assets/ProductDetailPage-*.js', async (route) => { js.hits += 1; await js.promise; await route.continue() })
    await stubApi(page, api)
    await page.goto(`${BASE}/product/42`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`${LOADING}[aria-label="正在加载页面"]`)
    const t0 = await shell(page)
    css.release()
    const cssApplied = await page.waitForFunction(
      () => [...document.styleSheets].some((s) => (s.href ?? '').includes('/ProductDetailPage-')),
      null, { timeout: 15000 },
    ).then(() => true, () => false)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const t1 = await shell(page)
    js.release()
    await page.waitForSelector('[data-testid="product-detail-loading"]')
    const t2 = await shell(page)
    api.release()
    await page.getByText('外壳核验商品').first().waitFor()
    const t3 = await shell(page)
    const run = { run: tag, holds: { css: css.hits, js: js.hits, api: api.hits }, cssApplied, t0, t1, t2, t3, pageErrors: errors }

    if (css.hits !== 1 || js.hits !== 1 || api.hits !== 1) fail(`${tag} resource holds ${JSON.stringify(run.holds)}`)
    if (!cssApplied) fail(`${tag} detail CSS not applied`)
    if (errors.length) fail(`${tag} page errors`)
    for (const [phase, s] of Object.entries({ t0, t1, t2, t3 })) {
      if (!s.header || !s.main || !s.footer) fail(`${tag} ${phase} missing shell node`)
      if (mode === 'member' && width >= 768 && s.banners.length === 0) fail(`${tag} ${phase} email banner missing`)
    }
    const key = JSON.stringify(t3)
    for (const [phase, s] of Object.entries({ t0, t1, t2 })) if (JSON.stringify(s) !== key) fail(`${tag} ${phase} ≠ t3`)
    if (baseline) {
      const prev = baseline.runs.find((r) => r.run === tag)
      if (!prev) fail(`${tag} missing in baseline`)
      else if (JSON.stringify(prev.t3) !== key) fail(`${tag} final shell differs from baseline`)
    }

    if (mode === 'member') {
      // Leave the product route client-side, then compare with a cold /orders load.
      await page.evaluate(() => { window.history.pushState({}, '', '/orders'); window.dispatchEvent(new PopStateEvent('popstate')) })
      const errorsBeforeNav = errors.length
      await page.waitForFunction(() => !document.querySelector('.product-layout'), null, { timeout: 15000 })
      const reachedOrders = await page.waitForSelector('[data-testid="orders-page"]', { timeout: 15000 }).then(() => true, () => false)
      await page.waitForLoadState('networkidle')
      run.ordersAfterNav = await shell(page)
      run.ordersAfterNavCheck = { path: new URL(page.url()).pathname, ordersPage: reachedOrders, pageErrors: errors.length - errorsBeforeNav }
      const direct = await newPage(width, height, mode)
      await stubApi(direct.page, null)
      await direct.page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' })
      const directOrders = await direct.page.locator('[data-testid="orders-page"]').count()
      run.ordersDirect = await shell(direct.page)
      run.ordersDirectCheck = { path: new URL(direct.page.url()).pathname, ordersPage: directOrders === 1, pageErrors: direct.errors.length }
      await direct.ctx.close()
      for (const [label, check, snap] of [['after nav', run.ordersAfterNavCheck, run.ordersAfterNav], ['direct', run.ordersDirectCheck, run.ordersDirect]]) {
        if (check.path !== '/orders' || !check.ordersPage || check.pageErrors) fail(`${tag} /orders ${label} ${JSON.stringify(check)}`)
        if (!snap.header || !snap.main || !snap.footer) fail(`${tag} /orders ${label} missing shell node`)
      }
      if (JSON.stringify(run.ordersAfterNav) !== JSON.stringify(run.ordersDirect)) fail(`${tag} /orders shell after leaving product ≠ direct load`)
    }
    results.runs.push(run)
    await ctx.close()
  }
}

// Computed styles of the fully loaded product shell, per theme.
const styleProps = ['maxWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'backgroundImage']
results.styles = []
for (const theme of ['light', 'dark']) {
  for (const width of [1024, 1280, 1920]) {
    const tag = `member@${width}/${theme}`
    const { ctx, page, errors } = await newPage(width, 900, 'member', theme)
    await stubApi(page, null)
    await page.goto(`${BASE}/product/42`, { waitUntil: 'networkidle' })
    await page.getByText('外壳核验商品').first().waitFor()
    const snap = await page.evaluate((props) => {
      const pick = (el) => el && Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]))
      const header = document.querySelector('.navbar-shell')
      return {
        // ThemeProvider: dark → html.dark; soft/ink → data-theme; light → neither.
        theme: document.documentElement.classList.contains('dark') ? 'dark' : (document.documentElement.getAttribute('data-theme') ?? 'light'),
        root: pick(document.querySelector('.product-layout')),
        header: pick(header),
        banners: [...document.querySelectorAll('.chrome-bound')].filter((el) => el !== header && !el.closest('footer')).map(pick),
        main: pick(document.querySelector('main')),
        footer: pick(document.querySelector('footer .chrome-bound')),
      }
    }, styleProps)
    results.styles.push({ run: tag, ...snap })
    if (snap.theme !== theme || !snap.root || !snap.header || !snap.main || !snap.footer || snap.banners.length === 0) fail(`${tag} style snapshot incomplete`)
    if (errors.length) fail(`${tag} page errors`)
    if (baseline?.styles) {
      const prev = baseline.styles.find((r) => r.run === tag)
      if (!prev) fail(`${tag} styles missing in baseline`)
      else if (JSON.stringify(prev) !== JSON.stringify({ run: tag, ...snap })) fail(`${tag} computed styles differ from baseline`)
    }
    await ctx.close()
  }
}

await browser.close()
results.failures = failures
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(failures.length ? `FAIL (${failures.length})\n${failures.join('\n')}` : 'ALL HARD CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
