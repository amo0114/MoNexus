import { expect, test, type Request } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

/**
 * M9-A4：系统配置中文化。
 * 配置项按中文分组渲染，主标签为中文描述，英文 key 仅作小号辅助文本。
 */
test('admin config tab shows Chinese groups and saves checkinReward', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.admin)

  await page.goto('/admin')
  await page.getByRole('button', { name: '系统配置' }).click()

  // 7 个中文分组 Tab 全部出现
  const groups = ['注册与邀请', '基础奖励', '会员等级', '交易与交付', '库存提醒', '商品运营', '高级运维']
  for (const group of groups) {
    await expect(page.getByRole('tab', { name: group })).toBeVisible({ timeout: 10_000 })
  }

  // 切换到「基础奖励」分组
  await page.getByRole('tab', { name: '基础奖励' }).click()
  const rewardGroup = page.locator('[data-testid="admin-config-group"][data-group="基础奖励"]')
  await expect(rewardGroup).toBeVisible()

  // checkinReward：主标签是中文描述「每日签到基础奖励」，技术键默认折叠，主动展开后可见英文 key
  await expect(rewardGroup.getByText('每日签到基础奖励', { exact: true })).toBeVisible()
  // 精确匹配：同组还有 checkinRewardClaimDays 等以 checkinReward 开头的键。
  const keyDetails = rewardGroup.locator('details').filter({ has: page.getByText('checkinReward', { exact: true }) })
  await expect(keyDetails).toBeVisible()
  await expect(keyDetails.getByText('checkinReward')).toBeHidden()
  await keyDetails.locator('summary').click()
  await expect(keyDetails.getByText('checkinReward')).toBeVisible()

  const input = page.getByTestId('admin-config-input-checkinReward')
  const saveButton = page.getByTestId('admin-config-save-checkinReward')
  const savedToast = page.getByText('「每日签到基础奖励」已保存')

  const original = await input.inputValue()
  const modified = String(Number(original) + 1)

  // 修改并保存
  await input.fill(modified)
  await saveButton.click()
  await expect(savedToast).toBeVisible({ timeout: 10_000 })
  await expect(input).toHaveValue(modified)

  // 等首个 Toast 消失，避免与回滚保存的同文案 Toast 命中冲突
  await expect(savedToast).toBeHidden({ timeout: 10_000 })

  // 改回原值，保证可重复执行
  await input.fill(original)
  await saveButton.click()
  await expect(savedToast).toBeVisible({ timeout: 10_000 })
  await expect(input).toHaveValue(original)
})

