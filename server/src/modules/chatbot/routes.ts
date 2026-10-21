import { Router } from 'express'
import { requireBotSignature } from './middleware.js'
import * as botService from './service.js'
import * as pointService from '../points/service.js'
import { checkinForBot } from './checkinBridge.js'
import { searchProducts, productDetail } from './catalog.js'
import { resolveBotProductAudience } from './audience.js'
import { config } from '../../config/index.js'
import { consumeChatUnchecked } from './abusePolicy.js'
import { businessDateString as shanghaiToday } from '../../lib/businessTime.js'

/**
 * SPEC-CHAT-BOT-001 — 机器人专用接口。
 *
 * 与 /api/points 的区别：
 * - 鉴权走 HMAC 共享密钥，不是用户 JWT（机器人不能持有用户凭证）
 * - 身份由 platformId 反查绑定表得到，请求体不携带 userId
 *   （若允许传 userId，就等于给机器人开了任意用户冒用通道）
 * - 权限面只覆盖：绑定、解绑、签到、查询、催签名单
 */

const router = Router()

router.use(requireBotSignature)

/**
 * 绑定第一步：向指定邮箱发验证码。
 * 无论邮箱是否存在都返回同一结果，避免成为账号枚举器。
 */
router.post('/bind/request', async (req, res, next) => {
  try {
    const { platform = 'qq', platformId, email } = req.body ?? {}
    const result = await botService.requestBind({ platform, platformId, email })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/** 绑定第二步：校验验证码并建立绑定。 */
router.post('/bind/confirm', async (req, res, next) => {
  try {
    const { platform = 'qq', platformId, code } = req.body ?? {}
    const result = await botService.confirmBind({ platform, platformId, code })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/** 解绑 */
router.post('/unbind', async (req, res, next) => {
  try {
    const { platform = 'qq', platformId } = req.body ?? {}
    const userId = await botService.resolveUserByPlatformId(platform, platformId)
    if (!userId) {
      res.json({ unbound: false, reason: 'not_bound' })
      return
    }
    const result = await botService.unbind(userId, platform)
    res.json({ unbound: true, ...result })
  } catch (err) {
    next(err)
  }
})

/** 签到。幂等由 checkinRecord 唯一约束保证：重复调用返回 alreadyCheckedIn */
router.post('/checkin', async (req, res, next) => {
  try {
    const { platform = 'qq', platformId } = req.body ?? {}
    const userId = await botService.resolveUserByPlatformId(platform, platformId)
    if (!userId) {
      res.json({ bound: false })
      return
    }
    const result = await checkinForBot(userId, platform)
    res.json({ bound: true, ...result })
  } catch (err) {
    next(err)
  }
})

/** 查询积分 + 等级 + 今日签到状态（一次往返拿全） */
router.post('/profile', async (req, res, next) => {
  try {
    const { platform = 'qq', platformId } = req.body ?? {}
    const userId = await botService.resolveUserByPlatformId(platform, platformId)
    if (!userId) {
      res.json({ bound: false })
      return
    }

    const [summary, checkedIn] = await Promise.all([
      pointService.getAccountSummary(userId),
      pointService.hasCheckedInToday(userId),
    ])

    res.json({
      bound: true,
      userId,
      balance: summary.balance,
      frozenBalance: summary.frozenBalance,
      checkedInToday: checkedIn,
      tier: summary.tier,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 定时催签名单：返回今天未签到的已绑定用户。
 * 机器人侧按返回的 platformId 逐个私聊，不在这里发送（服务端不直连 QQ）。
 *
 * ⚠️ 只返回 platformId。催签只需要「发给谁」；userId / nickname 对该功能
 * 无用，却会把 QQ号↔账号ID↔昵称 的对应表暴露在批量接口上，故已收窄。
 */
router.post('/unchecked', async (req, res, next) => {
  try {
    const { platform = 'qq', date } = req.body ?? {}
    const dateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : shanghaiToday()
    // 限流：该接口是本通道唯一的批量数据出口，正常调度每天只调一两次。
    // 被拒时回 429（而非静默）——调用方是受信机器人，不是攻击者的探测请求，
    // 它能看懂这个信号并说明原因，不需要对它隐藏什么。
    const gate = await consumeChatUnchecked({ platform })
    if (!gate.allowed) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `拉取过于频繁，请 ${gate.retryAfterSeconds}s 后重试` },
      })
      return
    }
    const rows = await botService.listUncheckedBoundUsers(platform, dateStr)
    res.json({
      date: dateStr,
      count: rows.length,
      users: rows.map(r => ({ platformId: r.platformId })),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 商品搜索（只读）。
 *
 * ⚠️ 这里**不再**是「任何人都能查全部商品」。请求体可携带 platform /
 * platformId / conversationType（private | group）；服务端据此判定视角
 * （见 audience.ts）：
 *
 *   私聊 + 已绑定 + 账号正常 → member
 *   缺字段 / 未知会话类型 / 群聊 / 未绑定 / 账号异常 → guest
 *
 * 缺字段走 guest 是刻意的默认：旧客户端不发这些字段，不能因此被当成
 * 已绑定用户。新字段无需改签名逻辑——HMAC 已对整个 body + _path 签名
 * （middleware.ts），篡改 conversationType 会直接校验失败。
 */
router.post('/products/search', async (req, res, next) => {
  try {
    const { keyword, page, cursor, platform, platformId, conversationType } = req.body ?? {}
    const audience = await resolveBotProductAudience({ platform, platformId, conversationType })
    const result = await searchProducts({
      keyword,
      page,
      cursor,
      baseUrl: config.appBaseUrl,
      audience,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * 商品详情（只读）。
 *
 * 身份与视角规则同搜索。三种可区分结果：
 *
 *   found          —— 200 { found: true, product }
 *   not_found      —— 200 { found: false }（不存在/已归档/商家停用/草稿）
 *   login_required —— 200 { found: false, loginRequired: true }
 *
 * `getProductDetail` 对不存在/不可见商品**抛 404**（不是返回 null），
 * 对「存在但仅登录可见」抛 403 PRODUCT_LOGIN_REQUIRED。机器人需要的是
 * 可预期结果而非异常，故两者都在这里收敛。
 *
 * login_required 的响应**不得包含任何商品字段**（ID、名称、价格、库存、
 * 商家、分类、图片、描述一律没有）。它不是「查无此物」——用户拿的编号
 * 是真实存在的商品，说成不存在会让他在群里被误导着反复重试；
 * 它也不是信息出口——只回答「需登录后查看」。
 *
 * 其余错误（其他 403、500、DB 故障）继续 next(err)，不伪装成查无商品。
 */
router.post('/products/detail', async (req, res, next) => {
  try {
    const { productId, platform, platformId, conversationType } = req.body ?? {}
    const audience = await resolveBotProductAudience({ platform, platformId, conversationType })
    const result = await productDetail({
      id: productId,
      baseUrl: config.appBaseUrl,
      audience,
    })
    switch (result.kind) {
      case 'found':
        res.json({ found: true, product: result.product })
        return
      case 'login_required':
        res.json({ found: false, loginRequired: true })
        return
      default:
        res.json({ found: false })
    }
  } catch (err) {
    next(err)
  }
})

export { router as chatBotRoutes }
