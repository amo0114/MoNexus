import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
} from '../../lib/webhookSecret.js'
import {
  assertResolvedWebhookTarget,
  callWebhook,
  classifyWebhookFailure,
  signWebhookPayload,
  validateWebhookUrl,
  WebhookTargetError,
} from '../../lib/outboundWebhook.js'

/**
 * P7b：商家自动开通 webhook 配置（设计 §3.2/§3.6，硬验收 ⑤⑦）。
 *
 * 硬规则：
 * - 版本化：保存 = 撤销旧 active 行 + 新建 active 行（新 secret）；每商家至
 *   多一条 active（部分唯一索引兜底并发）。
 * - **轮换/撤销即降级**：引用被撤销配置的 pending 任务在同一事务内置
 *   degraded（含在途租约的任务——其迟到结果被 status='pending' CAS 丢弃），
 *   任务**绝不解析到新配置**；降级邮件由 provision cron 的
 *   merchantNotifiedAt 通道统一补发。
 * - 撤销配置时原子关闭该商家全部规格的 autoProvision 开关——否则这些规格
 *   的新订单会在下单事务冻结配置时 409，商品事实上不可购买。开关变化进
 *   checkoutVersion，买家预览自动失效重确认。
 * - secret 明文只在保存（创建/轮换）响应中一次性返回；常规读取只回尾 4 位。
 * - URL 在保存时过完整 SSRF 校验 + **DNS 解析校验**（外呼时还会再验 +
 *   连接期钉扎——保存时校验是快速失败，连接期钉扎才是安全边界）。
 *
 * **生命周期线性化（复审 P1）**：active 配置行的行锁是全部生命周期操作的
 * 唯一线性化点——
 * - 读侧（下单冻结、规格开关启用、dispatch 前 gate）`FOR SHARE`：彼此可并行，
 *   与轮换/撤销互斥；
 * - 写侧（轮换/撤销）先 `FOR UPDATE` 再改状态。
 * READ COMMITTED 下锁等待结束后会对行**重新求值谓词**：撤销先提交 → 读侧的
 * `status='active'` 谓词失配、查无 active 行（下单 409 / 开关 422 / gate 降级）；
 * 读侧先提交 → 撤销在锁上排队，恢复后其降级/关开关扫描的语句快照必然包含
 * 读侧刚提交的新任务/新开关。任何一侧都不存在静默错配窗口。
 */

function secretLast4(ciphertext: string): string {
  return decryptWebhookSecret(ciphertext).slice(-4)
}

// ---------- 生命周期锁原语 ----------

interface ActiveConfigLockTestHooks {
  /** FOR SHARE 加锁前调用（受控并发测试用：在此完成一次完整撤销）。 */
  beforeLock?: () => Promise<void>
  /** FOR SHARE 加锁后、事务提交前调用（受控并发测试用：在此发起并阻塞一次撤销）。 */
  afterLock?: (locked: { id: number } | null) => Promise<void>
}

let activeConfigLockTestHooks: ActiveConfigLockTestHooks | null = null

/** 测试注入缝：在 FOR SHARE 临界区前后插桩，构造确定性的生命周期竞争。 */
export function __setActiveConfigLockHooksForTests(hooks: ActiveConfigLockTestHooks | null) {
  activeConfigLockTestHooks = hooks
}

/**
 * 以 FOR SHARE 锁定商家当前 active 配置行（生命周期读侧线性化点）。
 * 返回 null = 此刻（含等待中的撤销提交后）已无 active 配置。
 * 调用方必须与后续依赖该配置的写入处于**同一事务**，锁才护得住整个临界区。
 */
export async function lockActiveWebhookConfigForShare(
  tx: Prisma.TransactionClient,
  merchantId: number
): Promise<{ id: number } | null> {
  if (activeConfigLockTestHooks?.beforeLock) await activeConfigLockTestHooks.beforeLock()
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "MerchantWebhookConfig"
    WHERE "merchantId" = ${merchantId} AND "status" = 'active'
    FOR SHARE`
  const locked = rows.length > 0 ? { id: rows[0].id } : null
  if (activeConfigLockTestHooks?.afterLock) await activeConfigLockTestHooks.afterLock(locked)
  return locked
}

/** 写侧（轮换/撤销）：FOR UPDATE 独占 active 行——与全部 FOR SHARE 读侧互斥。 */
async function lockActiveWebhookConfigForUpdate(
  tx: Prisma.TransactionClient,
  merchantId: number
): Promise<{ id: number } | null> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "MerchantWebhookConfig"
    WHERE "merchantId" = ${merchantId} AND "status" = 'active'
    FOR UPDATE`
  return rows.length > 0 ? { id: rows[0].id } : null
}

/**
 * 复审 R2-P2：写侧（save/revoke）彼此之间的互斥不能建立在「当前 active 行」
 * 上——轮换会撤销旧行并**插入新行**，并发写侧的锁定语句快照看不到未提交/
 * 刚提交的新行（EvalPlanQual 只重评估既有行版本），会出现双 active 撞部分
 * 唯一索引（P2002）或误判 404。Merchant 父行是稳定的每商家互斥点：写侧
 * 先独占它再动配置行。
 * 锁强度必须是 FOR NO KEY UPDATE 而非 FOR UPDATE：下单事务插入 Order 行时
 * 经外键在 Merchant 行持有 FOR KEY SHARE——FOR UPDATE 与之冲突，撤销会被
 * 全部在途下单事务阻塞（受控回归里表现为事务超时）；FOR NO KEY UPDATE
 * 与 KEY SHARE 兼容、写侧之间仍互斥。读侧（FOR SHARE 配置行）不需要此
 * 锁——它们与「撤销旧行」的 UPDATE 行锁天然互斥，语义见文件头。
 */
