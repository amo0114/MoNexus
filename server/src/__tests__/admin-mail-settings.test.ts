import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { createServer, type AddressInfo } from 'node:net'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { decryptMailCredentials, getMailRuntimeConfig } from '../lib/mailer/runtimeConfig.js'
import { getMailer } from '../lib/mailer/index.js'
import { SmtpMailer } from '../lib/mailer/smtp.js'

const credentials = { user: 'smtp-user-SENTINEL', pass: 'smtp-password-SENTINEL-123' }
const transport = { host: 'smtp.example.com', port: 587, secure: false, from: 'mail@example.com', fromName: 'MoNexus' }
const original = { key: config.mailCredentialsEncKey, previous: config.mailCredentialsEncKeyPrevious, mailer: config.mailer }
let token: string
let adminId: number

beforeEach(async () => {
  config.mailCredentialsEncKey = 'ab'.repeat(32)
  config.mailCredentialsEncKeyPrevious = null
  config.mailer = { kind: 'console' }
  const actor = await createTestUser('mail-settings-admin@test.local', 'pass123', 'admin')
  adminId = actor.user.id
  token = (await loginAs(actor.user.email, actor.password)).accessToken
})
afterEach(() => {
  config.mailCredentialsEncKey = original.key
  config.mailCredentialsEncKeyPrevious = original.previous
  config.mailer = original.mailer
  vi.restoreAllMocks()
})

const save = (overrides = {}) => api.put('/api/admin/mail/config').set(authHeader(token))
  .send({ ...transport, expectedVersion: 0, credentials, ...overrides })
const operate = (action: string, version: number) => api.post(`/api/admin/mail/config/${action}`)
  .set(authHeader(token)).send({ expectedVersion: version, ...(action === 'test' ? { email: 'OPERATOR@example.com' } : {}) })

