import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi } from './helpers'

/**
 * SPEC-CATALOG-OPS / PAR-CMI-001 — Catalog product lifecycle 前置段（极窄 E2E 卡）。
 *
 * 范围仅覆盖生命周期前置段（CHK-PROD-007：public detail/checkout 拒绝 draft）：
 * 1. 商家经 /merchant/products/new 向导创建名称唯一、limited 名额、保持 draft 的商品；
 * 2. 点击真实创建动作前监听 POST /api/merchant/products，用类型守卫从 unknown JSON
 *    安全取得正整数 productId；create 响应未内嵌默认 Offer 时，从创建后的真实 UI
 *    （可售量步的规格选择器）读取默认 Offer id —— 全程零写 API；
 * 3. 用只读 HTTP 断言 draft 对公开商品详情与 checkout preview 均不可用
 *    （400 BAD_REQUEST，稳定 code），且 preview 显式携带正确 offerId。
 *
 * 本卡追加（merch 侧闭合）：发布被拒（422 PRODUCT_NOT_READY）与 offer-scoped 补 capacity、
 * 成功发布（200 active）与公开详情恢复；buyer checkout 已闭合于第 5 个用例（买家经商城搜索
 * 进入单 SKU 详情，拉起可售结算预览，全程零下单）。
 * 第 6 个用例（本卡）已覆盖 Dashboard UI 下架：POST .../unpublish 200 + status=inactive 精确
 * 匹配 + 行状态回退「未上架」。
 * 第 7 个用例（本卡）已覆盖下架后的公开拒绝：公开商品详情 / 商城搜索 / checkout preview 均
 * 拒绝（400 BAD_REQUEST，稳定 code）。
 * 第 8 个用例（本卡）已覆盖 capacity 保留与重发：下架后 offer capacity 不清空（availability modal
 * 内 current stock 仍为 5），商家从 UI 重新上架成功（200 active + toast「商品已上架」+ 行
 * 「上架中」/按钮「下架」）。
 * 第9个用例已覆盖最终 public detail/store/checkout 恢复，生命周期闭合
 * 硬约束：无 page.reload / waitForTimeout / page.route / DB 直读直写 / 写 API 替代 UI
 * 创建 / Product.stock 操作 / any / as any / ts-ignore。
 */
const PRODUCT_NAME = `E2E目录草稿-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** 同源封面路径（仓库 public/brand/ledger-knot/mark-light.png 真实存在）。 */
const COVER_PATH = '/brand/ledger-knot/mark-light.png'

let productId = 0
let offerId = 0

/** unknown JSON → 记录（类型守卫）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 正整数类型守卫。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 从 create 响应 unknown JSON 安全解析 productId（必须为正整数）。 */
function parseCreatedProduct(body: unknown): { id: number; status: string } {
  if (!isRecord(body)) throw new Error('创建商品响应不是 JSON 对象')
  if (!isPositiveInteger(body.id)) throw new Error('创建商品响应缺少正整数 productId')
  if (typeof body.status !== 'string' || body.status.length === 0) {
    throw new Error('创建商品响应缺少 status')
  }
  return { id: body.id, status: body.status }
}

/** unknown JSON → create 响应封面字段（imageUrl + images），类型守卫；形状不符返回 null。 */
function readCoverFields(body: unknown): { imageUrl: string; images: string[] } | null {
  if (!isRecord(body)) return null
  if (typeof body.imageUrl !== 'string') return null
  if (!Array.isArray(body.images) || body.images.length !== 1) return null
  const first = body.images[0]
  if (typeof first !== 'string') return null
  return { imageUrl: body.imageUrl, images: [first] }
}

/**
 * 若 create 响应内嵌默认 Offer（offerId 字段或 offers[0].id），安全提取；
 * 否则返回 null，由调用方回退到创建后的真实 UI 读取默认 Offer id。
 */
function extractOfferIdFromCreateResponse(body: unknown): number | null {
  if (!isRecord(body)) return null
  if (isPositiveInteger(body.offerId)) return body.offerId
  const offers = body.offers
  if (Array.isArray(offers) && offers.length > 0) {
    const first = offers[0]
    if (isRecord(first) && isPositiveInteger(first.id)) return first.id
  }
  return null
}

/** 从错误响应 unknown JSON 读取稳定 error.code。 */
function readErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null
  const error = body.error
  if (!isRecord(error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function parsePositiveInteger(raw: string, label: string): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 期望正整数，实际: ${raw}`)
  }
  return parsed
}

