import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import {
  cleanupStaleM3IshFixtures,
  createM3IshAdminFixture,
  disconnectM3IshFixtureDb,
  type M3IshAdminFixture,
} from './support/m3IdentitySecurityHardeningFixture'

type AdministratorEnrollment = {
  manualKey: string
  recoveryCodes: string[]
}

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url))
const { TOTP } = serverRequire('otpauth') as {
  TOTP: new (options: Record<string, unknown>) => { generate: (options: { timestamp: number }) => string }
}

function totpAt(manualKey: string, timestamp: number) {
  return new TOTP({
    issuer: 'MoNexus',
    label: 'administrator',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: manualKey,
  }).generate({ timestamp })
}

function currentTotp(manualKey: string) {
  return totpAt(manualKey, Date.now())
}

function totpOutsideAcceptedWindow(manualKey: string, now = Date.now()) {
  const acceptedCodes = new Set([
    totpAt(manualKey, now - 30_000),
    totpAt(manualKey, now),
    totpAt(manualKey, now + 30_000),
  ])

  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const code = String(candidate).padStart(6, '0')
    if (!acceptedCodes.has(code)) return code
  }

  throw new Error('Unable to choose a TOTP outside the accepted window')
}

async function submitPassword(page: Page, fixture: M3IshAdminFixture) {
  await page.goto('/login')
  await page.getByLabel('邮箱地址').fill(fixture.email)
  await page.getByLabel('密码（至少 6 位）').fill(fixture.password)
  await page.getByRole('button', { name: '登录' }).click()
}

async function enrollAdministrator(page: Page, fixture: M3IshAdminFixture): Promise<AdministratorEnrollment> {
  await submitPassword(page, fixture)
  await expect(page.getByTestId('mfa-enrollment')).toBeVisible()

  const manualKey = (await page.getByTestId('mfa-manual-key').textContent())?.trim()
  if (!manualKey) throw new Error('Enrollment UI did not provide a manual TOTP key')

  await page.getByTestId('mfa-factor-code').fill(currentTotp(manualKey))
  await page.getByTestId('mfa-enrollment-confirm').click()
  await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible()
  const recoveryCodes = await page.getByTestId('mfa-recovery-codes').getByRole('listitem').allTextContents()
  if (recoveryCodes.length !== 10 || recoveryCodes.some((code) => !code.trim())) {
    throw new Error('Enrollment UI did not provide the expected recovery-code count')
  }
  await page.getByTestId('mfa-recovery-acknowledgement').check()
  await page.getByTestId('mfa-recovery-continue').click()
  await expect(page).toHaveURL(/\/$/)

  return { manualKey, recoveryCodes: recoveryCodes.map((code) => code.trim()) }
}

async function logInWithTotp(page: Page, fixture: M3IshAdminFixture, manualKey: string) {
  await submitPassword(page, fixture)
  await expect(page.getByTestId('mfa-verification')).toBeVisible()
  await page.getByTestId('mfa-factor-code').fill(currentTotp(manualKey))
  await page.getByTestId('mfa-verify').click()
  await expect(page).toHaveURL(/\/$/)
}

async function openAdmin(page: Page) {
  const adminStatsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/admin/stats' && response.request().method() === 'GET'
  })
  await page.getByText('管理后台', { exact: true }).click()
  expect((await adminStatsResponse).status()).toBe(200)
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('button', { name: '数据仪表盘' })).toBeVisible()
}

