import { Router } from 'express'
import { Prisma, type MailRuntimeConfig } from '@prisma/client'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, forbidden, HttpError } from '../../lib/httpError.js'
import { normalizedEmailSchema } from '../../lib/email.js'
import { validate } from '../../middlewares/validate.js'
import {
  buildSmtpConfig, decryptMailCredentials, encryptMailCredentials,
  smtpCredentialsSchema, smtpPublicConfigSchema,
} from '../../lib/mailer/runtimeConfig.js'
import { SmtpMailer } from '../../lib/mailer/smtp.js'
import { renderMail } from '../../lib/mailer/templates/index.js'
import { adminMailTestLimiter } from './mailTestLimiter.js'
import { classifyMailTestFailure, maskRecipientForAudit } from './mailOperations.js'

const versionSchema = z.number().int().min(0).max(2147483646)
const versionBody = z.object({ expectedVersion: versionSchema }).strict()
const saveSchema = smtpPublicConfigSchema.extend({
  expectedVersion: versionSchema,
  // Missing = preserve, null = unauthenticated relay, object = replace.
  credentials: smtpCredentialsSchema.nullable().optional(),
}).strict()
const testSchema = versionBody.extend({ email: normalizedEmailSchema }).strict()

function requireVersion(row: MailRuntimeConfig | null, expectedVersion: number) {
  if ((row?.version ?? 0) !== expectedVersion) throw conflict('邮件配置已被更新，请重新加载后再操作')
}

function publicSettings(row: MailRuntimeConfig | null) {
  const bootstrap = config.mailer.kind === 'smtp' ? {
    host: config.mailer.host, port: config.mailer.port, secure: config.mailer.secure,
    from: config.mailer.displayFrom ?? '', fromName: config.smtpFromName,
  } : null
  return {
    version: row?.version ?? 0,
    activeVersion: row?.activeVersion ?? 0,
    source: row?.active ? 'database' : 'environment',
    encryptionReady: Boolean(config.mailCredentialsEncKey),
    draft: row?.draft ? smtpPublicConfigSchema.parse(row.draft) : null,
    bootstrap,
    draftAuthConfigured: row?.draft
      ? Boolean(row.draftCredentialsCiphertext)
      : config.mailer.kind === 'smtp' && Boolean(config.mailer.user && config.mailer.pass),
    tested: Boolean(row?.draft && row.testedVersion === row.version),
    rollbackAvailable: row?.rollbackAvailable ?? false,
    updatedAt: row?.updatedAt ?? null,
  }
}

async function audit(tx: Prisma.TransactionClient, adminUserId: number, action: string, version: number) {
  await tx.adminLog.create({ data: {
    adminUserId, action, targetType: 'mailRuntimeConfig', targetId: 1,
    // No host, login, password, ciphertext or submitted body in audit records.
    detail: JSON.stringify({ version }),
  } })
}