/** 严格解析非负整数字符串：先 trim，须为纯十进制数字，再 Number.isSafeInteger 且 >= 0；否则 throw。 */
function parseNonNegativeInteger(raw: string, label: string): number {
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${label} 期望非负整数，实际: ${raw}`)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} 期望非负整数，实际: ${raw}`)
  }
  return parsed
}

/** 不可售商品（draft 或下架后 inactive）对 public 入口的拒绝契约：HTTP 400 + 稳定 code BAD_REQUEST。 */
async function expectPublicUnavailable(response: { status(): number; json(): Promise<unknown> }): Promise<void> {
  expect(response.status()).toBe(400)
  const body: unknown = await response.json()
  expect(readErrorCode(body)).toBe('BAD_REQUEST')
}

/** 从错误响应 unknown JSON 读取 error.details（readiness 详情数组）。 */
function readErrorDetails(body: unknown): unknown[] | null {
  if (!isRecord(body)) return null
  const error = body.error
  if (!isRecord(error)) return null
  const details = error.details
  return Array.isArray(details) ? details : null
}

/** details 中是否存在「code + offerId」精确匹配的条目（机器契约，不看 reason 文案）。 */
function hasReadinessDetail(body: unknown, offerId: number, code: string): boolean {
  const details = readErrorDetails(body)
  if (!details) return false
  return details.some((item) => {
    if (!isRecord(item)) return false
    return item.code === code && item.offerId === offerId
  })
}

/** unknown JSON → offer-scoped capacity 请求 payload（类型守卫）。 */
function readCapacityRequest(body: unknown): { delta: number; reason: string } | null {
  if (!isRecord(body)) return null
  if (typeof body.delta !== 'number' || typeof body.reason !== 'string') return null
  return { delta: body.delta, reason: body.reason }
}

/** unknown JSON → 成功响应的 stock 字段（类型守卫）。 */
function readStock(body: unknown): number | null {
  if (!isRecord(body)) return null
  return typeof body.stock === 'number' ? body.stock : null
}
/** publish 成功响应 unknown JSON → 记录；类型守卫断言 id/status 精确匹配（成功即 active）。 */
function parsePublishSuccess(body: unknown, expectedId: number): { id: number; status: string } {
  if (!isRecord(body)) throw new Error('publish 响应不是 JSON 对象')
  if (body.id !== expectedId) {
    throw new Error(`publish 响应 id 不匹配，期望 ${expectedId}，实际: ${String(body.id)}`)
  }
  if (body.status !== 'active') {
    throw new Error(`publish 响应 status 非 active，实际: ${String(body.status)}`)
  }
  return { id: body.id, status: body.status }
}

/** unpublish 成功响应 unknown JSON → 记录；类型守卫断言 id/status 精确匹配（成功即 inactive）。 */
function parseUnpublishSuccess(body: unknown, expectedId: number): { id: number; status: string } {
  if (!isRecord(body)) throw new Error('unpublish 响应不是 JSON 对象')
  if (body.id !== expectedId) {
    throw new Error(`unpublish 响应 id 不匹配，期望 ${expectedId}，实际: ${String(body.id)}`)
  }
  if (body.status !== 'inactive') {
    throw new Error(`unpublish 响应 status 非 inactive，实际: ${String(body.status)}`)
  }
  return { id: body.id, status: body.status }
}

/** 产品详情 unknown JSON → 命中指定 offerId 的 Offer 记录（类型守卫）；未命中返回 null。 */
function findOfferInProductDetail(body: unknown, expectedProductId: number, expectedOfferId: number): { id: number; stock: number } | null {
  if (!isRecord(body) || body.id !== expectedProductId || !Array.isArray(body.offers)) return null
  for (const raw of body.offers) {
    if (!isRecord(raw) || raw.id !== expectedOfferId) continue
    if (typeof raw.stock !== 'number') return null
    return { id: raw.id, stock: raw.stock }
  }
  return null
}
interface CheckoutPreviewShape {
  productId: number
  offerId: number
  purchasable: boolean
}

