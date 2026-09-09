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
  const keyDetails = rewardGroup.locator('details').filter({ hasText: 'checkinReward' })
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
