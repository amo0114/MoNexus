import { randomUUID } from 'node:crypto'
import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { HttpError } from '../../lib/httpError.js'
import { getMailer } from '../../lib/mailer/index.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { decryptWebhookSecret } from '../../lib/webhookSecret.js'
import {
  callWebhook,
  classifyWebhookFailure,
  signWebhookPayload,
  WEBHOOK_TIMEOUT_MS,
} from '../../lib/outboundWebhook.js'
import { normalizeOrderStatus, transitionOrderStatus } from './fulfillment.js'

/**
 * P7b：自动开通任务执行 cron（设计 §3.4，硬验收 ⑥⑧⑨）。
 *
 * 硬规则：
 * - **不接 CronLease**：工作认领由 `FOR UPDATE SKIP LOCKED` 天然分配，多实例
 *   并行安全且加速。
 * - 认领谓词：pending + nextAttemptAt 到期 + **leaseUntil 未持有**（硬验收 ⑨：
 *   排除未过期租约——HTTP 在途的任务绝不被二次认领）。
 * - 每轮认领 ≤ CLAIM_BATCH_LIMIT，外呼并发 ≤ OUTBOUND_CONCURRENCY（硬验收 ⑥）。
 * - 认领事务：先锁任务行，复查订单与配置（终态/退款 → cancelled；配置已
 *   revoked / 次数耗尽 → degraded 兜底——轮换时已批量降级，这里挡竞态）；
 *   订单仍 pending 时由 system CAS 转 processing（硬验收 ⑧）；attempts+1 并
 *   **预写**退避 nextAttemptAt（进程崩溃自然落入下轮重试，无紧循环）。
 * - `autoProvisionMaxAttempts = 0` = 运维刹车：整轮直接跳过——不认领、
 *   不外呼、不转状态（硬验收 ⑧）。
 * - HTTP 调用**全程在事务外**（硬验收 ⑨）；协议 = 至少一次外呼，接收端以
 *   taskId 幂等去重。
 * - **dispatch 前生命周期 gate（复审 P1）**：外呼前以 `FOR SHARE OF config`
 *   复查任务仍 pending 且配置仍 active。该锁与轮换/撤销的 FOR UPDATE 互斥，
 *   构成**不可逆 dispatch 的线性化点**：撤销先于 gate 提交 → gate 必见
 *   revoked（含锁等待后的重读），任务降级、callWebhook **绝不被调用**——
 *   买家表单答案不外发；gate 先通过 → 本次外呼不可逆（视为在配置有效期内
 *   合法发起），其后才提交的撤销只影响交付结果（结果 CAS 丢弃/降级），不
 *   追回已发出的请求。认领事务里的配置检查只是批量快速路径，安全边界是
 *   这里的 gate。
 * - 结果落库：任务侧 `id + leaseToken + status='pending'` 三条件 CAS 先行
 *   （同时给结果事务定下「任务行 → 订单行」的锁序，与认领事务一致，
 *   规避两条 provision 路径交叉死锁）；过期 worker 的迟到结果被丢弃。
 *   成功 = 复用 transitionOrderStatus 的交付写入（DeliveryRecord + 订阅
 *   expiresAt + 事件，结算/验收链路全自动继承）；订单已被手工交付/退款 →
 *   任务置 cancelled，绝不重复交付。
 * - 降级邮件（复审 R3）：**SMTP 绝不进事务**——单语句 CAS 租约认领(复用
 *   degraded 终态下闲置的 leaseToken/leaseUntil 列) → 事务外发送 → 按
 *   token CAS 落 merchantNotifiedAt。语义 = **至少一次邮件**（发送已被
 *   接收但标记前崩溃 → 租约到期重发）；失败定向释放租约下轮重试
 *   （P5.5 教训：陈旧状态不得挡重试）。轮换批量降级的任务同样由此通知。
 * - lastError 只存脱敏诊断码，绝不存远端响应体。
 */

