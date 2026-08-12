import { expect, test } from '@playwright/test'
import { SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * PAR-CMI-002 — Catalog category governance（create + pending duplicate + withdraw）。
 *
 * 已覆盖（REQ-CAT-F-008 / D-CAT-10 / AC-CAT-012）：
 * 1. 商家真实登录 → /merchant → 点击「分类申请」→ 面板 category-application-panel 出现；
 * 2. 打开申请表 → 填 unique LABEL / CODE、≥20 字描述、示例商品；
 * 3. 点击真实提交动作前监听「精确 pathname /api/merchant/category-applications 且 POST」；
 * 4. 断言响应 201（server applicationRoutes.test.ts 真实契约：POST create → 201），
 *    用类型守卫从 unknown JSON 安全取得正整数 applicationId，并断言
 *    proposedLabel===LABEL、proposedCode===CODE、status==='pending'，保存 id；
 * 5. 请求 JSON 精确四 allowlist 字段（proposedLabel/proposedCode/description/
 *    exampleProducts），且明确无 merchantId/status（归属服务端从 auth 派生）；
 * 6. toast「分类申请已提交，等待平台审核」；列表行 application-row-<id>
 *    data-status=pending。
 *
 * duplicate（409 CATEGORY_APPLICATION_PENDING_DUPLICATE）：同一商家对同一
 * normalizedLabel 的 pending 申请重复提交 → 409 + 稳定错误码；UI 按码取词显示
 * 「你已有一个相同名称的分类申请在审核中」，表单保持打开、submit 恢复可重试，
 * 且全程不出现成功 toast。
 *
 * withdraw（D-CAT-10 / AC-CAT-012）：对同一 pending 申请点击 application-withdraw-<id>
 * → 确认 dialog → 在 dialog 范围内点「撤回」确认按钮 → 监听精确 POST
 * /api/merchant/category-applications/<id>/withdraw → 断言 200；严格类型守卫从
 * unknown JSON 证明 id===applicationId 且 status==='withdrawn'；toast「申请已撤回」；
 * 列表自行刷新（禁止 page.reload）后同一行 data-status=withdrawn、
 * application-withdraw-<id> 消失。
 *
 * 额外 pending 数据准备：为后续管理员审核准备一条全新 pending 申请——独立
 * loginAs → /merchant → 分类申请 → 真实表单，填唯一 ADMIN_REVIEW_LABEL /
 * 合法 lower-case ADMIN_REVIEW_CODE / ≥20 字 ADMIN_REVIEW_DESCRIPTION；点击前
 * 监听精确 POST /api/merchant/category-applications 断言 201；严格类型守卫从
 * unknown JSON 解析正整数 adminReviewApplicationId，label/code/status 精确匹配；
 * 请求体精确四 allowlist 且无 merchantId/status；toast 成功 + application-row-
 * <adminReviewApplicationId> data-status=pending；绝不 withdraw（供后续 admin 审核）。
 *
 * admin create_new 审核（D-CAT-11 / AC-CAT-013）：真实 admin MFA loginAs → /admin →
 * 「目录治理」→ admin-category-manager；默认 pending 筛选下按 application-row-
 * <adminReviewApplicationId> 精准定位，点击 application-approve-new-<id> 打开
 * create_new review dialog；核对 code/label/description 预填为 ADMIN_REVIEW_*，
 * 填 review-icon='folder-tree' + 常量 ADMIN_REVIEW_REASON；点击前监听精确 POST
 * /api/admin/category-applications/<id>/approve 断言 200；严格类型守卫从 unknown
 * JSON 证明 id 相同、status='approved'、resolution='create_new'、approvedCategoryId
 * 正整数、reviewReason 精确，且响应键命中冻结 DTO allowlist（拒绝任何额外键、
 * 显式点名内部/操作者字段，merchantId 为合法公开字段），保存 approvedCategoryId；
 * 请求体精确 {resolution, category, reviewReason} 键集合且无 reviewer/user/admin
 * ID；toast「已通过并新建分类」
 * + dialog 关闭；pending 列表刷新后 row 消失；切 admin-application-status-filter=
 * approved 回查同 row data-status=approved、resolution「新建分类」并含 #approvedCategoryId。
 * 硬约束：无 mock / 无 DB 直读直写 / 无 page.reload / 无 waitForTimeout /
 * 无 page.route / 无写 API 替代 UI 提交 / 无 any / 无 ts-ignore。
 */

/** 唯一申请名称（每次运行不同，避免 pending duplicate 撞车）。 */
const LABEL = `E2E分类申请-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 唯一建议编码（仅建议，平台可调整；满足 ^[A-Za-z0-9_-]+$）。 */
const CODE = `e2e_cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
/** duplicate 用例的合法建议编码（与 CODE 不同避免撞码；重复判定走 normalizedLabel，与编码无关）。 */
const CODE_DUPLICATE = `e2e_cat_dup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
/** 至少 20 字的描述（表单校验：description.trim().length >= 20）。 */
const DESCRIPTION = '这是一条用于端到端验证分类申请流程的自动化测试描述，长度远超二十个字符以保证通过表单校验。'
/** 示例商品（可选字段，本卡填满以覆盖四 allowlist 字段）。 */
const EXAMPLE_PRODUCTS = '云服务订阅、数据看板、团队协作工具'

/** 额外 pending 数据准备：唯一 label（与 LABEL 不同避免语义混淆），供后续管理员审核。 */
const ADMIN_REVIEW_LABEL = `E2E待审分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 合法 lower-case 分类编码（满足 CATEGORY_CODE_PATTERN：小写字母开头、仅小写/数字/-/_），
 *  供后续 admin create_new 审核直接复用。 */
const ADMIN_REVIEW_CODE = `e2e-admin-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** ≥20 字的描述（表单校验：description.trim().length >= 20）。 */
const ADMIN_REVIEW_DESCRIPTION = '这是为平台管理员审核准备的分类申请描述，用于后续 admin review 端到端验证，长度满足表单校验要求。'
/** 管理员审核理由常量（1..500 字、无控制字符；请求与响应 reviewReason 精确断言共用）。 */
const ADMIN_REVIEW_REASON = 'E2E 管理员审核：名称与编码均符合分类规范，通过并新建分类。'

/** create 响应解析出的申请 id（正整数）。 */
let applicationId = 0

/** 额外 pending 数据准备：为后续管理员审核创建的新申请 id（正整数）。 */
let adminReviewApplicationId = 0
/** admin create_new 审核响应解析出的新建分类 id（正整数）。 */
let approvedCategoryId = 0

/** unknown JSON → 记录（类型守卫）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 正整数类型守卫。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 错误响应 unknown JSON → error.code（严格类型守卫，禁止 any）。服务端
 * errorHandler 稳定输出 { error: { code, message } }（server/src/middlewares/
 * errorHandler.ts）；任何形状不符直接抛错，绝不静默返回伪造值。
 */
function readErrorCode(body: unknown): string {
  if (!isRecord(body)) throw new Error('错误响应不是 JSON 对象')
  const error = body.error
  if (!isRecord(error)) throw new Error('错误响应缺少 error 对象')
  if (typeof error.code !== 'string' || error.code.length === 0) {
    throw new Error('错误响应缺少非空 string code')
  }
  return error.code
}

/** 从 create 响应 unknown JSON 安全解析申请：id 必须正整数，label/code/status 与提交的 expected 精确匹配。 */
function parseApplication(
  body: unknown,
  expected: { label: string; code: string },
): { id: number; label: string; code: string; status: string } {
  if (!isRecord(body)) throw new Error('创建分类申请响应不是 JSON 对象')
  if (!isPositiveInteger(body.id)) throw new Error('创建分类申请响应缺少正整数 id')
  if (typeof body.proposedLabel !== 'string' || body.proposedLabel !== expected.label) {
    throw new Error('创建分类申请响应 proposedLabel 与提交值不匹配')
  }
  if (typeof body.proposedCode !== 'string' || body.proposedCode !== expected.code) {
    throw new Error('创建分类申请响应 proposedCode 与提交值不匹配')
  }
  if (body.status !== 'pending') {
    throw new Error(`创建分类申请响应 status 非 pending，实际: ${String(body.status)}`)
  }
  return { id: body.id, label: body.proposedLabel, code: body.proposedCode, status: body.status }
}

/**
 * 从 withdraw 响应 unknown JSON 严格解析撤回结果（类型守卫，禁止 any）：
 * id 必须等于 applicationId 且 status==='withdrawn'；任何形状不符直接抛错。
 */
function parseWithdrawnApplication(body: unknown, applicationId: number): { id: number; status: 'withdrawn' } {
  if (!isRecord(body)) throw new Error('撤回分类申请响应不是 JSON 对象')
  if (!isPositiveInteger(body.id) || body.id !== applicationId) {
    throw new Error(`撤回分类申请响应 id 非预期，期望 ${applicationId}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'withdrawn') {
    throw new Error(`撤回分类申请响应 status 非 withdrawn，实际 ${String(body.status)}`)
  }
  return { id: body.id, status: body.status }
}