async function revokedSessionStatuses(page: Page) {
  return page.evaluate(async () => {
    const rawStore = localStorage.getItem('monexus-auth')
    const accessToken = rawStore ? JSON.parse(rawStore)?.state?.accessToken : null
    if (typeof accessToken !== 'string' || accessToken.length === 0) return { refresh: 0, admin: 0, adminCode: null }

    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const admin = await fetch('/api/admin/stats', {
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const body = await admin.json().catch(() => null)
    return { refresh: refresh.status, admin: admin.status, adminCode: body?.error?.code ?? null }
  })
}

test.describe('M3 identity security hardening real integration', () => {
  let fixture: M3IshAdminFixture | undefined

  test.beforeAll(async () => {
    await cleanupStaleM3IshFixtures()
  })

  test.beforeEach(async () => {
    fixture = await createM3IshAdminFixture()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  test.afterAll(async () => {
    await cleanupStaleM3IshFixtures()
    await disconnectM3IshFixtureDb()
  })

  test('enrolls a newly seeded administrator through the real MFA UI before opening admin', async ({ page }) => {
    if (!fixture) throw new Error('M3-ISH fixture was not initialized')

    await enrollAdministrator(page, fixture)
    await openAdmin(page)
  })

  test('keeps an enrolled administrator out after an incorrect TOTP and admits the correct factor', async ({ browser }) => {
    if (!fixture) throw new Error('M3-ISH fixture was not initialized')

    const enrollmentContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const loginContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    try {
      const { manualKey } = await enrollAdministrator(await enrollmentContext.newPage(), fixture)
      const page = await loginContext.newPage()

      await submitPassword(page, fixture)
      await expect(page.getByTestId('mfa-verification')).toBeVisible()
      await page.getByTestId('mfa-factor-code').fill(totpOutsideAcceptedWindow(manualKey))
      await page.getByTestId('mfa-verify').click()
      await expect(page.getByText('MFA 验证失败')).toBeVisible()
      await expect(page).toHaveURL(/\/login$/)

      await page.getByTestId('mfa-factor-code').fill(currentTotp(manualKey))
      await page.getByTestId('mfa-verify').click()
      await expect(page).toHaveURL(/\/$/)
      await openAdmin(page)
    } finally {
      await loginContext.close()
      await enrollmentContext.close()
    }
  })

  test('allows one real recovery-code login and rejects reuse without creating a session', async ({ browser }) => {
    if (!fixture) throw new Error('M3-ISH fixture was not initialized')

    const enrollmentContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const recoveryContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const reusedCodeContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    try {
      const { recoveryCodes } = await enrollAdministrator(await enrollmentContext.newPage(), fixture)
      const recoveryCode = recoveryCodes[0]
      if (!recoveryCode) throw new Error('Enrollment did not provide a recovery code')

      const recoveryPage = await recoveryContext.newPage()
      await submitPassword(recoveryPage, fixture)
      await expect(recoveryPage.getByTestId('mfa-verification')).toBeVisible()
      await recoveryPage.getByTestId('mfa-use-recovery-code').click()
      await recoveryPage.getByTestId('mfa-factor-code').fill(recoveryCode)
      await recoveryPage.getByTestId('mfa-verify').click()
      await expect(recoveryPage).toHaveURL(/\/$/)
      await openAdmin(recoveryPage)

      const reusedPage = await reusedCodeContext.newPage()
      await submitPassword(reusedPage, fixture)
      await expect(reusedPage.getByTestId('mfa-verification')).toBeVisible()
      await reusedPage.getByTestId('mfa-use-recovery-code').click()
      await reusedPage.getByTestId('mfa-factor-code').fill(recoveryCode)
      await reusedPage.getByTestId('mfa-verify').click()
      await expect(reusedPage.getByText('MFA 验证失败')).toBeVisible()
      await expect(reusedPage).toHaveURL(/\/login$/)
      expect(await reusedPage.evaluate(async () => (await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })).status)).toBe(401)
    } finally {
      await reusedCodeContext.close()
      await recoveryContext.close()
      await enrollmentContext.close()
    }
  })

  test('revokes one browser session through Profile UI and immediately blocks its refresh and admin API', async ({ browser }) => {
    if (!fixture) throw new Error('M3-ISH fixture was not initialized')

    const currentContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    const revokedContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    try {
      const currentPage = await currentContext.newPage()
      const { manualKey } = await enrollAdministrator(currentPage, fixture)
      const revokedPage = await revokedContext.newPage()
      await logInWithTotp(revokedPage, fixture, manualKey)

      await currentPage.goto('/profile')
      await expect(currentPage.getByTestId('session-manager')).toBeVisible()
      await expect(currentPage.getByTestId('session-device')).toHaveCount(2)
      const revokedDevice = currentPage.getByTestId('session-device').filter({
        has: currentPage.getByTestId('session-revoke-device'),
      })
      await expect(revokedDevice).toHaveCount(1)
      await revokedDevice.getByTestId('session-revoke-device').click()
      await currentPage.getByRole('button', { name: '确认退出' }).click()
      await expect(currentPage.getByTestId('session-device')).toHaveCount(1)
      await openAdmin(currentPage)

      const statuses = await revokedSessionStatuses(revokedPage)
      expect(statuses.refresh).toBe(401)
      expect(statuses.admin).toBe(401)
      expect(statuses.adminCode).toBe('SESSION_REVOKED')
    } finally {
      await revokedContext.close()
      await currentContext.close()
    }
  })
})