const PROVISION_INTERVAL_MS = 60_000
// 硬验收 ⑥：每轮认领量与外呼并发上限。
const CLAIM_BATCH_LIMIT = 20
const OUTBOUND_CONCURRENCY = 4
// 退避档（秒）：第 n 次失败后，下次尝试在 DELAYS[min(n-1, 4)] 之后。
const RETRY_DELAYS_SEC = [60, 300, 900, 3600, 21600]
// 任务租约 = 外呼超时 + 结果落库余量；到期未落结果即可被重新认领。
const LEASE_MS = WEBHOOK_TIMEOUT_MS + 20_000
const CONTENT_MAX_CHARS = 5000

interface ClaimedWork {
  taskId: number
  orderId: number
  webhookConfigId: number
  attempt: number
  maxAttempts: number
  leaseToken: string
  url: string
  secret: string
  rawBody: string
}

interface ClaimOutcome {
  work: ClaimedWork | null
  /** false = 队列已空，停止本轮继续认领。 */
  more: boolean
}

async function claimNextTask(maxAttempts: number, now: Date): Promise<ClaimOutcome> {
  return prisma.$transaction(async tx => {
    // 时间比较的时区陷阱(P6 时区约定的 raw-SQL 变体):Prisma 模型层把
    // DateTime 以 **UTC 裸值** 写入无时区的 timestamp 列(如 update 写的
    // nextAttemptAt/leaseUntil)。裸值直接和 `now()` 或绑定的 `${now}` 比较时,
    // Postgres 按会话时区(本机 +08)解释该裸值,把未来时刻整体偏移 ~8h 到
    // 过去——击穿退避与租约排除,导致同一任务一轮内被反复认领。必须用
    // `列 AT TIME ZONE 'UTC'` 把裸值重新按 UTC 解释成真实时刻,再与 `${now}`
    // (正确时刻的 timestamptz)比较。经真实模型写入路径实测验证。
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "ProvisionTask"
      WHERE "status" = 'pending'
        AND ("nextAttemptAt" AT TIME ZONE 'UTC') <= ${now}
        AND ("leaseUntil" IS NULL OR ("leaseUntil" AT TIME ZONE 'UTC') <= ${now})
      ORDER BY "nextAttemptAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`
    if (rows.length === 0) return { work: null, more: false }

    const task = await tx.provisionTask.findUniqueOrThrow({
      where: { id: rows[0].id },
      include: {
        webhookConfig: { select: { url: true, secretCiphertext: true, status: true } },
        order: {
          select: {
            id: true,
            status: true,
            price: true,
            productNameSnapshot: true,
            offerNameSnapshot: true,
            purchaseFormAnswers: true,
            bookingDate: true,
            product: { select: { name: true } },
            offer: { select: { name: true } },
          },
        },
      },
    })

    // 订单复查：只有 pending/processing 的人工单还有自动开通的意义。
    // 退款/关闭/争议/已交付（商家抢先手工交付）一律取消，绝不重复交付。
    const orderStatus = normalizeOrderStatus(task.order.status)
    if (orderStatus !== 'pending' && orderStatus !== 'processing') {
      await tx.provisionTask.update({
        where: { id: task.id },
        data: { status: 'cancelled', leaseUntil: null },
      })
      return { work: null, more: true }
    }
    // 配置已撤销：轮换/撤销时已批量降级，这里兜住并发窗口（硬验收 ⑤：
    // 任务绝不解析到新配置——引用行 revoked 即降级转人工）。
    if (task.webhookConfig.status !== 'active') {
      await tx.provisionTask.update({
        where: { id: task.id },
        data: { status: 'degraded', leaseUntil: null, lastError: 'config_revoked' },
      })
      return { work: null, more: true }
    }
    // 次数耗尽兜底（正常路径在失败结果事务里降级）。
    if (task.attempts >= maxAttempts) {
      await tx.provisionTask.update({
        where: { id: task.id },
        data: { status: 'degraded', leaseUntil: null },
      })
      return { work: null, more: true }
    }

    // 硬验收 ⑧：首次真实认领时由 system 启动履约（商家已手动接单则跳过）。
    if (orderStatus === 'pending') {
      await transitionOrderStatus({
        orderId: task.order.id,
        toStatus: 'processing',
        actorRole: 'system',
        action: 'system.auto_provision.start',
        publicNote: '自动开通处理中',
      }, tx)
    }

    const attempt = task.attempts + 1
    const leaseToken = randomUUID()
    await tx.provisionTask.update({
      where: { id: task.id },
      data: {
        attempts: attempt,
        nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_SEC[Math.min(attempt - 1, RETRY_DELAYS_SEC.length - 1)] * 1000),
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    })

    // 载荷：商家履约本就可见的字段（快照优先），外加协议字段。买家账号
    // 邮箱等身份信息不外发——商家需要联系方式应通过购买前表单收集。
    const payload = {
      taskId: task.id,
      attempt,
      timestamp: Math.floor(now.getTime() / 1000),
      orderId: task.order.id,
      productName: task.order.productNameSnapshot ?? task.order.product.name,
      offerName: task.order.offerNameSnapshot ?? task.order.offer?.name ?? null,
      price: task.order.price,
      purchaseFormAnswers: task.order.purchaseFormAnswers ?? null,
      bookingDate: task.order.bookingDate,
    }

    return {
      work: {
        taskId: task.id,
        orderId: task.order.id,
        webhookConfigId: task.webhookConfigId,
        attempt,
        maxAttempts,
        leaseToken,
        url: task.webhookConfig.url,
        secret: decryptWebhookSecret(task.webhookConfig.secretCiphertext),
        rawBody: JSON.stringify(payload),
      },
      more: true,
    }
  })
}