// Global configuration is a critical admin journey (testing-policy §3).
// Uses only a dummy key and never sends a request to OpenAI.
test('admin manages AI credentials and switches from the unified configuration page', async ({ page }) => {
  // This journey verifies configuration persistence. The Vite development app
  // mounts effects twice under StrictMode; finish both initial reads before
  // editing so a late initial response cannot replace the values being tested.
  const initialReads = new Set<Request>()
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().endsWith('/api/admin/ai/config')) {
      initialReads.add(request)
    }
  })
  const finishRead = (request: Request) => { initialReads.delete(request) }
  page.on('requestfinished', finishRead)
  page.on('requestfailed', finishRead)
  await loginAs(page, SEED_ACCOUNTS.admin)
  await page.goto('/admin')
  await page.getByRole('button', { name: '系统配置' }).click()
  await page.getByRole('tab', { name: 'AI 辅助' }).click()
  const key = page.getByLabel('API Key', { exact: true })
  await expect(key).toBeEnabled()
  await expect.poll(() => initialReads.size).toBe(0)
  await page.getByLabel('API 地址（Base URL）', { exact: true }).fill('https://e2e-gateway.example/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('vendor/e2e-model')
  await key.fill('sk-e2e-dummy-never-send-to-openai-5678')
  await page.getByLabel('AI 总开关', { exact: true }).check()
  await page.getByLabel('商品 Copilot（新建与说明整理）', { exact: true }).check()
  await expect(page.getByLabel('API 地址（Base URL）', { exact: true })).toHaveValue('https://e2e-gateway.example/v1')
  const saved = page.waitForResponse(r => r.url().endsWith('/api/admin/ai/config') && r.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click()
  const savedResponse = await saved
  expect(savedResponse.status()).toBe(200)
  // Inspect only non-secret fields, including when an assertion fails.
  expect(savedResponse.request().postDataJSON().baseUrl).toBe('https://e2e-gateway.example/v1')
  expect(savedResponse.request().postDataJSON().model).toBe('vendor/e2e-model')
  const savedSettings = await savedResponse.json()
  expect(savedSettings.baseUrl).toBe('https://e2e-gateway.example/v1')
  expect(savedSettings.model).toBe('vendor/e2e-model')
  await expect(key).toHaveValue('')
  await page.reload()
  await page.getByRole('button', { name: '系统配置' }).click()
  await page.getByRole('tab', { name: 'AI 辅助' }).click()
  await expect(page.getByText(/已配置 · ••••5678/)).toBeVisible()
  await expect(page.getByLabel('API 地址（Base URL）', { exact: true })).toHaveValue('https://e2e-gateway.example/v1')
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('vendor/e2e-model')
  await expect(page.getByLabel('商品 Copilot（新建与说明整理）', { exact: true })).toBeChecked()
  await expect(page.getByTestId('admin-config-input-aiProductCopilotDailyQuotaAdmin')).toBeVisible()
  await expect(page.getByTestId('admin-config-input-aiProductCopilotDailyQuotaMerchant')).toBeVisible()
  await page.getByLabel('清除已保存密钥，同时关闭 AI', { exact: true }).check()
  const cleared = page.waitForResponse(r => r.url().endsWith('/api/admin/ai/config') && r.request().method() === 'PUT')
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click()
  expect((await cleared).status()).toBe(200)
  await expect(page.getByLabel('AI 总开关', { exact: true })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '测试已保存的连接' })).toBeDisabled()
})

// Exercise the real DB-backed operational settings and registry without a restart.
test('admin updates notification settings and public capabilities at runtime', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.admin)
  await page.goto('/admin')
  await page.getByRole('button', { name: '系统配置' }).click()
  await page.getByRole('tab', { name: '高级运维' }).click()
  const toggle = page.getByRole('switch', { name: '启用站内通知' })
  const originalEnabled = await toggle.getAttribute('aria-checked') === 'true'
  const originalExpiry = await page.getByTestId('admin-config-input-notificationExpiryDays').inputValue()
  const changeToggle = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/admin/config/notificationEnabled') && r.request().method() === 'PUT')
    await toggle.click()
    expect((await response).status()).toBe(200)
  }
  await changeToggle()
  await expect(toggle).toHaveAttribute('aria-checked', String(!originalEnabled))
  expect((await (await page.request.get('/api/config/registry')).json()).capabilities.notifications).toBe(!originalEnabled)
  await page.reload()
  await page.getByRole('button', { name: '系统配置' }).click()
  await page.getByRole('tab', { name: '高级运维' }).click()
  await expect(toggle).toHaveAttribute('aria-checked', String(!originalEnabled))
  await changeToggle()
  await expect(toggle).toHaveAttribute('aria-checked', String(originalEnabled))
  const expiry = page.getByTestId('admin-config-input-notificationExpiryDays')
  const save = page.getByTestId('admin-config-save-notificationExpiryDays')
  const nextExpiry = originalExpiry === '7' ? '3' : '7'
  for (const value of [nextExpiry, originalExpiry]) {
    await expiry.fill(value)
    const response = page.waitForResponse(r => r.url().endsWith('/api/admin/config/notificationExpiryDays') && r.request().method() === 'PUT')
    await save.click()
    expect((await response).status()).toBe(200)
    await expect(expiry).toHaveValue(value)
  }
})