describe('versioned business SMTP configuration', () => {
  it('delivers a draft test and a subsequent active email through a real local SMTP socket', async () => {
    let deliveries = 0
    let authentications = 0
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.write('220 localhost ESMTP\r\n')
      let buffer = ''
      let receivingData = false
      socket.on('data', chunk => {
        buffer += chunk
        while (buffer.includes('\r\n')) {
          const end = buffer.indexOf('\r\n')
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (receivingData) {
            if (line === '.') { deliveries += 1; receivingData = false; socket.write('250 accepted\r\n') }
          } else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
          else if (/^STARTTLS/.test(line)) socket.write('502 TLS unavailable\r\n')
          else if (/^AUTH/.test(line)) { authentications += 1; socket.write('235 authenticated\r\n') }
          else if (/^DATA/.test(line)) { receivingData = true; socket.write('354 send message\r\n') }
          else if (/^QUIT/.test(line)) socket.end('221 bye\r\n')
          else socket.write('250 OK\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await save({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, credentials: null }).expect(200)
      await operate('test', 1).expect(200)
      await operate('activate', 1).expect(200)
      const mailer = await getMailer()
      await mailer.send({ to: 'operator@example.com', subject: 'Runtime snapshot test', text: 'Local test only' })
      expect(deliveries).toBe(2)
      // A relay that lacks STARTTLS must never receive authentication credentials.
      await save({ expectedVersion: 2, host: '127.0.0.1', port: (server.address() as AddressInfo).port }).expect(200)
      await operate('test', 3).expect(502)
      expect(authentications).toBe(0)
      expect(deliveries).toBe(2)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('keeps the environment active until the saved and tested draft is activated', async () => {
    const get = await api.get('/api/admin/mail/config').set(authHeader(token)).expect(200)
    expect(get.headers['cache-control']).toBe('no-store')
    expect(get.body).toMatchObject({ version: 0, source: 'environment', draft: null })
    const saved = await save().expect(200)
    expect(saved.body).toMatchObject({ version: 1, source: 'environment', tested: false, draftAuthConfigured: true })
    expect((await getMailRuntimeConfig()).mailer.kind).toBe('console')
    const row = await prisma.mailRuntimeConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(decryptMailCredentials(row.draftCredentialsCiphertext!, row.draft as typeof transport)).toEqual(credentials)
    const exposed = JSON.stringify([saved.body, await prisma.adminLog.findMany()])
    for (const value of [credentials.user, credentials.pass, row.draftCredentialsCiphertext!]) expect(exposed).not.toContain(value)
    await operate('activate', 1).expect(400)
    const send = vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await operate('test', 1).expect(200)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'operator@example.com', subject: 'MoNexus 邮件投递测试' }))
    await operate('activate', 1).expect(200)
    expect(await getMailRuntimeConfig()).toMatchObject({ source: 'database', version: 1, mailer: { host: transport.host, ...credentials } })
    const status = await api.get('/api/admin/mail/status').set(authHeader(token)).expect(200)
    expect(status.body).toEqual({ mode: 'smtp', deliveryReady: true, from: transport.from, authConfigured: true, configuredVia: 'database' })
    expect(JSON.stringify(await prisma.adminLog.findMany())).not.toContain('operator@example.com')
  })

  it('keeps the active service unchanged after a failed draft test and sanitizes provider errors', async () => {
    await save().expect(200)
    vi.spyOn(SmtpMailer.prototype, 'send').mockRejectedValue(Object.assign(new Error(credentials.pass), { code: 'EAUTH' }))
    const failed = await operate('test', 1).expect(502)
    expect(failed.body.error.message).toContain('EAUTH')
    expect(JSON.stringify(failed.body)).not.toContain(credentials.pass)
    await operate('activate', 1).expect(400)
    expect((await getMailRuntimeConfig()).source).toBe('environment')
    expect(JSON.stringify(await prisma.adminLog.findMany())).not.toContain(credentials.pass)
  })

  it('rejects stale saves and invalidates successful tests after a draft edit', async () => {
    await save().expect(200)
    await save().expect(409)
    vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await operate('test', 1).expect(200)
    await save({ expectedVersion: 1, fromName: 'Updated' }).expect(200)
    await operate('activate', 1).expect(409)
    await operate('activate', 2).expect(400)
    const concurrent = await Promise.all([save({ expectedVersion: 2 }), save({ expectedVersion: 2 })])
    expect(concurrent.map(result => result.status).sort()).toEqual([200, 409])
  })

  it('does not activate a test that completed after a concurrent edit', async () => {
    await save().expect(200)
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(SmtpMailer.prototype, 'send').mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve }) })
    const testing = operate('test', 1).then(response => response)
    await ready
    await save({ expectedVersion: 1, fromName: 'Concurrent change' }).expect(200)
    finish()
    expect((await testing).status).toBe(409)
    await operate('activate', 2).expect(400)
  })

  it('requires explicit credentials when changing destination and preserves them otherwise', async () => {
    await save().expect(200)
    await save({ expectedVersion: 1, credentials: undefined, host: 'other.example.com' }).expect(400)
    await save({ expectedVersion: 1, credentials: undefined, fromName: 'Changed' }).expect(200)
    const row = await prisma.mailRuntimeConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(decryptMailCredentials(row.draftCredentialsCiphertext!, row.draft as typeof transport)).toEqual(credentials)
    await save({ expectedVersion: 2, host: 'other.example.com', credentials: null }).expect(200)
    expect((await prisma.mailRuntimeConfig.findUniqueOrThrow({ where: { id: 1 } })).draftCredentialsCiphertext).toBeNull()
  })

  it('uses a fresh snapshot on subsequent sends, and rolls back without restarting', async () => {
    vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await save().expect(200)
    await operate('test', 1).expect(200)
    await operate('activate', 1).expect(200)
    const first = await getMailer()
    await save({ expectedVersion: 2, host: 'new.example.com', credentials: { user: 'new-user', pass: 'new-password' } }).expect(200)
    await operate('test', 3).expect(200)
    await operate('activate', 3).expect(200)
    expect(await getMailer()).not.toBe(first)
    expect((await getMailRuntimeConfig()).mailer).toMatchObject({ host: 'new.example.com', user: 'new-user' })
    await operate('rollback', 4).expect(200)
    expect((await getMailRuntimeConfig()).mailer).toMatchObject({ host: transport.host, user: credentials.user })
    await operate('rollback', 4).expect(409)
  })

  it('can explicitly roll back the first activation to the environment bootstrap', async () => {
    vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await save().expect(200)
    await operate('test', 1).expect(200)
    await operate('activate', 1).expect(200)
    await operate('rollback', 2).expect(200)
    expect((await getMailRuntimeConfig()).source).toBe('environment')
  })

  it('supports a previous root key during rotation and refuses silent env fallback on decrypt failure', async () => {
    vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await save().expect(200)
    await operate('test', 1).expect(200)
    await operate('activate', 1).expect(200)
    config.mailCredentialsEncKeyPrevious = config.mailCredentialsEncKey
    config.mailCredentialsEncKey = 'cd'.repeat(32)
    expect((await getMailRuntimeConfig()).mailer).toMatchObject(credentials)
    // Saving also re-encrypts preserved credentials under the current root key.
    await save({ expectedVersion: 2, credentials: undefined }).expect(200)
    config.mailCredentialsEncKeyPrevious = null
    const row = await prisma.mailRuntimeConfig.findUniqueOrThrow({ where: { id: 1 } })
    expect(decryptMailCredentials(row.draftCredentialsCiphertext!, row.draft as typeof transport)).toEqual(credentials)
    await expect(getMailer()).rejects.toMatchObject({ status: 503 })
    await api.get('/api/admin/mail/status').set(authHeader(token)).expect(503)
  })

  it('requires an external root key for secrets and validates transport fields', async () => {
    config.mailCredentialsEncKey = null
    await save().expect(403)
    await save({ credentials: null }).expect(200)
    await save({ expectedVersion: 1, host: 'smtp.example.com\r\nX-Injected: yes', credentials: null }).expect(400)
    await save({ expectedVersion: 1, fromName: 'Name\r\nBcc: victim@example.com', credentials: null }).expect(400)
    expect(await prisma.mailRuntimeConfig.count()).toBe(1)
  })

  it('rejects destination tampering without decrypting credentials for the altered host', async () => {
    vi.spyOn(SmtpMailer.prototype, 'send').mockResolvedValue()
    await save().expect(200)
    await operate('test', 1).expect(200)
    await operate('activate', 1).expect(200)
    await prisma.mailRuntimeConfig.update({ where: { id: 1 }, data: { active: { ...transport, host: 'altered.example.com' } } })
    await expect(getMailer()).rejects.toMatchObject({ status: 503 })
  })

  it('preserves the environment sender name when bootstrapping a draft', async () => {
    const oldName = config.smtpFromName
    try {
      config.smtpFromName = 'Custom sender'
      config.mailer = { kind: 'smtp', ...transport, ...credentials, displayFrom: transport.from }
      const response = await api.get('/api/admin/mail/config').set(authHeader(token)).expect(200)
      expect(response.body.bootstrap.fromName).toBe('Custom sender')
    } finally { config.smtpFromName = oldName }
  })

  it('requires authentication, settings permission and an MFA session on every new endpoint', async () => {
    const actor = await createTestUser('mail-settings-user@test.local')
    const normal = (await loginAs(actor.user.email, actor.password)).accessToken
    const session = await prisma.refreshToken.findFirstOrThrow({ where: { userId: adminId, revoked: false } })
    const noMfa = jwt.sign({ userId: adminId, role: 'admin', sid: session.sessionId }, config.jwtSecret, { expiresIn: '15m' })
    for (const path of ['/api/admin/mail/config', '/api/admin/mail/config/test', '/api/admin/mail/config/activate', '/api/admin/mail/config/rollback']) {
      const call = () => path.endsWith('/config') ? api.put(path).send({}) : api.post(path).send({})
      await call().expect(401)
      await call().set(authHeader(normal)).expect(403)
      await call().set(authHeader(noMfa)).expect(403)
    }
    await api.get('/api/admin/mail/config').set(authHeader(normal)).expect(403)
    await prisma.adminAuthorization.update({ where: { userId: adminId }, data: { tier: 'operator' } })
    await api.get('/api/admin/mail/config').set(authHeader(token)).expect(403)
  })
})
