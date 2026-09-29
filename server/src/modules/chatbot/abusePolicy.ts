import {
  consumeAbusePolicy,
  type AbusePolicyUse,
} from '../auth/abusePolicy.js'
import type { AbuseLimiter, AbuseLimiterBucket, AbuseLimiterResult } from '../../lib/abuseLimiter.js'

/**
 * SPEC-CHAT-BOT-001 —— 机器人绑定接口的滥用防护。
 *
 * 为什么必须限流：`/api/bot/bind/request` 在没有限流时是一个开放的邮件触发
 * 接口——任何知道某个邮箱的人都能反复触发向该邮箱发信，既骚扰用户，也消耗
 * SMTP 配额并损害发件域信誉。
 *
 * 为什么不能用 IP 维度：机器人侧的全部请求都来自同一台 AstrBot 主机，`req.ip`
 * 对所有请求相同，IP 维度在这里毫无区分度。必须按「哪个平台账号在刷」与
 * 「在刷哪个邮箱」两个维度计数，因此引入了 `platform` 维度。
 *
 * 阈值与既有邮箱验证流程（VERIFICATION_EMAIL_*）保持一致，避免同一个用户
 * 在网站与机器人两侧得到不同的冷却体验。
 */

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 单平台账号维度：防一个 QQ 连续换不同邮箱刷。
 * 3 次/分钟足够覆盖「没收到，再试一次」的正常重发，10 次/天堵住批量遍历。
 */
export const CHAT_BIND_PLATFORM_BUCKETS = [
  { flow: 'chat-bind', dimension: 'platform', limit: 3, windowMs: MINUTE_MS },
  { flow: 'chat-bind', dimension: 'platform', limit: 10, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

/**
 * 目标邮箱维度：防对单一邮箱轰炸。
 * 1 次/分钟与既有验证邮件冷却一致；5 次/天够正常重发，不足以用于骚扰。
 */
export const CHAT_BIND_EMAIL_BUCKETS = [
  { flow: 'chat-bind', dimension: 'email', limit: 1, windowMs: MINUTE_MS },
  { flow: 'chat-bind', dimension: 'email', limit: 5, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

/** 确认阶段的错码尝试：防 6 位码被枚举（限次在行上另有一层，这里是第二道）。 */
export const CHAT_BIND_CONFIRM_BUCKETS = [
  { flow: 'chat-confirm', dimension: 'platform', limit: 10, windowMs: MINUTE_MS },
  { flow: 'chat-confirm', dimension: 'platform', limit: 50, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

/**
 * 催签名单拉取的限流。
 *
 * 该接口返回全量未签到用户的 platformId，是本通道里唯一的批量数据出口。
 * 正常情况下每天只需调用一两次（定时任务）；给一个宽松但有限的上限，
 * 既不干扰正常调度，也让密钥泄露后的批量爬取变得低效。
 *
 * 这里没有可用的「调用者」标识（服务端不知道是哪台机器人），因此按平台
 * 维度计数——同一平台的所有拉取共享一个配额。
 */
export const CHAT_UNCHECKED_BUCKETS = [
  { flow: 'chat-unchecked', dimension: 'platform', limit: 6, windowMs: HOUR_MS },
  { flow: 'chat-unchecked', dimension: 'platform', limit: 24, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

function withSubject(
  buckets: readonly AbuseLimiterBucket[],
  subject: string | number,
): AbusePolicyUse[] {
  return buckets.map(bucket => ({ bucket, subject }))
}

/** 平台维度的复合主体：`<platform>:<platformId>`，如 `qq:430386193`。 */
export function platformSubject(platform: string, platformId: string): string {
  return `${platform}:${platformId}`
}

export function consumeChatBindRequest(
  input: { platform: string; platformId: string; email: string },
  limiter?: AbuseLimiter,
): Promise<AbuseLimiterResult> {
  return consumeAbusePolicy(
    [
      ...withSubject(CHAT_BIND_PLATFORM_BUCKETS, platformSubject(input.platform, input.platformId)),
      ...withSubject(CHAT_BIND_EMAIL_BUCKETS, input.email),
    ],
    limiter,
  )
}

export function consumeChatBindConfirm(
  input: { platform: string; platformId: string },
  limiter?: AbuseLimiter,
): Promise<AbuseLimiterResult> {
  return consumeAbusePolicy(
    withSubject(CHAT_BIND_CONFIRM_BUCKETS, platformSubject(input.platform, input.platformId)),
    limiter,
  )
}

/** 催签名单拉取。按平台计数——调用者身份对服务端不可见。 */
export function consumeChatUnchecked(
  input: { platform: string },
  limiter?: AbuseLimiter,
): Promise<AbuseLimiterResult> {
  return consumeAbusePolicy(
    withSubject(CHAT_UNCHECKED_BUCKETS, `${input.platform}:unchecked`),
    limiter,
  )
}
