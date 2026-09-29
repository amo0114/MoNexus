import { Router } from 'express'
import { requireBotSignature } from './middleware.js'
import * as botService from './service.js'
import * as pointService from '../points/service.js'
import { checkinForBot } from './checkinBridge.js'
import { searchProducts, productDetail } from './catalog.js'
import { config } from '../../config/index.js'
import { HttpError } from '../../lib/httpError.js'

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
 */
router.post('/unchecked', async (req, res, next) => {
  try {
    const { platform = 'qq', date } = req.body ?? {}
    const dateStr = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : shanghaiToday()
    const rows = await botService.listUncheckedBoundUsers(platform, dateStr)
    res.json({
      date: dateStr,
      count: rows.length,
      users: rows.map(r => ({
        platformId: r.platformId,
        userId: r.userId,
        nickname: r.user.nickname,
      })),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * 商品搜索（只读）。关键词为空时返回默认列表，与网站首页口径一致。
 *
 * 该接口不需要绑定，任何人都能查——商品本身对访客可见，加绑定门槛只会
 * 让「先看看有什么」的新用户卡在第一步。
 */
router.post('/products/search', async (req, res, next) => {
  try {
    const { keyword, page } = req.body ?? {}
    const result = await searchProducts({
      keyword,
      page,
      baseUrl: config.appBaseUrl,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

/**
 * 商品详情（只读，guest 视角）。
 *
 * 注意 `getProductDetail` 对不存在/不可见的商品**抛 404**（不是返回 null），
 * 这是它与 listProducts 的契约差异。机器人需要的是「查无此物」这种可预期
 * 结果而非异常——用户手抖打错编号不该收到「服务异常」。这里把 404 收敛成
 * `found: false`，其余错误照常上抛。
 */
router.post('/products/detail', async (req, res, next) => {
  try {
    const { productId } = req.body ?? {}
    const result = await productDetail({ id: productId, baseUrl: config.appBaseUrl })
    if (!result) {
      res.json({ found: false })
      return
    }
    res.json({ found: true, product: result })
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      res.json({ found: false })
      return
    }
    next(err)
  }
})

function shanghaiToday() {
  const now = new Date()
  const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit' })
  const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', day: '2-digit' })
  return `${yyyy}-${mm}-${dd}`
}

export { router as chatBotRoutes }
