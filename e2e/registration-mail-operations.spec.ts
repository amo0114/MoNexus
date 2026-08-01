import { expect, test, type Page, type Route } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

/**
 * SPEC-OPS-REGMAIL-001 阶段 B：管理后台注册开关 + 邮件投递运营面。
 *
 * 策略（计划 C16）：用真实 seed 管理员（密码 + TOTP）登录，只对本特性的三个
 * 端点做**精确 pathname** mock（不能用宽松 glob，否则会拦到 Vite 的模块请求）。
 * 真正的持久化/API 拒绝语义由后端 Supertest 覆盖——在 E2E 里改全局配置会与
 * 并行跑的注册用例互相踩踏。
 */

const CONFIG_PATH = '/api/admin/config'
const CONFIG_KEY_PATH = '/api/admin/config/registrationEnabled'
const MAIL_STATUS_PATH = '/api/admin/mail/status'
const MAIL_TEST_PATH = '/api/admin/mail/test'

function pathIs(path: string) {
  return (url: URL) => url.pathname === path
}

function configEntry(key: string, value: number, group: string, description: string) {
  return {
    key,
    value,
    defaultValue: value,
    description,
    group,
    unit: null,
    hint: null,
    updatedAt: null,
    updatedBy: null,
  }
}

function configList(registrationEnabled: number) {
  return [
    configEntry('checkinReward', 10, '奖励发放', '每日签到奖励积分'),
    configEntry('defaultPageSize', 20, '分页限制', '列表默认分页大小'),
    configEntry('registrationEnabled', registrationEnabled, '账户与注册', '允许新用户注册'),
  ]
}

type ConfigMock = {
  /** 当前「服务端」值，只有 PUT 成功才会变化 */
  get value(): number
  putCount(): number
  failNextPut(fail: boolean): void
  setPutDelayMs(ms: number): void
}

async function mockAdminConfig(page: Page, initial: number): Promise<ConfigMock> {
  let value = initial
  let putCount = 0
  let failPut = false
  let putDelayMs = 0

  await page.route(pathIs(CONFIG_PATH), async (route: Route) => {
    await route.fulfill({ json: configList(value) })
  })

  await page.route(pathIs(CONFIG_KEY_PATH), async (route: Route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    putCount += 1
    if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs))
    if (failPut) {
      await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: '写入配置失败' } } })
      return
    }
    const body = route.request().postDataJSON() as { value: number }
    value = body.value
    await route.fulfill({ json: configEntry('registrationEnabled', value, '账户与注册', '允许新用户注册') })
  })

  return {
    get value() {
      return value
    },
    putCount: () => putCount,
    failNextPut: (fail: boolean) => {
      failPut = fail
    },
    setPutDelayMs: (ms: number) => {
      putDelayMs = ms
    },
  }
}

type MailStatusBody = Record<string, unknown>

async function mockMailStatus(page: Page, body: MailStatusBody) {
  await page.route(pathIs(MAIL_STATUS_PATH), async (route: Route) => {
    await route.fulfill({ json: body })
  })
}

async function openConfigTab(page: Page) {
  await page.goto('/admin')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByRole('button', { name: '系统配置' }).click()
}

const READY_STATUS: MailStatusBody = {
  mode: 'smtp',
  deliveryReady: true,
  from: 'noreply@example.com',
  authConfigured: true,
  configuredVia: 'environment',
}