/** 解析成功契约：2xx + JSON `{ content: 非空字符串 ≤ 5000 }`。不符返回 null。 */
function parseSuccessContent(status: number, body: string): string | null {
  if (status < 200 || status >= 300) return null
  try {
    const parsed = JSON.parse(body) as { content?: unknown }
    if (typeof parsed?.content !== 'string') return null
    const content = parsed.content.trim()
    if (content.length === 0 || content.length > CONTENT_MAX_CHARS) return null
    return content
  } catch {
    return null
  }
}

// ---------- dispatch 前生命周期 gate（复审 P1：不可逆 dispatch 的线性化点） ----------

type PreDispatchHook = (work: ClaimedWork) => Promise<void>

let preDispatchHookForTests: PreDispatchHook | null = null

/** 测试注入缝：在 gate 之前插桩（受控并发测试：在此完成一次撤销）。 */
export function __setPreDispatchHookForTests(hook: PreDispatchHook | null) {
  preDispatchHookForTests = hook
}

/**
 * 外呼前最后一道复查：`FOR SHARE OF c` 与轮换/撤销的 FOR UPDATE 在配置行上
 * 串行化——撤销先提交则此处必读到 revoked（或任务已被批量降级），返回
 * false 且 callWebhook 绝不被调用；本语句先取到锁则外呼视为在配置有效期内
 * 合法发起（不可逆），其后的撤销只能通过结果 CAS 影响交付。认领与外呼之间
 * 的窗口由此收敛为「gate 语句锁点之后」，语义见文件头注释。
 */
