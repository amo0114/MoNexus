import { expect, test, type Locator } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi } from './helpers'

/**
 * SPEC-MERCH-001 / PAR-CMI-001 — Merchandising smoke (T-MERCH-QA-003, AMD-CMI-012 §3.5).
 *
 * Single deterministic happy path (≤400 lines, no sleep/waitForTimeout, serial):
 *   admin 创建推广套餐 → merchant 为自己的 active 商品申请 → admin approve（积分扣款）
 *   → campaign 达 active → Store 单次加载断言 sponsored shelf 的条目级「推广」文字
 *   disclosure 与 organic 不重复计数 → merchant 推广面板可见 active timeline。
 *
 * Status seam (never a raw DB UPDATE / never a forced status):
 *   `requestedStartAt: null`（尽快开始）→ approve 时 billing.resolveChargeSchedule
 *   直接落 `active`（startsAt=now），无需 cron。DB seed（server/src/prisma/seed.ts）
 *   仅提供 fixture 输入（账户/商家自营 active 商品/积分）。
 *
 * 不重复组件测试（已由以下覆盖，本 spec 只证真实 API+DB 端到端接线）：
 *   - badge 顺序 / editorial / partner mark        → src/pages/StorePage.cmi.test.tsx (case C)
 *   - SponsoredShelf 渲染 / a11y / 空态             → src/components/merchandising/SponsoredShelf.test.tsx
 *   - 商家面板各状态文案 / timeline                 → MerchantCampaignPanel.test.tsx
 * 本 spec 的 Store 断言 = 真实数据下 sponsored 条目带强制 disclosure、organic 不重复。
 */

