import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../config/index.js'

export const TOKEN_TTL_SECONDS = 2 * 60 * 60
const itemSchema = z.object({
  id: z.number().int().positive(), pos: z.number().int().min(1).max(6),
  tier: z.number().int().min(1).max(3), same: z.boolean(), platform: z.boolean(),
}).strict()
const tokenSchema = z.object({
  v: z.literal(1), listId: z.string().uuid(), src: z.number().int().positive(),
  sv: z.literal('pdp-rec-v1'), aud: z.enum(['guest', 'member']),
  iat: z.number().int().nonnegative(), items: z.array(itemSchema).min(1).max(6),
}).strict()
export type RecommendationList = z.infer<typeof tokenSchema>
export type ListItem = z.infer<typeof itemSchema>
export type DropReason = 'disabled' | 'invalid' | 'expired' | 'not_listed'

export function signRecommendationList(
  sourceProductId: number, audience: 'guest' | 'member', items: ListItem[],
  key = config.recommendationEventHmacKey, now = new Date(),
): string | undefined {
  if (!key || !items.length) return undefined
  const payload = Buffer.from(JSON.stringify({
    v: 1, listId: randomUUID(), src: sourceProductId, sv: 'pdp-rec-v1', aud: audience,
    iat: Math.floor(now.getTime() / 1000), items,
  })).toString('base64url')
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}

export function verifyRecommendationList(
  token: string, key = config.recommendationEventHmacKey, now = new Date(),
): { list: RecommendationList } | { reason: DropReason } {
  if (!key) return { reason: 'disabled' }
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined || !/^[\w-]+$/.test(signature)) return { reason: 'invalid' }
  const expected = createHmac('sha256', key).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return { reason: 'invalid' }
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return { reason: 'invalid' } }
  const parsed = tokenSchema.safeParse(decoded)
  if (!parsed.success) return { reason: 'invalid' }
  const age = Math.floor(now.getTime() / 1000) - parsed.data.iat
  if (age < 0 || age > TOKEN_TTL_SECONDS) return { reason: 'expired' }
  return { list: parsed.data }
}