async function lockMerchantForConfigWrite(tx: Prisma.TransactionClient, merchantId: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Merchant" WHERE "id" = ${merchantId} FOR NO KEY UPDATE`
}

export async function getMyWebhookConfig(merchantId: number) {
  const active = await prisma.merchantWebhookConfig.findFirst({
    where: { merchantId, status: 'active' },
    select: { url: true, secretCiphertext: true, createdAt: true },
  })
  if (!active) return null
  return {
    url: active.url,
    secretLast4: secretLast4(active.secretCiphertext),
    createdAt: active.createdAt,
  }
}

/** 保存（创建或轮换）：返回值是 secret 明文的**唯一**出口。 */
export async function saveMyWebhookConfig(merchantId: number, rawUrl: string) {
  try {
    const url = validateWebhookUrl(rawUrl)
    // 复审 P2：保存时即解析 hostname 并拒绝内网/保留目标（双重校验前半段）。
    await assertResolvedWebhookTarget(url)
  } catch (err) {
    if (err instanceof WebhookTargetError) throw badRequest(err.message)
    throw err
  }

  const secret = generateWebhookSecret()
  const created = await prisma.$transaction(async tx => {
    // 每商家写侧互斥（复审 R2-P2）：先独占 Merchant 父行——并发 save/revoke
    // 在此串行化，杜绝双 active（P2002）与误判 404。
    await lockMerchantForConfigWrite(tx, merchantId)
    // 线性化点：独占旧 active 行——与在途的下单冻结/开关启用（FOR SHARE）
    // 互斥，等它们提交后本事务的降级扫描必然覆盖其新建任务。
    const previous = await lockActiveWebhookConfigForUpdate(tx, merchantId)
    if (previous) {
      await tx.merchantWebhookConfig.update({
        where: { id: previous.id },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      // 硬验收 ⑤：尚未发出的旧任务安全默认降级人工——绝不切到新配置。
      await tx.provisionTask.updateMany({
        where: { webhookConfigId: previous.id, status: 'pending' },
        data: { status: 'degraded', lastError: 'config_revoked', leaseUntil: null },
      })
    }
    return tx.merchantWebhookConfig.create({
      data: {
        merchantId,
        url: rawUrl,
        secretCiphertext: encryptWebhookSecret(secret),
      },
      select: { url: true, createdAt: true },
    })
  })

  return {
    url: created.url,
    createdAt: created.createdAt,
    // 一次性明文：前端弹窗展示后不再可取。
    secret,
    secretLast4: secret.slice(-4),
  }
}

export async function revokeMyWebhookConfig(merchantId: number) {
  const { result, productIds } = await prisma.$transaction(async tx => {
    // 每商家写侧互斥（复审 R2-P2）：见 lockMerchantForConfigWrite。
    await lockMerchantForConfigWrite(tx, merchantId)
    // 线性化点：见文件头注释——FOR UPDATE 与全部读侧 FOR SHARE 互斥。
    const active = await lockActiveWebhookConfigForUpdate(tx, merchantId)
    if (!active) throw notFound('尚未配置自动开通 webhook')
    await tx.merchantWebhookConfig.update({
      where: { id: active.id },
      data: { status: 'revoked', revokedAt: new Date() },
    })
    await tx.provisionTask.updateMany({
      where: { webhookConfigId: active.id, status: 'pending' },
      data: { status: 'degraded', lastError: 'config_revoked', leaseUntil: null },
    })
    // 原子关闭全部开关：否则这些规格的新订单会在冻结配置时 409，
    // 商品事实上不可购买；开关变化进 checkoutVersion，预览自动失效。
    // 先收集受影响商品——提交后失效其公开详情缓存（复审 P2：公开页的
    // 自动开通披露最多滞后一个 TTL，必须主动失效）。
    const affected = await tx.offer.findMany({
      where: { autoProvision: true, product: { merchantId } },
      select: { productId: true },
      distinct: ['productId'],
    })
    const offers = await tx.offer.updateMany({
      where: { autoProvision: true, product: { merchantId } },
      data: { autoProvision: false },
    })
    return {
      result: { revoked: true, disabledOffers: offers.count },
      productIds: affected.map(a => a.productId),
    }
  })
  await Promise.all(productIds.map(id => invalidateProductPublicCache(id, { detail: true })))
  return result
}

/**
 * 测试事件：与真实外呼同一条安全路径（SSRF 校验 + 钉扎 + 签名），taskId 带
 * `test-` 前缀且 `test: true`，供商家验证签名校验与 taskId 幂等去重逻辑。
 * 结果只回 HTTP 状态与脱敏诊断码，绝不回远端响应体。
 */
export async function sendTestWebhookEvent(merchantId: number) {
  const active = await prisma.merchantWebhookConfig.findFirst({
    where: { merchantId, status: 'active' },
    select: { url: true, secretCiphertext: true },
  })
  if (!active) throw notFound('尚未配置自动开通 webhook')

  const payload = {
    taskId: `test-${randomUUID()}`,
    test: true,
    attempt: 1,
    timestamp: Math.floor(Date.now() / 1000),
    orderId: 0,
    productName: '测试商品',
    offerName: null,
    price: 0,
    purchaseFormAnswers: null,
    bookingDate: null,
  }
  const rawBody = JSON.stringify(payload)
  const signature = signWebhookPayload(decryptWebhookSecret(active.secretCiphertext), rawBody, payload.timestamp)
  try {
    const result = await callWebhook(active.url, rawBody, signature)
    return { ok: result.status >= 200 && result.status < 300, httpStatus: result.status }
  } catch (err) {
    return { ok: false, httpStatus: null, error: classifyWebhookFailure(err) }
  }
}