async function passesDispatchGate(work: ClaimedWork): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ taskStatus: string; configStatus: string }>>`
    SELECT t."status" AS "taskStatus", c."status" AS "configStatus"
    FROM "ProvisionTask" t
    JOIN "MerchantWebhookConfig" c ON c."id" = t."webhookConfigId"
    WHERE t."id" = ${work.taskId}
    FOR SHARE OF c`
  if (rows.length === 0) return false
  const { taskStatus, configStatus } = rows[0]
  // 任务已非 pending（撤销批量降级 / 手工交付路径已落定）：弃权，不外呼也
  // 不改写——落定者已经写下终态。
  if (taskStatus !== 'pending') return false
  if (configStatus !== 'active') {
    // 认领后配置被撤销：降级转人工（CAS 保护，别的路径已落定则不动）。
    await prisma.provisionTask.updateMany({
      where: { id: work.taskId, leaseToken: work.leaseToken, status: 'pending' },
      data: { status: 'degraded', leaseUntil: null, lastError: 'config_revoked' },
    })
    return false
  }
  return true
}

async function executeAttempt(work: ClaimedWork): Promise<void> {
  if (preDispatchHookForTests) await preDispatchHookForTests(work)
  if (!(await passesDispatchGate(work))) return
  let failureCode: string
  let httpStatus: number | null = null
  try {
    // HTTP 全程在事务外（硬验收 ⑨）；签名按本次 attempt 的载荷计算。
    const signature = signWebhookPayload(work.secret, work.rawBody, Math.floor(Date.now() / 1000))
    const result = await callWebhook(work.url, work.rawBody, signature)
    httpStatus = result.status
    const content = parseSuccessContent(result.status, result.body)
    if (content != null) {
      await settleSuccess(work, content, result.status)
      return
    }
    failureCode = result.status >= 200 && result.status < 300 ? 'bad_body' : `http_${result.status}`
  } catch (err) {
    failureCode = classifyWebhookFailure(err)
  }
  await settleFailure(work, failureCode, httpStatus)
}

async function settleSuccess(work: ClaimedWork, content: string, httpStatus: number): Promise<void> {
  try {
    await prisma.$transaction(async tx => {
      // 任务 CAS 先行（硬验收 ⑨）：同时确立「任务行 → 订单行」锁序（与
      // 认领事务一致），过期 worker 的迟到结果在此被丢弃。
      const cas = await tx.provisionTask.updateMany({
        where: { id: work.taskId, leaseToken: work.leaseToken, status: 'pending' },
        data: { status: 'succeeded', leaseUntil: null, lastError: null, lastHttpStatus: httpStatus },
      })
      if (cas.count !== 1) return
      // 复用既有交付链路：DeliveryRecord + 订阅 expiresAt + 状态事件；
      // 订单已被手工交付/状态变化 → transitionOrderStatus CAS 抛错回滚。
      await transitionOrderStatus({
        orderId: work.orderId,
        toStatus: 'delivered',
        actorRole: 'system',
        action: 'system.auto_provision.deliver',
        deliveryContent: content,
        publicNote: '自动开通交付',
      }, tx)
    })
  } catch (err) {
    // 复审 R2-P1：异常必须分类——只有**业务性拒绝**才允许取消任务。
    // transitionOrderStatus 的全部业务拒绝（状态 CAS 竞争 / 非法流转 /
    // 订单不存在）都抛 HttpError；瞬时基础设施故障（连接中断 / 死锁 /
    // DB 短暂不可用）是 Prisma/底层错误。误把后者标 cancelled 会让订单
    // 卡死 processing 且不进降级邮件通道，违反「结果落库失败必须至少
    // 一次重试」的契约。
    if (err instanceof HttpError) {
      // 交付竞争败北（商家已手工交付等）：任务取消，收到的内容弃用——
      // 绝不重复交付。仍要求租约与 pending 匹配，别的 worker 已落结果则不动。
      logger.warn({ err, taskId: work.taskId }, 'auto-provision delivery lost the race, cancelling task')
      await prisma.provisionTask.updateMany({
        where: { id: work.taskId, leaseToken: work.leaseToken, status: 'pending' },
        data: { status: 'cancelled', leaseUntil: null },
      })
      return
    }
    // 瞬时故障：保留 pending 并释放租约——nextAttemptAt 已在认领时预写，
    // 到点即重呼（接收端以 taskId 幂等去重）；重试耗尽走正常降级 + 邮件。
    // 释放本身失败也无妨：租约到期后自然可被重新认领。
    logger.warn({ err, taskId: work.taskId }, 'auto-provision result write failed transiently, will retry')
    await prisma.provisionTask.updateMany({
      where: { id: work.taskId, leaseToken: work.leaseToken, status: 'pending' },
      data: { leaseUntil: null, lastError: 'result_write_failed', lastHttpStatus: httpStatus },
    }).catch(releaseErr => {
      logger.warn({ err: releaseErr, taskId: work.taskId }, 'auto-provision lease release failed, lease expiry will recover')
    })
  }
}