/** checkout preview 响应 unknown JSON → 形状；类型守卫证明 productId/offerId 精确匹配且可售。 */
function parseCheckoutPreview(body: unknown, expectedProductId: number, expectedOfferId: number): CheckoutPreviewShape {
  if (!isRecord(body)) throw new Error('checkout preview 响应不是 JSON 对象')
  if (!isPositiveInteger(body.productId)) throw new Error('checkout preview 响应缺少正整数 productId')
  if (!isPositiveInteger(body.offerId)) throw new Error('checkout preview 响应缺少正整数 offerId')
  if (typeof body.purchasable !== 'boolean') throw new Error('checkout preview 响应缺少 purchasable 布尔值')
  if (body.productId !== expectedProductId) {
    throw new Error(`checkout preview productId 不匹配，期望 ${expectedProductId}，实际: ${String(body.productId)}`)
  }
  if (body.offerId !== expectedOfferId) {
    throw new Error(`checkout preview offerId 不匹配，期望 ${expectedOfferId}，实际: ${String(body.offerId)}`)
  }
  if (body.purchasable !== true) {
    throw new Error('checkout preview purchasable 非 true')
  }
  return { productId: body.productId, offerId: body.offerId, purchasable: body.purchasable }
}

test.describe.serial('PAR-CMI-001 catalog product lifecycle prelude', () => {
  test('merchant creates a draft with limited capacity via the wizard', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    await page.goto('/merchant/products/new')
    await expect(page.getByTestId('product-create-wizard')).toBeVisible({ timeout: 10_000 })

    // 步骤 0：选择「人工服务」模板（deliveryMode=manual_service，可配限量名额）。
    await page.getByTestId('template-manual_service').click()
    await expect(page.getByTestId('wizard-next')).toBeEnabled()
    await page.getByTestId('wizard-next').click()

    // 步骤 1：展示信息 —— 唯一名称 + 显式分类（分类仅作展示，D-CAT-05）。
    await page.getByTestId('wizard-name').fill(PRODUCT_NAME)

    // 封面：真实 ProductImageUploader 直接外链同源图（零写 API），创建时即有规范封面。
    await page.getByTestId('product-image-url-input').fill(COVER_PATH)
    await page.getByTestId('product-image-url-hotlink').click()
    const coverImg = page.getByTestId('product-images-list').locator('img')
    await expect(coverImg).toHaveCount(1, { timeout: 10_000 })
    await expect(coverImg.first()).toHaveAttribute('src', new RegExp(`${COVER_PATH}$`))
    const categorySelect = page.getByTestId('product-category-select')
    await expect(categorySelect.locator('option:not([value=""])')).not.toHaveCount(0, { timeout: 10_000 })
    await categorySelect.selectOption({ label: '共享账号' })
    await page.getByTestId('wizard-next').click()

    // 步骤 2：定价 —— 主规格名保持默认，售价为正整数。
    await page.getByTestId('wizard-price').fill('2')
    await page.getByTestId('wizard-next').click()

    // 步骤 3：交付方式 —— 模板预选人工服务履约；名额改为限量（有限 capacity）。
    await expect(page.getByRole('radio', { name: '人工服务履约' })).toBeChecked()
    await page.getByTestId('stock-mode-select').selectOption('limited')
    await page.getByTestId('wizard-next').click()

    // 步骤 4：点击真实创建动作前监听 POST /api/merchant/products。
    const createResponse = page.waitForResponse((response) =>
      response.url().includes('/api/merchant/products') && response.request().method() === 'POST'
    )
    await page.getByTestId('wizard-save-draft').click()
    const createResult = await createResponse
    expect(createResult.status()).toBe(201)

    // 从 unknown JSON 用类型守卫安全取得正整数 productId，并断言处于 draft。
    const createdBody: unknown = await createResult.json()
    const created = parseCreatedProduct(createdBody)
    expect(created.status).toBe('draft')
    productId = created.id

    // 类型守卫断言 create 响应携带规范封面：imageUrl === COVER_PATH 且 images 长度 1。
    expect(readCoverFields(createdBody)).toEqual({ imageUrl: COVER_PATH, images: [COVER_PATH] })

    // create 响应未内嵌默认 Offer → 从创建后的真实 UI（可售量步）读取默认 Offer id。
    const offerIdFromCreate = extractOfferIdFromCreateResponse(createdBody)
    if (offerIdFromCreate !== null) {
      offerId = offerIdFromCreate
    } else {
      await expect(page.getByTestId('product-availability-step')).toBeVisible({ timeout: 10_000 })
      const rawOfferId = await page.getByTestId('availability-offer-select').inputValue()
      offerId = parsePositiveInteger(rawOfferId, '默认 Offer id')
    }

    expect(offerId).toBeGreaterThan(0)
  })

  test('draft is rejected by public detail and checkout preview', async ({ request }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 公开商品详情（无需登录）：draft → 400 BAD_REQUEST。
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    await expectPublicUnavailable(detail)

    // checkout preview（需登录用户）：显式携带正确 offerId，draft → 400 BAD_REQUEST。
    const userSession = await loginAsApi(request, SEED_ACCOUNTS.user)
    const preview = await request.get(
      `${API_BASE}/api/checkout/preview?productId=${productId}&offerId=${offerId}`,
      { headers: { Authorization: `Bearer ${userSession.accessToken}` } },
    )
    await expectPublicUnavailable(preview)
  })

  test('publish is refused as not-ready, then capacity is topped up via the offer UI', async ({ page }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 1. 经 UI 登录后进入 /merchant 商品管理，按已保存 productId 精准定位行/上架按钮。
    // Playwright 每个 test 的 BrowserContext 相互隔离，必须先经 UI 登录商家。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()
    const toggleButton = page.getByTestId(`merchant-product-toggle-status-${productId}`)
    const row = page.locator(`tr:has([data-testid="merchant-product-toggle-status-${productId}"])`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(toggleButton).toHaveText('上架')

    // 2. 点击真实「上架」，同时监听真实 publish 响应。
    const publishWaiter = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/merchant/products/${productId}/publish`)
        && response.request().method() === 'POST'
    )
    await toggleButton.click()
    const publishResponse = await publishWaiter

    // 3. 422 + 顶层 error.code === PRODUCT_NOT_READY；details 含当前 offerId 的 OFFER_NOT_SELLABLE。
    expect(publishResponse.status()).toBe(422)
    const publishBody: unknown = await publishResponse.json()
    expect(readErrorCode(publishBody)).toBe('PRODUCT_NOT_READY')
    expect(hasReadinessDetail(publishBody, offerId, 'OFFER_NOT_SELLABLE')).toBe(true)

    // 页面显示失败提示（role=alert 为机器可断言的失败反馈），按钮/行保持未上架。
    await expect(
      page.getByRole('alert').filter({ hasText: '商品尚未满足发布条件' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(toggleButton).toHaveText('上架')
    await expect(toggleButton).toBeEnabled()
    // 状态标签仍为「未上架」（StatusPill 对非 active 的文案），证明未伪造上架成功。
    await expect(row.getByText('未上架')).toBeVisible()

    // 4. 真实 availability UI：打开 modal，显式选择 offerId，补正数名额。
    const capacityReason = `E2E补名额-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await row.getByText('管理可售资源').click()
    const modal = page.getByTestId('merchant-availability-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('product-availability-step')).toBeVisible()

    await page.getByTestId('availability-offer-select').selectOption(String(offerId))
    const currentText = (await page.getByTestId('availability-current-stock').textContent()) ?? ''
    const currentStock = parseNonNegativeInteger(currentText, '当前库存')

    await page.getByTestId('availability-capacity-delta').fill('5')
    await page.getByTestId('availability-capacity-reason').fill(capacityReason)

    // 监听真实 offer-scoped capacity/adjust 请求，点击提交。
    const adjustWaiter = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/merchant/products/${productId}/offers/${offerId}/capacity/adjust`)
        && response.request().method() === 'POST'
    )
    await page.getByTestId('availability-capacity-submit').click()
    const adjustResponse = await adjustWaiter

    // 请求 payload 的 delta/reason 精确匹配。
    const rawPayload = adjustResponse.request().postData() ?? ''
    const payload: unknown = rawPayload ? JSON.parse(rawPayload) : null
    expect(readCapacityRequest(payload)).toEqual({ delta: 5, reason: capacityReason })

    // 成功响应：200，且返回的新 stock = 调整前 + 5。
    expect(adjustResponse.status()).toBe(200)
    expect(adjustResponse.ok()).toBe(true)
    const adjustResult: unknown = await adjustResponse.json()
    expect(readStock(adjustResult)).toBe(currentStock + 5)

    // UI 成功反馈（role=status）且 modal 关闭；行内名额随服务端刷新。
    await expect(
      page.getByRole('status').filter({ hasText: '规格名额调整成功' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(modal).toBeHidden({ timeout: 10_000 })
    await expect(
      page.getByTestId(`merchant-product-availability-${productId}`)
    ).toContainText(`服务名额 ${currentStock + 5}`, { timeout: 10_000 })
  })

  test('merchant publishes the product, then the public detail serves the topped-up offer', async ({ page, request }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 1. 经 UI 登录商家，进入 /merchant 商品管理，按已保存 productId 精准定位行/上架按钮。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()
    const toggleButton = page.getByTestId(`merchant-product-toggle-status-${productId}`)
    const row = page.locator(`tr:has([data-testid="merchant-product-toggle-status-${productId}"])`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(toggleButton).toHaveText('上架')

    // 2. 点击真实「上架」，同时监听真实 publish 响应（POST，精确 URL 段）。
    const publishWaiter = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/merchant/products/${productId}/publish`
        && response.request().method() === 'POST'
    )
    await toggleButton.click()
    const publishResponse = await publishWaiter

    // 3. publish 成功：200，unknown JSON 类型守卫断言 id === productId 且 status === active。
    expect(publishResponse.status()).toBe(200)
    const publishBody: unknown = await publishResponse.json()
    expect(parsePublishSuccess(publishBody, productId)).toEqual({ id: productId, status: 'active' })

    // 4. UI 反馈：role=status「商品已上架」；精准行内状态标签变「上架中」、按钮变「下架」。
    await expect(
      page.getByRole('status').filter({ hasText: '商品已上架' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(row.getByText('上架中')).toBeVisible({ timeout: 10_000 })
    await expect(toggleButton).toHaveText('下架')
    await expect(toggleButton).toBeEnabled()

    // 5. 只读 GET 公开产品详情（无需登录），200；offers 含 offerId 且 stock === 5（此前补名额）。
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    expect(detail.status()).toBe(200)
    const detailBody: unknown = await detail.json()
    expect(findOfferInProductDetail(detailBody, productId, offerId)).toEqual({ id: offerId, stock: 5 })
  })
  test('buyer searches the store, opens the single-SKU product and loads a purchasable checkout preview', async ({ page }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 独立买家会话：经登录页登录后停在商城首页（/）。
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/')

    // 桌面视口常驻的真实搜索输入（placeholder 契约），填商品名触发搜索。
    const search = page.getByPlaceholder('搜账号、卡密、教程...')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill(PRODUCT_NAME)

    // StorePage 搜索有 300ms debounce + 虚拟列表：web-first 等待目标卡片（不 fixed sleep）。
    const card = page.getByTestId(`store-product-card-${productId}`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText(PRODUCT_NAME)
    await card.click()

    // 详情页：URL pathname 精确，标题/heading 含商品名。
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/product/${productId}`)
    await expect(page.locator('h1').filter({ hasText: PRODUCT_NAME }).first()).toBeVisible({ timeout: 10_000 })

    // 单 SKU 商品：sku-selector 完全不渲染。
    await expect(page.getByTestId('sku-selector')).toHaveCount(0)

    // 点击「立即兑换」前注册精确的 preview 响应监听（pathname 精确匹配 + GET）。
    const previewWaiter = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/checkout/preview'
      && response.request().method() === 'GET'
    )
    await page.getByRole('button', { name: '立即兑换' }).click()
    const previewResponse = await previewWaiter

    // 请求 query：productId 精确；单 SKU UI 明确省略 offerId（透明兼容契约）。
    expect(previewResponse.status()).toBe(200)
    const previewRequestUrl = new URL(previewResponse.request().url())
    expect(previewRequestUrl.searchParams.get('productId')).toBe(String(productId))
    expect(previewRequestUrl.searchParams.has('offerId')).toBe(false)

    // 响应 unknown JSON：类型守卫证明 productId/offerId 与共享变量一致且 purchasable === true。
    const previewBody: unknown = await previewResponse.json()
    expect(parseCheckoutPreview(previewBody, productId, offerId)).toEqual({
      productId,
      offerId,
      purchasable: true,
    })

    // purchase-modal 可见且无「获取结算信息失败」；不点确认支付、不创建订单。
    const modal = page.getByTestId('purchase-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('preview-price')).toBeVisible({ timeout: 10_000 })
    await expect(modal).not.toContainText('获取结算信息失败')
  })

  test('merchant unpublishes the product from the dashboard UI', async ({ page }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 独立商家会话：经登录页登录后进入 /merchant 商品管理。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()

    // 按已保存 productId 精准定位行/下架按钮；初始：行「上架中」、按钮「下架」。
    const toggleButton = page.getByTestId(`merchant-product-toggle-status-${productId}`)
    const row = page.locator(`tr:has([data-testid="merchant-product-toggle-status-${productId}"])`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText('上架中')).toBeVisible({ timeout: 10_000 })
    await expect(toggleButton).toHaveText('下架')
    await expect(toggleButton).toBeEnabled()

    // 点击真实「下架」，同时监听真实 unpublish 响应：pathname 精确匹配 + POST。
    const unpublishWaiter = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/merchant/products/${productId}/unpublish`
        && response.request().method() === 'POST'
    )
    await toggleButton.click()
    const unpublishResponse = await unpublishWaiter

    // 200 + unknown JSON 类型守卫严格证明 id === productId 且 status === inactive。
    expect(unpublishResponse.status()).toBe(200)
    const unpublishBody: unknown = await unpublishResponse.json()
    expect(parseUnpublishSuccess(unpublishBody, productId)).toEqual({ id: productId, status: 'inactive' })

    // 成功反馈：role=status toast 含「商品已下架」。
    await expect(
      page.getByRole('status').filter({ hasText: '商品已下架' })
    ).toBeVisible({ timeout: 5_000 })

    // Dashboard 经 loadData 自动刷新（无 page.reload）：同一精准行「未上架」、按钮「上架」且 enabled。
    await expect(row.getByText('未上架')).toBeVisible({ timeout: 10_000 })
    await expect(toggleButton).toHaveText('上架')
    await expect(toggleButton).toBeEnabled()
  })
  test('after unpublish, public detail, store search and checkout preview reject the product', async ({ page, request }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 1. 公开商品详情（无需登录）：下架（inactive）→ 400 BAD_REQUEST。
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    await expectPublicUnavailable(detail)

    // 2. checkout preview（独立 API 买家会话）：显式携带正确 offerId，下架 → 400 BAD_REQUEST。
    const userSession = await loginAsApi(request, SEED_ACCOUNTS.user)
    const preview = await request.get(
      `${API_BASE}/api/checkout/preview?productId=${productId}&offerId=${offerId}`,
      { headers: { Authorization: `Bearer ${userSession.accessToken}` } },
    )
    await expectPublicUnavailable(preview)

    // 3. 商城 UI（独立买家会话）：真实桌面搜索框填商品名，下架后无结果 → 空态。
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/')
    const search = page.getByPlaceholder('搜账号、卡密、教程...')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill(PRODUCT_NAME)
    // StorePage 搜索 300ms debounce + 虚拟列表：web-first 等待空态文案（不 fixed sleep）。
    await expect(page.getByText('未找到相关好物')).toBeVisible({ timeout: 15_000 })
    // 空态下明确断言该商品卡片计数为 0（绝不只依赖 API 断言）。
    await expect(page.getByTestId(`store-product-card-${productId}`)).toHaveCount(0)
  })

  test('after unpublish, offer capacity is preserved and the merchant republishes from the UI', async ({ page }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 独立商家会话：经登录页登录后进入 /merchant 商品管理。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()

    // 按已保存 productId 精准定位行；初始：行「未上架」、按钮「上架」且 enabled。
    const toggleButton = page.getByTestId(`merchant-product-toggle-status-${productId}`)
    const row = page.locator(`tr:has([data-testid="merchant-product-toggle-status-${productId}"])`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText('未上架')).toBeVisible({ timeout: 10_000 })
    await expect(toggleButton).toHaveText('上架')
    await expect(toggleButton).toBeEnabled()

    // 打开真实 availability modal，显式选中 offerId，严格解析 current stock 并断言为 5：
    // 证明上次 unpublish 只翻状态、未清空 offer capacity。
    await row.getByText('管理可售资源').click()
    const modal = page.getByTestId('merchant-availability-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('product-availability-step')).toBeVisible()
    await page.getByTestId('availability-offer-select').selectOption(String(offerId))
    const currentText = (await page.getByTestId('availability-current-stock').textContent()) ?? ''
    expect(parseNonNegativeInteger(currentText, '当前库存')).toBe(5)

    // 通过 modal 内真实关闭按钮关闭（radix DialogContent 默认 X 按钮，aria-label=关闭）。
    await modal.getByRole('button', { name: '关闭' }).click()
    await expect(modal).toBeHidden({ timeout: 10_000 })

    // 点击真实「上架」，同时监听精确 publish 响应（pathname 精确匹配 + POST）。
    const publishWaiter = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/merchant/products/${productId}/publish`
        && response.request().method() === 'POST'
    )
    await toggleButton.click()
    const publishResponse = await publishWaiter

    // 200 + unknown JSON 类型守卫严格证明 id === productId 且 status === active。
    expect(publishResponse.status()).toBe(200)
    const publishBody: unknown = await publishResponse.json()
    expect(parsePublishSuccess(publishBody, productId)).toEqual({ id: productId, status: 'active' })

    // 成功反馈：role=status toast「商品已上架」；精准行「上架中」、按钮「下架」且 enabled。
    await expect(
      page.getByRole('status').filter({ hasText: '商品已上架' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(row.getByText('上架中')).toBeVisible({ timeout: 10_000 })
    await expect(toggleButton).toHaveText('下架')
    await expect(toggleButton).toBeEnabled()
  })

  test('after republish, public detail, store search and checkout preview recover', async ({ page, request }) => {
    expect(productId).toBeGreaterThan(0)
    expect(offerId).toBeGreaterThan(0)

    // 1. 公开商品详情（无需登录）：republish 后恢复 → 200；offers 含 offerId 且 stock === 5。
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    expect(detail.status()).toBe(200)
    const detailBody: unknown = await detail.json()
    expect(findOfferInProductDetail(detailBody, productId, offerId)).toEqual({ id: offerId, stock: 5 })

    // 独立买家会话：经登录页登录后停在商城首页（/）。
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/')

    // 桌面视口常驻的真实搜索输入（placeholder 契约），填商品名触发搜索。
    const search = page.getByPlaceholder('搜账号、卡密、教程...')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill(PRODUCT_NAME)

    // StorePage 搜索有 300ms debounce + 虚拟列表：web-first 等待目标卡片（不 fixed sleep）。
    const card = page.getByTestId(`store-product-card-${productId}`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText(PRODUCT_NAME)
    await card.click()

    // 详情页：URL pathname 精确，标题/heading 含商品名。
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/product/${productId}`)
    await expect(page.locator('h1').filter({ hasText: PRODUCT_NAME }).first()).toBeVisible({ timeout: 10_000 })

    // 单 SKU 商品：sku-selector 完全不渲染。
    await expect(page.getByTestId('sku-selector')).toHaveCount(0)

    // 点击「立即兑换」前注册精确的 preview 响应监听（pathname 精确匹配 + GET）。
    const previewWaiter = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/checkout/preview'
      && response.request().method() === 'GET'
    )
    await page.getByRole('button', { name: '立即兑换' }).click()
    const previewResponse = await previewWaiter

    // 请求 query：productId 精确；单 SKU UI 明确省略 offerId（透明兼容契约）。
    expect(previewResponse.status()).toBe(200)
    const previewRequestUrl = new URL(previewResponse.request().url())
    expect(previewRequestUrl.searchParams.get('productId')).toBe(String(productId))
    expect(previewRequestUrl.searchParams.has('offerId')).toBe(false)

    // 响应 unknown JSON：类型守卫证明 productId/offerId 与共享变量一致且 purchasable === true。
    const previewBody: unknown = await previewResponse.json()
    expect(parseCheckoutPreview(previewBody, productId, offerId)).toEqual({
      productId,
      offerId,
      purchasable: true,
    })

    // purchase-modal 可见且无「获取结算信息失败」；不点确认支付、不创建订单。
    const modal = page.getByTestId('purchase-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('preview-price')).toBeVisible({ timeout: 10_000 })
    await expect(modal).not.toContainText('获取结算信息失败')
  })

})