/**
 * 请求 JSON unknown → create payload（类型守卫）。必须精确四 allowlist 字段
 * （proposedLabel/proposedCode/description/exampleProducts），且明确无
 * merchantId/status（服务端从 auth 派生归属，body 永远不允许）；形状不符返回 null。
 */
function readCreatePayload(
  body: unknown,
): { proposedLabel: string; proposedCode: string; description: string; exampleProducts: string } | null {
  if (!isRecord(body)) return null
  if (typeof body.proposedLabel !== 'string') return null
  if (typeof body.proposedCode !== 'string') return null
  if (typeof body.description !== 'string') return null
  if (typeof body.exampleProducts !== 'string') return null
  if (Object.keys(body).length !== 4) return null
  if ('merchantId' in body || 'status' in body) return null
  return {
    proposedLabel: body.proposedLabel,
    proposedCode: body.proposedCode,
    description: body.description,
    exampleProducts: body.exampleProducts,
  }
}

/**
 * CategoryApplication 响应 DTO 冻结允许键（server/src/modules/catalog/contracts.ts
 * CategoryApplicationDto）。服务端只允许返回这些公开字段；normalizedLabel、
 * reviewedByUserId 等服务端内部/操作者字段绝不允许外泄到响应。
 */
const CATEGORY_APPLICATION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'merchantId',
  'proposedLabel',
  'proposedCode',
  'description',
  'exampleProducts',
  'status',
  'resolution',
  'approvedCategoryId',
  'reviewedAt',
  'reviewReason',
  'createdAt',
  'updatedAt',
])