const PACKAGE_CODE = `SMOKE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PACKAGE_LABEL = 'E2E冒烟推广套餐'
const PACKAGE_PLACEMENT = 'store_home_sponsored'
const PACKAGE_DURATION_DAYS = 1
const PACKAGE_PRICE_POINTS = 100
/** seed（server/src/prisma/seed.ts）保证商家恰好一个 active 自营商品。 */
const MERCHANT_PRODUCT_NAME = '商家自营高速节点包'

let productId = 0
let packageId = 0
let campaignId = 0

// ── unknown JSON 类型守卫（镜像 catalog spec 风格，零 any / ts-ignore）─────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 期望正整数，实际: ${String(value)}`)
  }
  return value
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 期望非空字符串，实际: ${String(value)}`)
  }
  return value
}

/** POST /admin/promotion-packages 201 → { package: { id } }。 */
function parseAdminPackage(body: unknown): number {
  const pkg = isRecord(body) && isRecord(body.package) ? body.package : null
  if (!pkg) throw new Error('创建推广套餐响应缺少 package 字段')
  return expectPositiveInteger(pkg.id, '套餐 id')
}

/** 商家 create / admin approve 的 { campaign } 包裹响应。 */
function parseCampaignMutation(body: unknown): { id: number; status: string } {
  const campaign = isRecord(body) && isRecord(body.campaign) ? body.campaign : null
  if (!campaign) throw new Error('推广活动响应缺少 campaign 字段')
  return {
    id: expectPositiveInteger(campaign.id, '活动 id'),
    status: expectString(campaign.status, '活动 status'),
  }
}

/** admin approve 响应：chargedPoints 证明本次 approve 真实扣款。 */
function parseApproveResponse(body: unknown): { id: number; status: string; chargedPoints: number } {
  const campaign = isRecord(body) && isRecord(body.campaign) ? body.campaign : null
  if (!campaign) throw new Error('approve 响应缺少 campaign 字段')
  const charged = campaign.chargedPoints
  if (typeof charged !== 'number' || !Number.isInteger(charged) || charged < 0) {
    throw new Error(`approve 响应 chargedPoints 非法: ${String(charged)}`)
  }
  return {
    id: expectPositiveInteger(campaign.id, '活动 id'),
    status: expectString(campaign.status, '活动 status'),
    chargedPoints: charged,
  }
}

/** merchant 商品列表 → 恰好一个 seed 商家自营商品，返回其 id。 */
function findMerchantProduct(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('商家商品列表响应缺少 items')
  const matches = (body.items as unknown[]).filter((raw) => isRecord(raw) && raw.name === MERCHANT_PRODUCT_NAME)
  if (matches.length !== 1) {
    throw new Error(`期望恰好一个 seed 商家商品「${MERCHANT_PRODUCT_NAME}」，实际: ${matches.length}`)
  }
  return expectPositiveInteger(matches[0].id, '商家商品 id')
}

/** public sponsored 响应 → 命中商品条目（含强制 disclosure label），未命中返回 null。 */
function findSponsoredItem(body: unknown, expectedProductId: number): string | null {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('sponsored 响应缺少 items')
  for (const raw of body.items) {
    if (!isRecord(raw) || raw.productId !== expectedProductId) continue
    const disclosure = isRecord(raw.disclosure) ? raw.disclosure : null
    if (!disclosure) throw new Error(`sponsored 条目 ${expectedProductId} 缺少 disclosure`)
    return expectString(disclosure.label, 'disclosure label')
  }
  return null
}

async function expectCardReadyForEvidence(card: Locator): Promise<void> {
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect.poll(
    () => card.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const image = element.querySelector('img')
      let current: Element | null = element
      while (current) {
        if (Number(getComputedStyle(current).opacity) < 0.99) return false
        current = current.parentElement
      }
      return rect.width > 100
        && rect.height > 100
        && (element.textContent?.trim().length ?? 0) > 0
        && image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth > 0
    }),
    { message: '商品卡在截图前必须有文字、已加载图片且不透明', timeout: 15_000 },
  ).toBe(true)
}

test.describe.serial('T-MERCH-QA-003 merchandising smoke', () => {
  test('admin creates a package, merchant requests its own active product, admin approves → active + charged', async ({ request }) => {
    const adminSession = await loginAsApi(request, SEED_ACCOUNTS.admin)
    const merchantSession = await loginAsApi(request, SEED_ACCOUNTS.merchant)
    const adminHeaders = { Authorization: `Bearer ${adminSession.accessToken}` }
    const merchantHeaders = { Authorization: `Bearer ${merchantSession.accessToken}` }

    // 1. admin 创建推广套餐（store_home_sponsored，价格/时长由服务端快照锁定）。
    const createPackage = await request.post(`${API_BASE}/api/admin/promotion-packages`, {
      headers: adminHeaders,
      data: {
        code: PACKAGE_CODE,
        label: PACKAGE_LABEL,
        placement: PACKAGE_PLACEMENT,
        durationDays: PACKAGE_DURATION_DAYS,
        pricePoints: PACKAGE_PRICE_POINTS,
        description: 'CMI e2e smoke package',
      },
    })
    expect(createPackage.status(), '创建推广套餐响应状态').toBe(201)
    packageId = parseAdminPackage(await createPackage.json())
    expect(packageId).toBeGreaterThan(0)

    // 2. merchant 读取自己的 active 商品（seed 恰好一个）。
    const listProducts = await request.get(`${API_BASE}/api/merchant/products?status=active&pageSize=100`, {
      headers: merchantHeaders,
    })
    expect(listProducts.status(), '商家商品列表响应状态').toBe(200)
    productId = findMerchantProduct(await listProducts.json())
    expect(productId).toBeGreaterThan(0)

    // 3. merchant 为自己的 active 商品申请推广（requestedStartAt=null → 尽快开始）。
    const createCampaign = await request.post(`${API_BASE}/api/merchant/promotion-campaigns`, {
      headers: { ...merchantHeaders, 'Idempotency-Key': randomUUID() },
      data: { productId, packageId, requestedStartAt: null },
    })
    expect(createCampaign.status(), '创建推广活动响应状态').toBe(201)
    const created = parseCampaignMutation(await createCampaign.json())
    expect(created.status).toBe('pending_review')
    campaignId = created.id

    // 4. admin approve → 立即 active（requestedStartAt=null 由 billing 解析）且积分真实扣款。
    const approve = await request.post(`${API_BASE}/api/admin/promotion-campaigns/${campaignId}/approve`, {
      headers: adminHeaders,
      data: {},
    })
    expect(approve.status(), 'approve 响应状态').toBe(200)
    const approved = parseApproveResponse(await approve.json())
    expect(approved.id).toBe(campaignId)
    expect(approved.status).toBe('active')
    expect(approved.chargedPoints).toBe(PACKAGE_PRICE_POINTS)

    // 5. public sponsored endpoint 返回该商品 + 强制文字 disclosure（真实数据链路预检）。
    const sponsored = await request.get(
      `${API_BASE}/api/products/sponsored?placement=${PACKAGE_PLACEMENT}&limit=6`
    )
    expect(sponsored.status(), 'sponsored 响应状态').toBe(200)
    const disclosureLabel = findSponsoredItem(await sponsored.json(), productId)
    expect(disclosureLabel).toBe('推广')
  })

  test('store home blends the sponsored card into the unified feed with a per-item 推广 disclosure and no organic double-count', async ({ page }) => {
    expect(productId).toBeGreaterThan(0)
    expect(campaignId).toBeGreaterThan(0)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/')

    // 真实数据渲染：被推广商品以普通商品卡混入统一商品流（SPEC-CMI-UX-001 §4）。
    const sponsoredCard = page.getByTestId(`store-product-card-${productId}`)
    await expect(sponsoredCard).toBeVisible({ timeout: 15_000 })
    await expect(sponsoredCard).toContainText(MERCHANT_PRODUCT_NAME)

    // 强制条目级文字 disclosure：与卡片同可见层级，非 tooltip / 纯色。
    const disclosure = sponsoredCard.getByTestId(`store-disclosure-${productId}`)
    await expect(disclosure).toBeVisible({ timeout: 10_000 })
    await expect(disclosure).toHaveText('推广')

    // 同一商品在统一商品流恰好一张卡片（不重复计数）。
    await expect(sponsoredCard).toHaveCount(1)
    // 不再渲染独立 SponsoredShelf。
    await expect(page.getByTestId('merch-sponsored-shelf')).toHaveCount(0)

    // UX-review screenshots (SPEC-CMI-UX-001 reviewer handoff): desktop with
    // the sponsored card blended in, and a no-candidates category view.
    await expectCardReadyForEvidence(sponsoredCard)
    await page.screenshot({ path: 'outputs/cmi-ux-store-with-sponsored.png', fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: '充值卡密' }).click()
    await expect(page.getByTestId(`store-product-card-${productId}`)).toHaveCount(0, { timeout: 10_000 })
    await expectCardReadyForEvidence(page.locator('[data-testid^="store-product-card-"]').first())
    await page.screenshot({ path: 'outputs/cmi-ux-store-no-candidates.png', fullPage: true, animations: 'disabled' })

    // Mobile viewport (compact 2-col grid) with candidates.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const sponsoredMobile = page.getByTestId(`store-product-card-${productId}`)
    await expectCardReadyForEvidence(sponsoredMobile)
    await page.screenshot({ path: 'outputs/cmi-ux-store-with-sponsored-mobile.png', animations: 'disabled' })
  })

  test('merchant campaign panel shows the active campaign with the charged timeline state', async ({ page }) => {
    expect(campaignId).toBeGreaterThan(0)

    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant/promotions')

    // 面板真实加载：active 活动卡片（data-status=active，来自真实 API/DB 状态）。
    const card = page.locator('.merch-campaign-card[data-status="active"]')
    await expect(card).toHaveCount(1, { timeout: 15_000 })
    await expect(card.locator('.merch-status-badge[data-status="active"]')).toHaveText('展示中')

    // timeline 状态机断言（CampaignTimeline data-state 机器契约）：
    // 提交申请(done) → 审核通过已扣 100 积分(done) → 推广展示中(done) → 预计结束(pending)。
    // C2b 修复后 merchant DTO 携带真实 chargedPoints（=套餐价快照），
    // 此处断言精确金额，防止"已扣 0 积分"缺陷回归。
    const doneMilestones = card.locator('.merch-timeline-item[data-state="done"]')
    await expect(doneMilestones.filter({ hasText: '提交申请' })).toHaveCount(1)
    await expect(
      doneMilestones.filter({ hasText: `审核通过，已扣 ${PACKAGE_PRICE_POINTS} 积分` })
    ).toHaveCount(1)
    await expect(doneMilestones.filter({ hasText: '推广展示中' })).toHaveCount(1)
    await expect(
      card.locator('.merch-timeline-item[data-state="pending"]').filter({ hasText: '预计结束' })
    ).toHaveCount(1)
  })
})