async function locked<T>(work: (tx: Prisma.TransactionClient, row: MailRuntimeConfig | null) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261113::int4, 1::int4)`
    return work(tx, await tx.mailRuntimeConfig.findUnique({ where: { id: 1 } }))
  })
}

export async function saveMailDraft(adminUserId: number, input: z.infer<typeof saveSchema>) {
  return locked(async (tx, row) => {
    requireVersion(row, input.expectedVersion)
    const { expectedVersion: _version, credentials, ...publicConfig } = input
    const previousHost = row?.draft
      ? smtpPublicConfigSchema.parse(row.draft).host
      : config.mailer.kind === 'smtp' ? config.mailer.host : null
    const previousPort = row?.draft
      ? smtpPublicConfigSchema.parse(row.draft).port
      : config.mailer.kind === 'smtp' ? config.mailer.port : null
    const hasCredentials = row?.draft ? Boolean(row.draftCredentialsCiphertext)
      : config.mailer.kind === 'smtp' && Boolean(config.mailer.user && config.mailer.pass)
    if ((previousHost !== publicConfig.host || previousPort !== publicConfig.port) && hasCredentials && credentials === undefined) {
      throw badRequest('更换 SMTP 主机或端口时，请重新填写账号和密码，或选择免认证中继')
    }
    let ciphertext: string | null = null
    if (credentials !== null) {
      let nextCredentials = credentials
      if (!nextCredentials && row?.draftCredentialsCiphertext) {
        try { nextCredentials = decryptMailCredentials(row.draftCredentialsCiphertext, smtpPublicConfigSchema.parse(row.draft)) }
        catch { throw badRequest('原凭据无法解密，请重新填写账号和密码') }
      } else if (!nextCredentials && !row?.draft && config.mailer.kind === 'smtp' && config.mailer.user && config.mailer.pass) {
        nextCredentials = { user: config.mailer.user, pass: config.mailer.pass }
      }
      if (nextCredentials) {
        if (!config.mailCredentialsEncKey) throw forbidden('服务器尚未配置业务邮件凭据加密密钥')
        ciphertext = encryptMailCredentials(nextCredentials, publicConfig)
      }
    }
    const data = { draft: publicConfig, draftCredentialsCiphertext: ciphertext, testedVersion: null, updatedBy: adminUserId }
    const updated = await tx.mailRuntimeConfig.upsert({
      where: { id: 1 }, create: { id: 1, version: 1, ...data },
      update: { version: { increment: 1 }, ...data },
    })
    await audit(tx, adminUserId, '保存业务邮件草稿', updated.version)
    return publicSettings(updated)
  })
}

export async function testMailDraft(adminUserId: number, input: z.infer<typeof testSchema>) {
  const row = await prisma.mailRuntimeConfig.findUnique({ where: { id: 1 } })
  requireVersion(row, input.expectedVersion)
  if (!row?.draft) throw badRequest('请先保存邮件配置草稿')
  let settings
  try { settings = buildSmtpConfig(smtpPublicConfigSchema.parse(row.draft), row.draftCredentialsCiphertext) }
  catch { throw badRequest('草稿凭据不可用，请重新填写账号和密码') }
  const detail = { version: row.version, recipientMasked: maskRecipientForAudit(input.email) }
  // Audit before external side effects. A concurrent edit invalidates this test.
  await prisma.adminLog.create({ data: {
    adminUserId, action: '测试业务邮件草稿', targetType: 'mailRuntimeConfig', targetId: 1,
    detail: JSON.stringify({ ...detail, phase: 'attempt' }),
  } })
  try {
    await new SmtpMailer(settings).send(renderMail('mail_delivery_test', {
      to: input.email, triggeredAtIso: new Date().toISOString(),
    }))
  } catch (err) {
    const failure = classifyMailTestFailure(err)
    await prisma.adminLog.create({ data: {
      adminUserId, action: '测试业务邮件草稿', targetType: 'mailRuntimeConfig', targetId: 1,
      detail: JSON.stringify({ ...detail, phase: 'failed', failure }),
    } })
    throw new HttpError(502, 'INTERNAL_SERVER_ERROR', `测试邮件发送失败（分类：${failure}）`)
  }
  // Record the delivery even if a concurrent draft edit makes the result stale.
  await prisma.adminLog.create({ data: {
    adminUserId, action: '测试业务邮件草稿', targetType: 'mailRuntimeConfig', targetId: 1,
    detail: JSON.stringify({ ...detail, phase: 'sent' }),
  } })
  return locked(async (tx, latest) => {
    requireVersion(latest, input.expectedVersion)
    const updated = await tx.mailRuntimeConfig.update({ where: { id: 1 }, data: { testedVersion: row.version } })
    return publicSettings(updated)
  })
}

export async function activateMailDraft(adminUserId: number, expectedVersion: number) {
  return locked(async (tx, row) => {
    requireVersion(row, expectedVersion)
    if (!row?.draft || row.testedVersion !== row.version) throw badRequest('请先成功发送当前草稿的测试邮件')
    try { buildSmtpConfig(smtpPublicConfigSchema.parse(row.draft), row.draftCredentialsCiphertext) }
    catch { throw badRequest('草稿凭据不可用，请重新保存并测试') }
    const updated = await tx.mailRuntimeConfig.update({ where: { id: 1 }, data: {
      active: row.draft as Prisma.InputJsonValue, activeCredentialsCiphertext: row.draftCredentialsCiphertext,
      previous: row.active as Prisma.InputJsonValue ?? Prisma.DbNull,
      previousCredentialsCiphertext: row.activeCredentialsCiphertext,
      rollbackAvailable: true, version: { increment: 1 }, activeVersion: { increment: 1 },
      testedVersion: null, updatedBy: adminUserId,
    } })
    await audit(tx, adminUserId, '激活业务邮件配置', updated.version)
    return publicSettings(updated)
  })
}

export async function rollbackMailConfig(adminUserId: number, expectedVersion: number) {
  return locked(async (tx, row) => {
    requireVersion(row, expectedVersion)
    if (!row?.rollbackAvailable) throw badRequest('没有可回滚的邮件配置')
    if (row.previous) {
      try { buildSmtpConfig(smtpPublicConfigSchema.parse(row.previous), row.previousCredentialsCiphertext) }
      catch { throw badRequest('上一版凭据不可用，请恢复对应加密密钥') }
    }
    const updated = await tx.mailRuntimeConfig.update({ where: { id: 1 }, data: {
      active: row.previous as Prisma.InputJsonValue ?? Prisma.DbNull,
      activeCredentialsCiphertext: row.previousCredentialsCiphertext,
      previous: row.active as Prisma.InputJsonValue ?? Prisma.DbNull,
      previousCredentialsCiphertext: row.activeCredentialsCiphertext,
      version: { increment: 1 }, activeVersion: { increment: 1 }, testedVersion: null, updatedBy: adminUserId,
    } })
    await audit(tx, adminUserId, '回滚业务邮件配置', updated.version)
    return publicSettings(updated)
  })
}

/** Mounted after the admin authentication, MFA and settings.manage checks. */
export const mailSettingsRoutes = Router()
mailSettingsRoutes.use('/mail/config', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
mailSettingsRoutes.get('/mail/config', async (_req, res, next) => {
  try { res.json(publicSettings(await prisma.mailRuntimeConfig.findUnique({ where: { id: 1 } }))) } catch (err) { next(err) }
})
mailSettingsRoutes.put('/mail/config', validate(saveSchema), async (req, res, next) => {
  try { res.json(await saveMailDraft(req.user!.userId, req.body)) } catch (err) { next(err) }
})
mailSettingsRoutes.post('/mail/config/test', adminMailTestLimiter, validate(testSchema), async (req, res, next) => {
  try { res.json(await testMailDraft(req.user!.userId, req.body)) } catch (err) { next(err) }
})
mailSettingsRoutes.post('/mail/config/activate', validate(versionBody), async (req, res, next) => {
  try { res.json(await activateMailDraft(req.user!.userId, req.body.expectedVersion)) } catch (err) { next(err) }
})
mailSettingsRoutes.post('/mail/config/rollback', validate(versionBody), async (req, res, next) => {
  try { res.json(await rollbackMailConfig(req.user!.userId, req.body.expectedVersion)) } catch (err) { next(err) }
})
