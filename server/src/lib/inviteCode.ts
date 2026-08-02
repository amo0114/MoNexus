import crypto from 'crypto'

/**
 * SPEC-INVITE-001 IV-01：邀请码格式与生成。
 *
 * 生成字母表剔除 I/O/0/1（人工抄写歧义字符），恰 32 个字符——256 % 32 === 0，
 * 按字节取模没有取模偏差，无需拒绝采样。存储与匹配则接受完整 `[A-Z0-9]`：
 * 归一化只做 trim + 大写，字母表约束只作用于生成侧。
 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 8

const INVITE_CODE_PATTERN = /^[A-Z0-9]{8}$/

/** CSPRNG 生成一枚 8 位大写短码（唯一性由数据库唯一约束 + 撞库重试兜底）。 */
export function generateInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH)
  let code = ''
  for (const byte of bytes) {
    code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length]
  }
  return code
}

/**
 * 输入归一化：trim + 大写后必须恰为 8 位 `[A-Z0-9]`，否则返回 null。
 * 空串 / 非字符串一律 null——调用方据此区分「没带码」与「带了坏码」。
 */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toUpperCase()
  return INVITE_CODE_PATTERN.test(normalized) ? normalized : null
}
