import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config/index.js'

/**
 * P7b：商家 webhook 签名密钥的静态加密（AES-256-GCM）。
 *
 * 硬规则（设计 §3.2 / 硬验收 ⑤）：
 * - 密文落库（MerchantWebhookConfig.secretCiphertext），明文只在创建/再生
 *   响应中一次性返回，不提供普通读取——常规序列化只回尾 4 位。
 * - 加密密钥来自 env WEBHOOK_SECRET_ENC_KEY（64 hex = 32 字节，config 层
 *   生产必配、格式校验）；dev/test 缺省时由 JWT_SECRET 派生，仅为免配置，
 *   不构成生产姿态。
 * - 密文格式 `v1:<iv>:<tag>:<ct>`（hex）——前缀版本化，未来换算法可平滑
 *   迁移；GCM 认证标签保证密文被篡改时解密响亮失败而不是回出垃圾。
 */

const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

function encryptionKey(): Buffer {
  if (config.webhookSecretEncKey) return Buffer.from(config.webhookSecretEncKey, 'hex')
  // dev/test 派生键：确定性（同一 JWT_SECRET 可解回），与任何正式密钥无关。
  return createHash('sha256').update(`webhook-secret-enc:${config.jwtSecret}`).digest()
}

/** 生成新的商家签名密钥：32 字节随机 → 64 hex 字符。 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

export function encryptWebhookSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

export function decryptWebhookSecret(ciphertext: string): string {
  const [version, ivHex, tagHex, ctHex] = ciphertext.split(':')
  if (version !== 'v1' || !ivHex || !tagHex || !ctHex) {
    throw new Error('webhook secret ciphertext format invalid')
  }
  const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
}

/** 常规展示形态：仅尾 4 位（配置页回显用），绝不回明文。 */
export function maskWebhookSecret(plaintextOrLast4: string): string {
  return `****${plaintextOrLast4.slice(-4)}`
}
