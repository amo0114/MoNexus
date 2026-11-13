import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { integrationProbeLimiter } from '../modules/admin/integrationSettings.js'
import { createProductShareLink } from '../modules/products/shareLinks.js'
import { getShortlinkRuntimeConfig } from '../lib/runtimeSettings/shortlink.js'
import { SHORTLINK_LOGIN_PATH } from '../lib/shortlinkClient.js'

const settings = { apiBaseUrl: 'https://short-admin.example.com', publicOrigin: 'https://s.example.com', groupId: 'group-a' }
const credentials = { username: 'SHORTLINK-USER-SENTINEL', password: 'SHORTLINK-PASSWORD-SENTINEL' }
const original = { key: config.integrationCredentialsEncKey, previous: config.integrationCredentialsEncKeyPrevious, shortlink: config.shortlink }
const base = '/api/admin/integrations/shortlink/config'
let token: string
let adminId: number
let fetcher: ReturnType<typeof vi.fn>

beforeEach(async () => {
  config.integrationCredentialsEncKey = 'ac'.repeat(32)
  config.integrationCredentialsEncKeyPrevious = null
  config.shortlink = { enabled: false, apiBaseUrl: undefined, publicOrigin: undefined, username: undefined, password: undefined, groupId: undefined }
  const actor = await createTestUser('shortlink-admin@test.local', 'pass123', 'admin')
  adminId = actor.user.id
  token = (await loginAs(actor.user.email, actor.password)).accessToken
  integrationProbeLimiter.resetKey(String(adminId))
  fetcher = vi.fn(async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string)
    return new Response(JSON.stringify(url.endsWith(SHORTLINK_LOGIN_PATH)
      ? { code: '0', data: { token: 'TOKEN-SENTINEL' } }
      : { code: '0', data: { fullShortUrl: 'https://s.example.com/Abc123', originUrl: body.originUrl, gid: body.gid } }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  config.integrationCredentialsEncKey = original.key
  config.integrationCredentialsEncKeyPrevious = original.previous
  config.shortlink = original.shortlink
  vi.unstubAllGlobals()
})
const save = (overrides = {}) => api.put(base).set(authHeader(token)).send({ ...settings, credentials, expectedVersion: 0, ...overrides })
const action = (name: string, expectedVersion: number, extra = {}) => api.post(`${base}/${name}`).set(authHeader(token)).send({ expectedVersion, ...extra })
async function activate() {
  await save().expect(200)
  await action('test', 1).expect(200)
  await action('activate', 1).expect(200)
}

describe('shortlink runtime settings', () => {
  it('keeps bootstrap until an authenticated draft is activated; secrets never appear in responses or audit', async () => {
    await api.get(base).set(authHeader(token)).expect(200).expect('Cache-Control', 'no-store')
    const saved = await save().expect(200)
    expect(saved.body).toMatchObject({ version: 1, source: 'environment', tested: false, credentialsConfigured: true })
    expect(await getShortlinkRuntimeConfig()).toBeNull()
    await action('activate', 1).expect(400)
    await action('test', 1).expect(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(`${settings.apiBaseUrl}${SHORTLINK_LOGIN_PATH}`)
    const active = await action('activate', 1).expect(200)
    expect(active.body).toMatchObject({ version: 2, source: 'database', enabled: true, tested: false })
    expect((await getShortlinkRuntimeConfig())?.settings).toEqual({ ...settings, ...credentials })
    const revision = await prisma.integrationConfigRevision.findFirstOrThrow()
    const exposed = JSON.stringify([saved.body, active.body, await prisma.adminLog.findMany()])
    for (const secret of [credentials.username, credentials.password, revision.credentialsCiphertext!, 'TOKEN-SENTINEL']) expect(exposed).not.toContain(secret)
    // Re-testing after activation uses the retained draft identity, not the new control version.
    await action('test', 2).expect(200)
  })

  it('stops new creation while preserving ready links, history and permissions', async () => {
    await activate()
    const product = await createTestProduct('runtime shortlink', 50, 1, ['RUNTIME-LINK'])
    const first = await createProductShareLink(product.id, 'guest')
    const row = await prisma.productShareLink.findUniqueOrThrow({ where: { productId: product.id } })
    expect(row.configRevisionId).not.toBeNull()
    await action('enabled', 2, { enabled: false }).expect(200)
    fetcher.mockClear()
    expect(await createProductShareLink(product.id, 'guest')).toEqual({ ...first, reused: true })
    const another = await createTestProduct('disabled shortlink', 50, 1, ['DISABLED-LINK'])
    await expect(createProductShareLink(another.id, 'guest')).rejects.toMatchObject({ status: 503 })
    expect(fetcher).not.toHaveBeenCalled()
    await prisma.product.update({ where: { id: product.id }, data: { visibility: 'members_only' } })
    await expect(createProductShareLink(product.id, 'guest')).rejects.toMatchObject({ status: 404 })
  })

  it('binds an in-flight creation to its old revision while subsequent creates use a fresh client and token', async () => {
    await activate()
    const oldRevision = (await getShortlinkRuntimeConfig())!.revisionId
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalFetch = fetcher.getMockImplementation()! as (url: string, options: RequestInit) => Promise<Response>
    fetcher.mockImplementation(async (url: string, options: RequestInit) => {
      if (!url.endsWith(SHORTLINK_LOGIN_PATH) && url.startsWith(settings.apiBaseUrl)) { entered(); await gate }
      return originalFetch(url, options)
    })
    const firstProduct = await createTestProduct('in flight shortlink', 50, 1, ['FLIGHT-LINK'])
    const inFlight = createProductShareLink(firstProduct.id, 'guest')
    await started
    await save({ expectedVersion: 2, apiBaseUrl: 'https://new-admin.example.com' }).expect(200)
    await action('test', 3).expect(200)
    await action('activate', 3).expect(200)
    release()
    await inFlight
    expect((await prisma.productShareLink.findUniqueOrThrow({ where: { productId: firstProduct.id } })).configRevisionId).toBe(oldRevision)
    fetcher.mockClear()
    const next = await createTestProduct('next shortlink', 50, 1, ['NEXT-LINK'])
    await createProductShareLink(next.id, 'guest')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `https://new-admin.example.com${SHORTLINK_LOGIN_PATH}`, 'https://new-admin.example.com/api/short-link/admin/v1/create',
    ])
    await action('rollback', 4).expect(200)
    expect((await getShortlinkRuntimeConfig())?.revisionId).toBe(oldRevision)
    expect(await prisma.integrationConfigRevision.count()).toBe(2)
    await expect(prisma.integrationConfigRevision.update({ where: { id: oldRevision! }, data: { settings: { ...settings, groupId: 'tampered' } } })).rejects.toThrow()
  })

  it('does not validate an edited draft when a login probe finishes late', async () => {
    await save().expect(200)
    let finish!: () => void
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { finish = resolve })
    fetcher.mockImplementationOnce(async () => { enter(); await gate; return new Response(JSON.stringify({ code: '0', data: { token: 'late-token' } })) })
    const probing = action('test', 1).then(response => response)
    await entered
    await save({ expectedVersion: 1, groupId: 'changed' }).expect(200)
    finish()
    expect((await probing).status).toBe(409)
    await action('activate', 2).expect(400)
    const concurrent = await Promise.all([save({ expectedVersion: 2 }), save({ expectedVersion: 2 })])
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409])
  })

  it('preserves credentials for the same destination, requires replacements for a new origin and sanitizes probe failures', async () => {
    await save().expect(200)
    await save({ expectedVersion: 1, credentials: undefined, apiBaseUrl: 'https://other.example.com' }).expect(400)
    await save({ expectedVersion: 1, credentials: undefined, groupId: 'updated' }).expect(200)
    fetcher.mockRejectedValue(new Error(credentials.password))
    const failed = await action('test', 2).expect(502)
    expect(JSON.stringify([failed.body, await prisma.adminLog.findMany()])).not.toContain(credentials.password)
    await action('activate', 2).expect(400)
    config.integrationCredentialsEncKey = null
    await save({ expectedVersion: 2 }).expect(403)
  })

  it('rewraps all retained revisions and the draft before removing the previous root', async () => {
    await activate()
    const first = (await getShortlinkRuntimeConfig())!.revisionId
    await save({ expectedVersion: 2, groupId: 'second' }).expect(200)
    await action('test', 3).expect(200)
    await action('activate', 3).expect(200)
    config.integrationCredentialsEncKeyPrevious = config.integrationCredentialsEncKey
    config.integrationCredentialsEncKey = null
    await action('test', 4).expect(200)
    await action('activate', 4).expect(403)
    config.integrationCredentialsEncKey = 'bd'.repeat(32)
    await action('rewrap', 4).expect(200)
    config.integrationCredentialsEncKeyPrevious = null
    expect((await getShortlinkRuntimeConfig())?.settings.groupId).toBe('second')
    await action('rollback', 5).expect(200)
    expect((await getShortlinkRuntimeConfig())?.revisionId).toBe(first)
    await action('test', 6).expect(200)
    await action('activate', 6).expect(200)
  })

  it('requires settings.manage and MFA and rejects unsafe endpoints', async () => {
    const user = await createTestUser('shortlink-normal@test.local')
    const normal = (await loginAs(user.user.email, user.password)).accessToken
    const session = await prisma.refreshToken.findFirstOrThrow({ where: { userId: adminId, revoked: false } })
    const noMfa = jwt.sign({ userId: adminId, role: 'admin', sid: session.sessionId }, config.jwtSecret, { expiresIn: '15m' })
    for (const path of [base, `${base}/test`, `${base}/activate`, `${base}/rollback`, `${base}/enabled`, `${base}/rewrap`]) {
      const call = () => path === base ? api.put(path).send({}) : api.post(path).send({})
      await call().expect(401)
      await call().set(authHeader(normal)).expect(403)
      await call().set(authHeader(noMfa)).expect(403)
    }
    for (const apiBaseUrl of ['http://admin.example.com', 'https://user:pass@admin.example.com', 'https://admin.example.com/path', 'https://admin.example.com/?token=x']) await save({ apiBaseUrl }).expect(400)
    await prisma.adminAuthorization.update({ where: { userId: adminId }, data: { tier: 'operator' } })
    await api.get(base).set(authHeader(token)).expect(403)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
