import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

/**
 * M9-A4：系统配置中文化。
 * 配置项按中文分组渲染，主标签为中文描述，英文 key 仅作小号辅助文本。
 */
test('admin config tab shows Chinese groups and saves checkinReward', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.admin)

  await page.goto('/admin')
  await page.getByRole('button', { name: '系统配置' }).click()

  // 5 个中文分组全部出现
  for (const group of ['奖励发放', '安全', '分页限制', '库存', '会员等级']) {
    await expect(
      page.locator(`[data-testid="admin-config-group"][data-group="${group}"]`)
    ).toBeVisible({ timeout: 10_000 })
  }

  // checkinReward：主标签是中文描述（粗体正文），英文 key 是 mono 小字辅助文本，无裸 key 主标签
  const rewardGroup = page.locator('[data-testid="admin-config-group"][data-group="奖励发放"]')
  await expect(rewardGroup.getByText('每日签到奖励积分', { exact: true })).toBeVisible()
  await expect(rewardGroup.locator('.font-mono', { hasText: 'checkinReward' })).toBeVisible()
  // 主标签（font-bold 描述行）不应直接是英文 key
  await expect(rewardGroup.locator('div.font-bold', { hasText: /^checkinReward$/ })).toHaveCount(0)

  const input = page.getByTestId('admin-config-input-checkinReward')
  const saveButton = page.getByTestId('admin-config-save-checkinReward')
  const savedToast = page.getByText('「每日签到奖励积分」已保存')

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