test.describe('注册开关面板', () => {
  test('P.13 开关忠实反映服务端值，关闭需确认，失败回读不留乐观残留', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    const config = await mockAdminConfig(page, 1)
    await mockMailStatus(page, READY_STATUS)
    await openConfigTab(page)

    const toggle = page.getByTestId('registration-toggle')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    // 状态不能只靠颜色：文字必须同时存在
    await expect(page.getByTestId('registration-toggle-state')).toHaveText('已开启')

    // 关闭前必须弹确认，且文案与规格 §5.2 逐字一致
    await toggle.click()
    await expect(page.getByText('关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？')).toBeVisible()
    await page.getByRole('button', { name: '确认关闭' }).click()

    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('registration-toggle-state')).toHaveText('已关闭')
    expect(config.value).toBe(0)

    // 保存失败：UI 必须回到服务端真实值（仍为关闭），不得停在乐观的「已开启」
    config.failNextPut(true)
    await toggle.click() // 开启方向不需要确认（C13）
    await expect(page.getByText('写入配置失败')).toBeVisible({ timeout: 10_000 })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('registration-toggle-state')).toHaveText('已关闭')
    expect(config.value).toBe(0)
  })

  test('P.13 单飞：延迟响应下连点只发一次 PUT', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    const config = await mockAdminConfig(page, 0)
    await mockMailStatus(page, READY_STATUS)
    config.setPutDelayMs(1200)
    await openConfigTab(page)

    const toggle = page.getByTestId('registration-toggle')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await toggle.click({ force: true })
    await toggle.click({ force: true })

    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
    expect(config.putCount()).toBe(1)
  })

  test('P.13 键盘 Space / Enter 可操作开关', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    const config = await mockAdminConfig(page, 0)
    await mockMailStatus(page, READY_STATUS)
    await openConfigTab(page)

    const toggle = page.getByTestId('registration-toggle')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
    expect(config.value).toBe(1)

    // Enter 走关闭方向，应弹出确认框
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('关闭后新访客无法创建账号，现有用户仍可登录。确认关闭？')).toBeVisible()
  })

  test('P.14 布尔 key 不渗入数值配置编辑器', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await mockAdminConfig(page, 1)
    await mockMailStatus(page, READY_STATUS)
    await openConfigTab(page)

    await expect(page.locator('[data-testid="admin-config-group"][data-group="奖励发放"]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('admin-config-input-registrationEnabled')).toHaveCount(0)
    await expect(page.getByTestId('admin-config-save-registrationEnabled')).toHaveCount(0)
    // 该分组下只有布尔 key，排除后不应产生空的数字分组
    await expect(page.locator('[data-testid="admin-config-group"][data-group="账户与注册"]')).toHaveCount(0)
  })
})

