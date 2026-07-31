import { z } from 'zod'

/**
 * 邮箱规范形：trim → 校验 → 长度上限 → lowercase。
 *
 * 顺序是语义的一部分：先 trim 再校验，"  a@b.com " 才不会因为空白被判非法；
 * lowercase 放在最后，保证 parse 幂等（parse(parse(x)) === parse(x)），这样
 * 收件人脱敏、审计与实际投递地址三者永远同形。255 是 RFC 5321 的地址上限。
 */
export const normalizedEmailSchema = z
  .string()
  .trim()
  .email('请输入有效的邮箱地址')
  .max(255, '邮箱地址过长')
  .toLowerCase()

/**
 * 审计/公开展示用的收件人脱敏。行为与原 reviews service 实现逐字节一致
 * （本地部分保留 1–2 位），改动会同时影响评价区展示名与邮件审计记录。
 */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  const keep = local.length <= 2 ? 1 : 2
  return `${local.slice(0, keep)}***@${domain}`
}