async function settleFailure(work: ClaimedWork, code: string, httpStatus: number | null): Promise<void> {
  // nextAttemptAt 已在认领时预写；此处只记录诊断并在耗尽时降级。
  await prisma.provisionTask.updateMany({
    where: { id: work.taskId, leaseToken: work.leaseToken, status: 'pending' },
    data: {
      leaseUntil: null,
      lastError: code,
      lastHttpStatus: httpStatus,
      ...(work.attempt >= work.maxAttempts ? { status: 'degraded' } : {}),
    },
  })
}

/**
 * 通知租约窗口:必须 **大于** SMTP 三段硬超时之和(smtp.ts,有静态断言
 * 回归)——租约未到期时在途发送绝不会与重发重叠。
 */
export const NOTIFY_LEASE_MS = 60_000

/**
 * 降级通知（复审 R3 重构）：**SMTP 绝不进事务**。
 *
 * 流程 = 单语句 CAS 租约认领 → 事务外 SMTP → 按 claim token CAS 落
 * merchantNotifiedAt：
 * - 认领：`status='degraded' + merchantNotifiedAt IS NULL + 租约空闲` 的
 *   单语句 updateMany CAS 写入 leaseToken/leaseUntil——degraded 是终态、
 *   webhook 认领只取 pending，这两列在降级后闲置，复用为通知租约。
 *   无交互式事务：不占连接、无 5s 事务超时可撞。
 * - 发送成功 → 按 token 三条件 CAS 落 merchantNotifiedAt 并清租约；发送
 *   失败 → 定向释放租约（释放失败也无妨,租约到期自然重试）。
 * - 语义 = **至少一次邮件**：发送已被服务端接收但 CAS 前进程崩溃 → 租约
 *   到期后重发（商家可能收到重复通知——可接受；绝不漏发）。多实例并发
 *   由认领 CAS 串行化：在途租约未过期时其他实例不重复认领。
 * （导出供受控并发回归直接驱动。）
 */