test.describe('邮件投递面板', () => {
  test('P.15 只渲染白名单字段，注入的秘密金丝雀不出现在页面或 console', async ({ page }) => {
    const canaries = [
      'smtp-host-canary.internal',
      'smtp-user-canary@example.com',
      'smtp-pass-canary-9f3a',
      'provider-token-canary-7b21',
    ]
    await loginAs(page, SEED_ACCOUNTS.admin)
    await mockAdminConfig(page, 1)
    await mockMailStatus(page, {
      ...READY_STATUS,
      host: canaries[0],
      user: canaries[1],
      pass: canaries[2],
      providerToken: canaries[3],
      auth: { user: canaries[1], pass: canaries[2] },
    })

    const consoleText: string[] = []
    page.on('console', (msg) => consoleText.push(msg.text()))

    await openConfigTab(page)
    await expect(page.getByTestId('admin-mail-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('admin-mail-from')).toHaveText('noreply@example.com')
    await expect(page.getByTestId('admin-mail-auth')).toHaveText('已配置')
    await expect(page.getByTestId('admin-mail-configured-via')).toHaveText('部署环境变量')
    await expect(page.getByTestId('admin-mail-mode')).toHaveText('真实 SMTP 已配置')

    const html = await page.content()
    for (const canary of canaries) {
      expect(html, `渲染文档不应包含 ${canary}`).not.toContain(canary)
      expect(consoleText.join('\n'), `console 不应包含 ${canary}`).not.toContain(canary)
    }
    // 运维提示必须给出受控变更路径
    await expect(
      page.getByText('SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM 需在部署环境中配置，修改后重启后端。')
    ).toBeVisible()
  })

  test('P.16 表单启用只取决于 deliveryReady，与 authConfigured 无关', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await mockAdminConfig(page, 1)
    // 免认证 relay：authConfigured=false 但可投递；且未显式配 SMTP_FROM
    await mockMailStatus(page, {
      mode: 'smtp',
      deliveryReady: true,
      from: null,
      authConfigured: false,
      configuredVia: 'environment',
    })
    await openConfigTab(page)

    await expect(page.getByTestId('admin-mail-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('admin-mail-auth')).toHaveText('未配置')
    await expect(page.getByTestId('admin-mail-from')).toHaveText('发件地址未公开展示；配置 SMTP_FROM 可显示')
    await expect(page.getByTestId('admin-mail-test-send')).toBeEnabled()
    await expect(page.getByTestId('admin-mail-test-email')).toBeEnabled()
    await expect(page.getByTestId('admin-mail-disabled-reason')).toHaveCount(0)
  })

  test('P.16 console 降级：展示降级说明并禁用测试发送', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await mockAdminConfig(page, 1)
    await mockMailStatus(page, {
      mode: 'console',
      deliveryReady: false,
      from: null,
      authConfigured: false,
      configuredVia: 'environment',
    })
    await openConfigTab(page)

    await expect(page.getByTestId('admin-mail-mode')).toHaveText('未配置真实 SMTP，当前仅记录到服务端日志', {
      timeout: 10_000,
    })
    await expect(page.getByTestId('admin-mail-test-send')).toBeDisabled()
    await expect(page.getByTestId('admin-mail-test-email')).toBeDisabled()
    await expect(page.getByTestId('admin-mail-disabled-reason')).toBeVisible()
  })

  test('P.17 测试发送单飞，且收件地址不落任何持久位置', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await mockAdminConfig(page, 1)
    await mockMailStatus(page, READY_STATUS)

    const recipient = 'ops-recipient@example.com'
    const bodies: unknown[] = []
    await page.route(pathIs(MAIL_TEST_PATH), async (route: Route) => {
      bodies.push(route.request().postDataJSON())
      await new Promise((r) => setTimeout(r, 1200))
      await route.fulfill({ json: { message: '测试邮件已提交发送' } })
    })

    await openConfigTab(page)
    const input = page.getByTestId('admin-mail-test-email')
    const send = page.getByTestId('admin-mail-test-send')
    await expect(send).toBeEnabled({ timeout: 10_000 })

    await input.fill(recipient)
    await send.click()
    await expect(send).toBeDisabled()
    await send.click({ force: true })
    await send.click({ force: true })

    await expect(page.getByText('测试邮件已提交发送')).toBeVisible({ timeout: 15_000 })
    expect(bodies).toHaveLength(1)
    // body 只允许携带 email 一个字段
    expect(bodies[0]).toEqual({ email: recipient })

    // 成功后输入框清空，地址不得残留在 URL / storage 中
    await expect(input).toHaveValue('')
    expect(page.url()).not.toContain('ops-recipient')
    const storage = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }))
    expect(storage).not.toContain(recipient)
  })
})

test.describe('响应式契约', () => {
  const LONG_FROM = 'a-very-long-operations-sender-address-for-wrapping@subdomain.example-company-mail.test'

  for (const viewport of [
    { name: '375px 移动端', size: { width: 375, height: 780 } },
    { name: '桌面端', size: { width: 1280, height: 900 } },
  ]) {
    test(`P.18 ${viewport.name} 无横向溢出且触控目标 ≥40px`, async ({ page }) => {
      await page.setViewportSize(viewport.size)
      await loginAs(page, SEED_ACCOUNTS.admin)
      await mockAdminConfig(page, 1)
      await mockMailStatus(page, { ...READY_STATUS, from: LONG_FROM })
      await openConfigTab(page)

      await expect(page.getByTestId('admin-mail-panel')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByTestId('registration-toggle')).toBeVisible()

      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow, '文档不应横向溢出').toBeLessThanOrEqual(1)

      // 长发件地址必须换行，而不是把卡片撑宽
      const fromBox = await page.getByTestId('admin-mail-from').boundingBox()
      expect(fromBox!.width).toBeLessThanOrEqual(viewport.size.width)

      // 开关按规格 §5.2 无条件 ≥40×40；btn-sm 的发送按钮沿用既有约定，
      // 只在触控/小视口（max-width:767px）扩到 40px 高。
      const toggleBox = await page.getByTestId('registration-toggle').boundingBox()
      expect(toggleBox!.height, '开关触控高度').toBeGreaterThanOrEqual(40)
      expect(toggleBox!.width, '开关触控宽度').toBeGreaterThanOrEqual(40)

      if (viewport.size.width < 768) {
        const sendBox = await page.getByTestId('admin-mail-test-send').boundingBox()
        expect(sendBox!.height, '发送按钮触控高度').toBeGreaterThanOrEqual(40)
      }
    })
  }
})
