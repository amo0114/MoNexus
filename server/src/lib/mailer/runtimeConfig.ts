import type { MailRuntimeConfig } from '@prisma/client'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config, formatSmtpFromHeader } from '../../config/index.js'
import { prisma } from '../prisma.js'
import { HttpError } from '../httpError.js'

const singleLine = z.string().trim().refine(value => !/[\r\n\0]/.test(value), '不能包含换行或空字符')
export const smtpPublicConfigSchema = z.object({
  host: singleLine.pipe(z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, '请填写 SMTP 主机名或 IPv4 地址')),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  from: singleLine.pipe(z.string().email().max(254)),
  fromName: singleLine.pipe(z.string().max(100)),
}).strict()
export const smtpCredentialsSchema = z.object({
  user: singleLine.pipe(z.string().min(1).max(320)),
  pass: z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value), '密码格式不正确'),
}).strict()
export type SmtpPublicConfig = z.infer<typeof smtpPublicConfigSchema>
export type SmtpCredentials = z.infer<typeof smtpCredentialsSchema>
function credentialAad(settings: SmtpPublicConfig) {
  return Buffer.from(JSON.stringify(['monexus:smtp-credentials:v1', settings.host, settings.port, settings.secure, settings.from, settings.fromName]))
}

export function encryptMailCredentials(credentials: SmtpCredentials, settings: SmtpPublicConfig): string {
  if (!config.mailCredentialsEncKey) throw new Error('Mail credential encryption unavailable')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.mailCredentialsEncKey, 'hex'), iv)
  cipher.setAAD(credentialAad(settings))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()])
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':')
}

export function decryptMailCredentials(value: string, settings: SmtpPublicConfig): SmtpCredentials {
  if (!/^v1:[a-f0-9]{24}:[a-f0-9]{32}:(?:[a-f0-9]{2})+$/.test(value)) throw new Error('Mail credential ciphertext invalid')
  const [, iv, tag, ciphertext] = value.split(':')
  for (const key of [config.mailCredentialsEncKey, config.mailCredentialsEncKeyPrevious]) {
    if (!key) continue
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
      decipher.setAAD(credentialAad(settings))
      decipher.setAuthTag(Buffer.from(tag, 'hex'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString('utf8')
      return smtpCredentialsSchema.parse(JSON.parse(plaintext))
    } catch { /* Try the previous key during a controlled rotation. */ }
  }
  throw new Error('Mail credentials unavailable')
}

export function buildSmtpConfig(publicConfig: SmtpPublicConfig, ciphertext: string | null) {
  const credentials = ciphertext ? decryptMailCredentials(ciphertext, publicConfig) : null
  return {
    kind: 'smtp' as const,
    host: publicConfig.host, port: publicConfig.port, secure: publicConfig.secure,
    from: formatSmtpFromHeader(publicConfig.from, publicConfig.fromName),
    displayFrom: publicConfig.from,
    user: credentials?.user, pass: credentials?.pass,
  }
}

export function resolveMailRuntimeConfig(row: MailRuntimeConfig | null) {
  if (!row?.active) return { mailer: config.mailer, source: 'environment' as const, version: row?.activeVersion ?? 0 }
  try {
    return {
      mailer: buildSmtpConfig(smtpPublicConfigSchema.parse(row.active), row.activeCredentialsCiphertext),
      source: 'database' as const, version: row.activeVersion,
    }
  } catch {
    // Never silently send through an old env account after a failed decrypt.
    throw new HttpError(503, 'INTERNAL_SERVER_ERROR', '业务邮件配置不可用，请检查凭据加密密钥')
  }
}

/** No process cache: a committed activation applies to the next send on all instances. */
export async function getMailRuntimeConfig() {
  return resolveMailRuntimeConfig(await prisma.mailRuntimeConfig.findUnique({ where: { id: 1 } }))
}