export async function notifyDegradedTasks(now = new Date()): Promise<void> {
  const candidates = await prisma.provisionTask.findMany({
    where: { status: 'degraded', merchantNotifiedAt: null },
    take: 20,
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  for (const candidate of candidates) {
    const token = randomUUID()
    // 单语句认领 CAS(Prisma 模型 API:写入与比较同层,无 raw-SQL 时区陷阱)。
    const claimed = await prisma.provisionTask.updateMany({
      where: {
        id: candidate.id,
        status: 'degraded',
        merchantNotifiedAt: null,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: { leaseToken: token, leaseUntil: new Date(now.getTime() + NOTIFY_LEASE_MS) },
    })
    if (claimed.count !== 1) continue

    try {
      const task = await prisma.provisionTask.findUniqueOrThrow({
        where: { id: candidate.id },
        include: {
          order: {
            select: {
              id: true,
              productNameSnapshot: true,
              offerNameSnapshot: true,
              product: { select: { name: true } },
              offer: { select: { name: true } },
              merchant: { select: { contactEmail: true, user: { select: { email: true } } } },
            },
          },
        },
      })
      const recipient = task.order.merchant?.contactEmail ?? task.order.merchant?.user.email
      if (recipient) {
        const productName = task.order.productNameSnapshot ?? task.order.product.name
        const offerName = task.order.offerNameSnapshot ?? task.order.offer?.name ?? null
        const label = offerName ? `${productName} - ${offerName}` : productName
        const mailer = await getMailer()
        // SMTP 在任何事务之外;失败抛错走 catch 释放租约。
        await mailer.send({
          to: recipient,
          subject: `【自动开通失败，请人工履约】订单 #${task.order.id}`,
          text: [
            '您好，以下订单的自动开通未能完成，已转为人工履约：',
            '',
            `商品：${label}`,
            `订单号：#${task.order.id}`,
            `失败原因代码：${task.lastError ?? 'unknown'}`,
            '',
            '请尽快在商家后台手动交付该订单，避免超出履约时限。',
            '如需恢复自动开通，请检查回调服务与 webhook 配置。',
          ].join('\n'),
        })
      }
      // 成功(或无收件人——落时间戳避免死循环扫描):按 token CAS 标记。
      // 此写失败 → 租约到期重发 = 至少一次语义的重复窗口。
      await prisma.provisionTask.updateMany({
        where: { id: candidate.id, leaseToken: token, status: 'degraded', merchantNotifiedAt: null },
        data: { merchantNotifiedAt: new Date(), leaseToken: null, leaseUntil: null },
      })
    } catch (err) {
      logger.warn({ err, taskId: candidate.id }, 'auto-provision degrade mail send failed')
      // 定向释放本次租约,立即可重试;释放失败也无妨(租约到期自愈)。
      await prisma.provisionTask.updateMany({
        where: { id: candidate.id, leaseToken: token, merchantNotifiedAt: null },
        data: { leaseToken: null, leaseUntil: null },
      }).catch(releaseErr => {
        logger.warn({ err: releaseErr, taskId: candidate.id }, 'notify lease release failed, expiry will recover')
      })
    }
  }
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runProvisionBatch(now = new Date()) {
  if (running) return
  running = true
  try {
    const maxAttempts = await getSystemConfigValue('autoProvisionMaxAttempts')
    if (maxAttempts > 0) {
      // 认领上限之外再设一道扫描上限：认领事务内的取消/降级也消耗循环，
      // 防御性避免脏队列造成的长循环。
      const claimed: ClaimedWork[] = []
      let scans = 0
      while (claimed.length < CLAIM_BATCH_LIMIT && scans < CLAIM_BATCH_LIMIT * 3) {
        scans += 1
        const { work, more } = await claimNextTask(maxAttempts, new Date())
        if (work) claimed.push(work)
        if (!more) break
      }
      // 硬验收 ⑥：外呼并发上限——简单工作池。
      let cursor = 0
      const workers = Array.from({ length: Math.min(OUTBOUND_CONCURRENCY, claimed.length) }, async () => {
        while (cursor < claimed.length) {
          const work = claimed[cursor]
          cursor += 1
          try {
            await executeAttempt(work)
          } catch (err) {
            logger.warn({ err, taskId: work.taskId }, 'auto-provision attempt failed unexpectedly')
          }
        }
      })
      await Promise.all(workers)
    }
    // maxAttempts=0（运维刹车）时也继续通知既有降级任务。
    await notifyDegradedTasks()
  } catch (err) {
    logger.error({ err }, 'auto-provision batch failed')
  } finally {
    running = false
  }
}

export function startProvisionCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runProvisionBatch().catch(err => logger.error({ err }, 'auto-provision initial run failed'))
  timer = setInterval(() => {
    runProvisionBatch().catch(err => logger.error({ err }, 'auto-provision tick failed'))
  }, PROVISION_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: PROVISION_INTERVAL_MS }, 'auto-provision cron started')
}

export function stopProvisionCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('auto-provision cron stopped')
}
