import { randomInt } from 'node:crypto'

// v1 词表及顺序固定：空昵称的 ID 映射与迁移使用相同版本，不能随意重排。
const PREFIXES = [
  '爱喝茶的', '追风的', '爱晒太阳的', '慢悠悠的',
  '爱吃桃的', '听雨的', '踏月的', '爱看云的',
  '捧着西瓜的', '悠闲的', '爱讲故事的', '正在摸鱼的',
  '打着盹的', '笑眯眯的', '爱种花的', '乘风的',
  '爱散步的', '抱着锦囊的', '爱写诗的', '等东风的',
  '早起的', '爱赏月的', '爱下棋的', '路过的',
  '背着行囊的', '爱吃面的', '数星星的', '摇着羽扇的',
  '爱听琴的', '看热闹的', '爱游山的', '满载而归的',
] as const
const ROLES = [
  '小军师', '桃园客', '小都督', '卧龙学徒',
  '赤壁钓客', '江东旅人', '蜀中闲客', '锦囊匠',
  '竹林客', '云游书生', '青梅居士', '羽扇先生',
  '白马骑手', '星河剑客', '麦田守望者', '铜雀诗人',
  '东风信使', '山野琴师', '小先锋', '行路人',
  '桃花剑客', '煮茶先生', '观星客', '江畔渔夫',
  '小谋士', '听雨书生', '月下旅人', '青山隐士',
  '洛阳食客', '成都茶客', '石桥棋友', '草庐主人',
] as const

/** 注册时生成并持久化；昵称允许重名，不作为账号标识。 */
export function generateDefaultNickname(): string {
  return `${PREFIXES[randomInt(PREFIXES.length)]}${ROLES[randomInt(ROLES.length)]}`
}

/** 为未持久化昵称的账号提供稳定回退；不使用邮箱或可变的个人资料。 */
export function defaultNicknameForUser(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('INVALID_USER_ID')
  const slot = Number((BigInt(userId - 1) * 37n) % BigInt(PREFIXES.length * ROLES.length))
  return `${PREFIXES[slot % PREFIXES.length]}${ROLES[Math.floor(slot / PREFIXES.length)]}`
}

/** 已保存的昵称始终优先；旧 mn_ 格式只在一次性迁移中处理。 */
export function resolveUserNickname(user: { id: number; nickname: string | null }): string {
  return user.nickname?.trim() || defaultNicknameForUser(user.id)
}

/** Validate user-chosen nickname (1–20 chars after trim). */
export function normalizeUserNickname(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const t = String(raw).trim()
  if (!t) return null
  if (t.length > 20) {
    throw new Error('NICKNAME_TOO_LONG')
  }
  // Disallow control chars / pure whitespace already trimmed
  if (/[\u0000-\u001f\u007f]/.test(t)) {
    throw new Error('NICKNAME_INVALID')
  }
  return t
}
