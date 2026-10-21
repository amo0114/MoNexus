import { prisma } from '../../lib/prisma.js'
import { resolveUserByPlatformId } from './service.js'
import type { ProductAudience } from '../products/visibility.js'

/**
 * SPEC-CHAT-BOT-001 / BOT-1b —— 机器人商品查询的视角判定。
 *
 * 背景：HMAC 只证明「请求来自受信机器人服务」，不证明「发送者是谁」。
 * 旧实现在 catalog.ts 固定用 member 视角，等于把 members_only 商品的
 * 名称/价格/库存/商家/分类/描述泄露给任何能敲 `/搜索` 的 QQ 用户，
 * 包括整个群。本文件把「请求者身份」变成决定视角的唯一依据。
 *
 * 判定规则（与 docs/specs/product-guest-visibility-ai-moderation.md §5.1 一致）：
 *
 *   private + 有 platformId + 已绑定 + 账号 status === '正常'  → member
 *   其余全部                                                     → guest
 *
 * 「其余」包括：缺 platformId、缺/未知 conversationType、group、未绑定、
 * 账号已封禁/停用/删除。**未知会话类型不默认 private**——默认值必须是
 * 权限最小的那一侧，否则客户端一升级就会静默放行群内查询。
 *
 * 故障语义：绑定查询或用户查询抛错时**原样上抛**，不降级为 member，
 * 也不吞成「未找到」。降级为 member 等于把一次数据库抖动变成权限提升；
 * 吞成未找到则会让「服务故障」看起来像「你没有权限」，两者都不可接受。
 */

export type BotConversationType = 'private' | 'group'

/** 只有这两个字面量算已知会话类型；其余（含 undefined / null / 大小写变体）→ guest。 */
function normalizeConversationType(raw: unknown): BotConversationType | null {
  return raw === 'private' || raw === 'group' ? raw : null
}

/** 账号可用的唯一状态值（与 User.status 默认值、auth 既有判定一致）。 */
const ACTIVE_USER_STATUS = '正常'

/**
 * 由请求体字段解析商品视角。该函数是**唯一**的视角来源，
 * 调用方不得自行接受请求体里的 audience 字段（那样等于让调用方自封权限）。
 */
export async function resolveBotProductAudience(params: {
  platform?: unknown
  platformId?: unknown
  conversationType?: unknown
}): Promise<ProductAudience> {
  // 群聊一律 guest。即使发送者已绑定，群回复的可见范围是整个群，
  // 不能把「请求者已绑定」当成「群成员都有权看」。转私聊是 BOT-2 的范围。
  if (normalizeConversationType(params.conversationType) !== 'private') return 'guest'

  const platformId = String(params.platformId ?? '').trim()
  if (!platformId) return 'guest'

  // 平台标识缺省为 qq：既有的 /profile、/签到 等接口都是 `platform = 'qq'` 的
  // 默认约定，保持同一口径；但 platformId 必须真实存在，不接受空串。
  const platform = String(params.platform ?? 'qq').trim() || 'qq'

  // 绑定查询抛错（DB 不可用、表结构异常）→ 上抛，走原错误流程。
  const userId = await resolveUserByPlatformId(platform, platformId)
  if (!userId) return 'guest'

  // 用户查询抛错同样上抛。这里只查状态，不额外取资料——
  // 视角判定只需要「账号是否正常」这一个比特。
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  })
  if (!user) return 'guest'

  return user.status === ACTIVE_USER_STATUS ? 'member' : 'guest'
}
