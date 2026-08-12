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
 * 留待后续：admin review（D-CAT-11）。
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

/** create 响应解析出的申请 id（正整数）。 */
let applicationId = 0

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

/** 从 create 响应 unknown JSON 安全解析申请：id 必须正整数，label/code/status 精确匹配。 */
function parseApplication(body: unknown): { id: number; label: string; code: string; status: string } {
  if (!isRecord(body)) throw new Error('创建分类申请响应不是 JSON 对象')
  if (!isPositiveInteger(body.id)) throw new Error('创建分类申请响应缺少正整数 id')
  if (typeof body.proposedLabel !== 'string' || body.proposedLabel !== LABEL) {
    throw new Error('创建分类申请响应 proposedLabel 与提交值不匹配')
  }
  if (typeof body.proposedCode !== 'string' || body.proposedCode !== CODE) {
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
    const created = parseApplication(createdBody)
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
})