/**
 * 显式禁止的内部/操作者字段（即使误加进 allowlist 也必须点名拒绝）：normalizedLabel
 * 是服务端派生字段，reviewedByUserId/actorId/adminUserId/userId 是操作者/审计 ID。
 * 注意 merchantId 是冻结 DTO 合法公开字段，不在禁止之列。
 */
const CATEGORY_APPLICATION_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'normalizedLabel',
  'reviewedByUserId',
  'actorId',
  'adminUserId',
  'userId',
])

/**
 * 从 admin approve(create_new) 响应 unknown JSON 严格解析审核结果（类型守卫，禁止
 * any/as any）：id 必须等于提交的 applicationId、status==='approved'、
 * resolution==='create_new'、approvedCategoryId 必须正整数、reviewReason 精确匹配；
 * 响应键必须命中冻结 DTO allowlist（任何额外键拒绝，且显式点名内部/操作者 ID）；
 * 任何形状不符直接抛错。
 */
function parseApprovedApplication(
  body: unknown,
  expected: { id: number; reviewReason: string },
): {
  id: number
  status: 'approved'
  resolution: 'create_new'
  approvedCategoryId: number
  reviewReason: string
} {
  if (!isRecord(body)) throw new Error('审核分类申请响应不是 JSON 对象')

  // 显式点名内部/操作者字段（即使将来误入 allowlist 也单独拒绝，防回归）。
  const forbiddenKeys = [...CATEGORY_APPLICATION_FORBIDDEN_KEYS].filter((key) => key in body)
  if (forbiddenKeys.length > 0) {
    throw new Error(`审核分类申请响应泄露内部/操作者字段: ${forbiddenKeys.join(', ')}`)
  }

  // 冻结 DTO allowlist：任何额外键一律拒绝（merchantId 是合法公开字段，不在禁止之列）。
  const extraKeys = Object.keys(body).filter((key) => !CATEGORY_APPLICATION_ALLOWED_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`审核分类申请响应含未允许字段: ${extraKeys.join(', ')}`)
  }
  if (!isPositiveInteger(body.id) || body.id !== expected.id) {
    throw new Error(`审核分类申请响应 id 非预期，期望 ${expected.id}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'approved') {
    throw new Error(`审核分类申请响应 status 非 approved，实际 ${String(body.status)}`)
  }
  if (body.resolution !== 'create_new') {
    throw new Error(`审核分类申请响应 resolution 非 create_new，实际 ${String(body.resolution)}`)
  }
  if (!isPositiveInteger(body.approvedCategoryId)) {
    throw new Error('审核分类申请响应缺少正整数 approvedCategoryId')
  }
  if (body.reviewReason !== expected.reviewReason) {
    throw new Error('审核分类申请响应 reviewReason 与提交值不匹配')
  }
  return {
    id: body.id,
    status: 'approved',
    resolution: 'create_new',
    approvedCategoryId: body.approvedCategoryId,
    reviewReason: body.reviewReason,
  }
}

/**
 * 请求 JSON unknown → approve(create_new) payload（类型守卫）。必须精确顶层三键
 * { resolution, category, reviewReason } 且 category 精确四键 { code, label,
 * description, iconKey }；任何多余键（含 reviewer/user/admin ID，操作者由服务端
 * 从 auth 派生）或形状不符直接返回 null。
 */
function readApproveCreateNewPayload(
  body: unknown,
): {
  resolution: 'create_new'
  category: { code: string; label: string; description: string; iconKey: string }
  reviewReason: string
} | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 3) return null
  if (body.resolution !== 'create_new') return null
  if (typeof body.reviewReason !== 'string') return null
  if (!isRecord(body.category)) return null
  const category = body.category
  if (Object.keys(category).length !== 4) return null
  if (typeof category.code !== 'string') return null
  if (typeof category.label !== 'string') return null
  if (typeof category.description !== 'string') return null
  if (typeof category.iconKey !== 'string') return null
  return {
    resolution: 'create_new',
    category: {
      code: category.code,
      label: category.label,
      description: category.description,
      iconKey: category.iconKey,
    },
    reviewReason: body.reviewReason,
  }
}

test.describe.serial('PAR-CMI-002 catalog category governance merchant flow', () => {
  test('merchant submits a pending category application via the UI', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    // 进入商家后台并切到「分类申请」tab，等待面板渲染。
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开申请表并填写：unique LABEL、CODE、≥20 字描述、示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(LABEL)
    await page.getByTestId('application-form-code').fill(CODE)
    await page.getByTestId('application-form-description').fill(DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const createResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const createResult = await createResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(createResult.status()).toBe(201)

    // 从 unknown JSON 用类型守卫解析并保存正整数 applicationId。
    const createdBody: unknown = await createResult.json()
    const created = parseApplication(createdBody, { label: LABEL, code: CODE })
    applicationId = created.id
    expect(created.label).toBe(LABEL)
    expect(created.code).toBe(CODE)
    expect(created.status).toBe('pending')
    expect(applicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status。
    const requestBody: unknown = createResult.request().postDataJSON()
    expect(readCreatePayload(requestBody)).toEqual({
      proposedLabel: LABEL,
      proposedCode: CODE,
      description: DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${applicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${applicationId}`)).toHaveAttribute('data-status', 'pending')
  })

  test('duplicate pending application is rejected with 409 and the form stays retryable', async ({ page }) => {
    // 串行依赖：前一个 create 用例必须已保存正整数 applicationId。
    expect(applicationId).toBeGreaterThan(0)

    // 独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开创建表单：提交与 create 用例相同的 LABEL（pending 已存在 → 重复冲突），
    // 但使用另一个合法且唯一的 CODE_DUPLICATE；description/exampleProducts 保持合法。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(LABEL)
    await page.getByTestId('application-form-code').fill(CODE_DUPLICATE)
    await page.getByTestId('application-form-description').fill(DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const duplicateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const duplicateResult = await duplicateResponse

    // 真实契约（server applicationService.ts）：pending duplicate → 409 + 稳定错误码。
    expect(duplicateResult.status()).toBe(409)
    const duplicateBody: unknown = await duplicateResult.json()
    expect(readErrorCode(duplicateBody)).toBe('CATEGORY_APPLICATION_PENDING_DUPLICATE')

    // UI 稳定文案（getCatalogGovernanceErrorMessage 按码取词，非 prose 匹配）。
    await expect(page.getByTestId('application-form-error')).toHaveText('你已有一个相同名称的分类申请在审核中', { timeout: 10_000 })

    // 失败路径不关闭表单：dialog 保持打开，submit 恢复 enabled。
    await expect(page.getByTestId('application-form-label')).toBeVisible()
    await expect(page.getByTestId('application-form-submit')).toBeEnabled()

    // 修改表单后重试：重复判定走 normalizedLabel，仅改 code 不会消除冲突 → 仍 409。
    await page.getByTestId('application-form-code').fill(`${CODE_DUPLICATE}_retry`)
    const retryResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const retryResult = await retryResponse
    expect(retryResult.status()).toBe(409)
    expect(readErrorCode(await retryResult.json())).toBe('CATEGORY_APPLICATION_PENDING_DUPLICATE')
    await expect(page.getByTestId('application-form-error')).toHaveText('你已有一个相同名称的分类申请在审核中')

    // 全程绝不出现成功 toast（成功只会在 create 201 路径触发）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toHaveCount(0)
  })

  test('merchant withdraws the pending application via the confirm dialog (D-CAT-10)', async ({ page }) => {
    // 串行依赖：create 用例已保存正整数 applicationId，且当前仍为 pending。
    expect(applicationId).toBeGreaterThan(0)

    // 独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 精准定位本卡创建的 pending 行，断言当前 data-status=pending，并定位撤回按钮。
    const row = page.getByTestId(`application-row-${applicationId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'pending')
    const withdrawButton = page.getByTestId(`application-withdraw-${applicationId}`)
    await expect(withdrawButton).toBeVisible()

    // 点击撤回按钮 → 等待确认 dialog。
    await withdrawButton.click()
    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })

    // 必须在 dialog 范围内点击真正的「撤回」确认按钮，避免误点背景里的撤回按钮。
    // 核对实际组件文案（ConfirmDialog: title「撤回分类申请」/ description / 确认按钮）。
    await expect(confirmDialog).toContainText('撤回分类申请')
    await expect(confirmDialog).toContainText('确定撤回')

    // 点击确认前监听精确 pathname + POST withdraw。
    const withdrawResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/merchant/category-applications/${applicationId}/withdraw`
      && response.request().method() === 'POST'
    )
    await confirmDialog.getByRole('button', { name: '撤回', exact: true }).click()
    const withdrawResult = await withdrawResponse

    // 真实契约（server applicationRoutes.test.ts）：POST withdraw → 200。
    expect(withdrawResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id === applicationId 且 status==='withdrawn'。
    const withdrawBody: unknown = await withdrawResult.json()
    const withdrawn = parseWithdrawnApplication(withdrawBody, applicationId)
    expect(withdrawn.id).toBe(applicationId)
    expect(withdrawn.status).toBe('withdrawn')

    // toast「申请已撤回」。
    await expect(
      page.locator('[data-toast-card]', { hasText: '申请已撤回' }),
    ).toBeVisible({ timeout: 10_000 })

    // 列表自行刷新（禁止 page.reload）：同一行 data-status=withdrawn，
    // 且 application-withdraw-<id> 消失（非 pending 不再渲染撤回按钮）。
    await expect(row).toHaveAttribute('data-status', 'withdrawn', { timeout: 10_000 })
    await expect(page.getByTestId(`application-withdraw-${applicationId}`)).toHaveCount(0)
  })

  test('prepares an extra pending application for the later admin review (D-CAT-11 prep)', async ({ page }) => {
    // 额外 pending 数据准备：独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开真实创建表单，填唯一 ADMIN_REVIEW_LABEL / 合法 lower-case ADMIN_REVIEW_CODE /
    // ≥20 字 ADMIN_REVIEW_DESCRIPTION + 合法示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(ADMIN_REVIEW_LABEL)
    await page.getByTestId('application-form-code').fill(ADMIN_REVIEW_CODE)
    await page.getByTestId('application-form-description').fill(ADMIN_REVIEW_DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const adminReviewCreateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const adminReviewCreateResult = await adminReviewCreateResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(adminReviewCreateResult.status()).toBe(201)

    // 严格类型守卫：从 unknown JSON 断言正整数 id、精确 label/code、status=pending，
    // 保存 adminReviewApplicationId（禁止 any/as any）。
    const adminReviewBody: unknown = await adminReviewCreateResult.json()
    const adminReviewCreated = parseApplication(adminReviewBody, { label: ADMIN_REVIEW_LABEL, code: ADMIN_REVIEW_CODE })
    adminReviewApplicationId = adminReviewCreated.id
    expect(adminReviewCreated.label).toBe(ADMIN_REVIEW_LABEL)
    expect(adminReviewCreated.code).toBe(ADMIN_REVIEW_CODE)
    expect(adminReviewCreated.status).toBe('pending')
    expect(adminReviewApplicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status（复用既有 readCreatePayload，
    // 未弱化任何断言）。
    const adminReviewRequestBody: unknown = adminReviewCreateResult.request().postDataJSON()
    expect(readCreatePayload(adminReviewRequestBody)).toEqual({
      proposedLabel: ADMIN_REVIEW_LABEL,
      proposedCode: ADMIN_REVIEW_CODE,
      description: ADMIN_REVIEW_DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toHaveAttribute('data-status', 'pending')

    // 本卡仅为后续 admin create_new 审核准备 pending 数据：绝不 withdraw 该申请。
  })

  test('admin approves the prepared application via create_new and the row becomes approved (D-CAT-11)', async ({ page }) => {
    // 串行依赖：第 4 个 pending 数据准备用例必须已保存正整数 adminReviewApplicationId。
    expect(adminReviewApplicationId).toBeGreaterThan(0)

    // 真实 admin MFA 登录（loginAs admin 走 seed TOTP 验证）→ /admin → 「目录治理」。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '目录治理' }).click()
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })

    // 显式断言状态筛选当前 value = 'pending'（组件默认值，非 UI 猜测），
    // 再按 application-row-<id> 精准定位本卡准备的行，断言 pending 后点击
    // application-approve-new-<id> 打开 create_new 审核 dialog。
    await expect(page.getByTestId('admin-application-status-filter')).toHaveValue('pending')
    const row = page.getByTestId(`application-row-${adminReviewApplicationId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'pending')
    await page.getByTestId(`application-approve-new-${adminReviewApplicationId}`).click()

    // review dialog：核对 code/label/description 预填为 ADMIN_REVIEW_*（禁止手工输入
    // 替代预填），再填 review-icon='folder-tree' + 常量 ADMIN_REVIEW_REASON。
    const reviewDialog = page.getByRole('dialog')
    await expect(reviewDialog).toBeVisible({ timeout: 10_000 })
    await expect(reviewDialog.getByTestId('review-code')).toHaveValue(ADMIN_REVIEW_CODE)
    await expect(reviewDialog.getByTestId('review-label')).toHaveValue(ADMIN_REVIEW_LABEL)
    await expect(reviewDialog.getByTestId('review-description')).toHaveValue(ADMIN_REVIEW_DESCRIPTION)
    await reviewDialog.getByTestId('review-icon').fill('folder-tree')
    await reviewDialog.getByTestId('review-reason').fill(ADMIN_REVIEW_REASON)

    // 点击真实提交动作前监听精确 pathname + POST approve。
    const approveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/category-applications/${adminReviewApplicationId}/approve`
      && response.request().method() === 'POST'
    )
    await reviewDialog.getByTestId('review-submit').click()
    const approveResult = await approveResponse

    // 真实契约（server applicationRoutes.test.ts）：POST approve → 200。
    expect(approveResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id 相同、status=approved、resolution=create_new、
    // approvedCategoryId 正整数、reviewReason 精确，且响应键命中冻结 DTO allowlist
    // （拒绝任何额外键、显式点名内部/操作者字段）；保存 approvedCategoryId（禁止 any/as any）。
    const approveBody: unknown = await approveResult.json()
    const approved = parseApprovedApplication(approveBody, { id: adminReviewApplicationId, reviewReason: ADMIN_REVIEW_REASON })
    approvedCategoryId = approved.approvedCategoryId
    expect(approved.id).toBe(adminReviewApplicationId)
    expect(approved.status).toBe('approved')
    expect(approved.resolution).toBe('create_new')
    expect(approved.approvedCategoryId).toBeGreaterThan(0)
    expect(approved.reviewReason).toBe(ADMIN_REVIEW_REASON)

    // 请求 JSON：严格等于 { resolution:'create_new', category:{code,label,description,
    // iconKey}, reviewReason }，精确键集合且无 reviewer/user/admin ID。
    const approveRequestBody: unknown = approveResult.request().postDataJSON()
    expect(readApproveCreateNewPayload(approveRequestBody)).toEqual({
      resolution: 'create_new',
      category: {
        code: ADMIN_REVIEW_CODE,
        label: ADMIN_REVIEW_LABEL,
        description: ADMIN_REVIEW_DESCRIPTION,
        iconKey: 'folder-tree',
      },
      reviewReason: ADMIN_REVIEW_REASON,
    })

    // toast「已通过并新建分类」+ review dialog 关闭（Radix unmount 后 role=dialog 消失）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '已通过并新建分类' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 默认 pending 列表自行刷新（禁止 page.reload）：application-row-<id> 消失（已转 approved）。
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toHaveCount(0, { timeout: 10_000 })

    // 切 admin-application-status-filter=approved 回查同 row：data-status=approved，
    // resolution 显示「新建分类」且包含 #approvedCategoryId。
    await page.getByTestId('admin-application-status-filter').selectOption('approved')
    const approvedRow = page.getByTestId(`application-row-${adminReviewApplicationId}`)
    await expect(approvedRow).toBeVisible({ timeout: 10_000 })
    await expect(approvedRow).toHaveAttribute('data-status', 'approved')
    await expect(page.getByTestId(`application-resolution-${adminReviewApplicationId}`)).toContainText('新建分类')
    await expect(page.getByTestId(`application-resolution-${adminReviewApplicationId}`)).toContainText(`#${approvedCategoryId}`)
  })
})
