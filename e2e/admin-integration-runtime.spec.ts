import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS, selectAdminTab } from './helpers'

const shortlink = { apiBaseUrl: 'https://short-admin.example.com', publicOrigin: 'https://s.example.com', groupId: 'links' }
const faka = { url: 'https://bridge.example.com/plugin/faka-bridge/order-paid', statusUrl: 'https://bridge.example.com/plugin/faka-bridge/order-status', revokeUrl: 'https://bridge.example.com/plugin/faka-bridge/order-revoke', panelUrl: 'https://bridge.example.com', instanceId: null, clientId: 'monexus', timeoutMs: 3000, maxAttempts: 3 }
function initial(bootstrap: unknown = null) { return { version: 0, activeRevisionId: null as string | null, source: 'environment', enabled: true, encryptionReady: true, draft: null as any, bootstrap, credentialsConfigured: false, tested: false, rollbackAvailable: false, updatedAt: null, testKind: 'local_validation' } }

test('admin saves, validates and activates integrations while preserving unsaved emergency-stop edits', async ({ page }) => {
  const states = { shortlink: initial(shortlink), 'faka-bridge': initial(faka), 'payments/stripe': initial() }
  const submitted: Array<{ service: string; body: any }> = []
  let failProbe = true
  await page.route(url => /^\/api\/admin\/integrations\/(shortlink|faka-bridge|payments\/stripe)\/config(?:\/[^/]+)?$/.test(url.pathname), async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const [, service, action] = path.match(/^\/api\/admin\/integrations\/(shortlink|faka-bridge|payments\/stripe)\/config(?:\/(.*))?$/)!
    let state = states[service as keyof typeof states]
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); submitted.push({ service, body })
      if (request.method() === 'PUT') {
        const { credentials: _credentials, expectedVersion: _version, ...publicBody } = body
        state = { ...state, draft: body.settings ?? publicBody, version: state.version + 1, credentialsConfigured: true, tested: false }
      } else if (action === 'test') {
        if (service === 'shortlink' && failProbe) { failProbe = false; return route.fulfill({ status: 502, json: { error: { code: 'INTERNAL_SERVER_ERROR', message: '短链登录探测失败' } } }) }
        state = { ...state, tested: true }
      } else if (action === 'activate') state = { ...state, activeRevisionId: 'fixture-active', version: state.version + 1, source: 'database', tested: false, rollbackAvailable: true }
      else if (action === 'enabled') state = { ...state, enabled: body.enabled, tested: false, version: state.version + 1 }
      else if (action === 'rollback') state = { ...state, activeRevisionId: null, source: 'environment', tested: false, version: state.version + 1 }
      states[service as keyof typeof states] = state
    }
    await route.fulfill({ json: state })
  })
  await loginAs(page, SEED_ACCOUNTS.admin)
  await page.goto('/admin'); await selectAdminTab(page, 'config')
  await page.getByRole('tab', { name: '高级运维' }).click()
  const short = page.getByTestId('admin-shortlink-settings')
  await short.getByLabel('短链账号').fill('fixture-user'); await short.getByLabel('短链密码').fill('fixture-password')
  await short.getByRole('button', { name: '保存短链草稿' }).click()
  await expect(short.getByLabel('短链密码')).toHaveValue('')
  await short.getByRole('button', { name: '探测短链登录' }).click()
  await expect(short.getByRole('alert')).toContainText('短链登录探测失败')
  await expect(short.getByRole('button', { name: '激活短链草稿' })).toBeDisabled()
  await short.getByRole('button', { name: '探测短链登录' }).click()
  await short.getByRole('button', { name: '激活短链草稿' }).click()
  await expect(short).toContainText('管理员后台')
  await short.getByLabel('短链分组').fill('unsaved-links')
  await short.getByRole('button', { name: '停止新建短链' }).click()
  await expect(short.getByLabel('短链分组')).toHaveValue('unsaved-links')
  await short.getByRole('button', { name: '回滚短链配置' }).click()
  await expect(short).toContainText('部署环境变量')

  const bridge = page.getByTestId('admin-faka-settings')
  await bridge.getByLabel('签名密钥', { exact: true }).fill('fixture-faka-signing-secret')
  await bridge.getByRole('button', { name: '保存履约草稿' }).click()
  await expect(bridge.getByLabel('签名密钥', { exact: true })).toHaveValue('')
  await bridge.getByRole('button', { name: '探测履约配置' }).click()
  await bridge.getByRole('checkbox').check()
  await bridge.getByRole('button', { name: '激活履约草稿' }).click()
  await expect(bridge).toContainText('管理员后台')
  expect(submitted.find(item => item.service === 'faka-bridge' && item.body.legacyConfirmed)?.body.legacyConfirmed).toBe(true)
  await bridge.getByRole('button', { name: '停止新履约' }).click()
  await expect(bridge).toContainText('已停止')
  await bridge.getByRole('button', { name: '回滚履约配置' }).click()

  const payment = page.getByTestId('payment-settings-stripe')
  await payment.getByLabel('商户账号 ID（acct_ 开头）').fill('acct_fixture')
  await payment.getByLabel('API 密钥', { exact: true }).fill('sk_test_fixture')
  await payment.getByLabel('Webhook 签名密钥', { exact: true }).fill('whsec_fixture')
  await payment.getByRole('button', { name: '保存支付草稿' }).click()
  await expect(payment.getByLabel('API 密钥', { exact: true })).toHaveValue('')
  await payment.getByRole('button', { name: '校验支付配置' }).click()
  await payment.getByRole('button', { name: '激活支付草稿' }).click()
  await expect(payment).toContainText('管理员后台')
  await payment.getByRole('button', { name: '停止新收款' }).click()
  await expect(payment).toContainText('已停止')
  await expect(payment).toContainText('历史回调、查询、退款与对账继续保留')
  await payment.getByRole('button', { name: '回滚支付配置' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(el => el.clientWidth))
})
