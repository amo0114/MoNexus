import { createHmac } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { callFakaV2Capabilities } from '../../lib/fakaBridge/accountV2.js'
import { callPaidResetPreview } from '../../lib/fakaBridge/paidResetV2.js'
import { paidResetPlanId } from '../../lib/fakaBridge/paidResetSku.js'
import { accountSettings, requireInstance, unavailable, unresolved } from '../xboardAccounts/settings.js'

type Offer = { id: number; externalSku: string | null }
export type PaidCheckoutTarget = { accountLinkId: string; instanceId: string; origin: string;
  xboardUserId: string; planId: string; clientId: string; version: string; email: string }
export type PaidCheckoutPreview = { accounts: Array<{ id: string; maskedEmail: string }>;
  selectedAccountLinkId: string | null; targetVersion: string | null; eligible: boolean; blockReason: string | null }
const changed = () => new HttpError(409, 'CHECKOUT_CHANGED', '套餐账号或商品信息已变化，请重新确认')
function enabled() { if (!config.xboardAccounts.paidResetEnabled) throw unavailable() }
function mask(email: string) {
  const at = email.lastIndexOf('@')
  return at > 0 ? `${email.slice(0, Math.min(2, at))}***${email.slice(at)}` : '***'
}
function target(userId: number, offer: Offer, link: { id: string; xboardUserId: string; currentEmail: string }): PaidCheckoutTarget {
  const settings = accountSettings(), planId = paidResetPlanId(offer.externalSku)
  if (!planId) throw changed()
  const identity = [userId, offer.id, link.id, settings.instanceId, settings.origin, link.xboardUserId,
    planId, config.trafficReset.clientId, offer.externalSku!.trim().toLowerCase()]
  return { accountLinkId: link.id, ...settings, xboardUserId: link.xboardUserId, planId,
    clientId: config.trafficReset.clientId, email: link.currentEmail,
    version: createHmac('sha256', config.jwtSecret).update(JSON.stringify(['paid-checkout-v1', ...identity])).digest('hex') }
}
export async function readPaidCheckoutTarget(userId: number, offer: Offer, accountLinkId: string,
  db: typeof prisma | Prisma.TransactionClient = prisma): Promise<PaidCheckoutTarget> {
  enabled()
  const settings = accountSettings()
  const [link, instance, user] = await Promise.all([
    db.xboardAccountLink.findFirst({ where: { id: accountLinkId, userId, instanceId: settings.instanceId } }),
    db.xboardInstance.findUnique({ where: { id: settings.instanceId } }),
    db.user.findUnique({ where: { id: userId }, select: { status: true } }),
  ])
  if (!link) throw notFound()
  if (link.status !== 'active') throw unresolved()
  if (instance?.origin !== settings.origin) throw unavailable()
  if (user?.status !== '正常') throw new HttpError(403, 'FORBIDDEN', '账号状态异常，无法下单')
  return target(userId, offer, link)
}
/** Fresh remote preflight only; no HTTP inside the order transaction. */
export async function preflightPaidCheckout(userId: number, offer: Offer, accountLinkId: string) {
  const frozen = await readPaidCheckoutTarget(userId, offer, accountLinkId)
  const caps = await callFakaV2Capabilities()
  if (!caps.ok || !caps.body.capabilities.paid_reset_by_user_id) throw unavailable()
  const remote = await callPaidResetPreview({ user_id: frozen.xboardUserId, sku: offer.externalSku!.trim().toLowerCase(), expected_plan_id: frozen.planId })
  if (!remote.ok) throw unavailable()
  const current = await readPaidCheckoutTarget(userId, offer, accountLinkId)
  if (current.version !== frozen.version) throw changed()
  return { target: frozen, eligible: remote.body.preview.eligible, blockReason: remote.body.preview.block_reason }
}
export async function paidCheckoutPreview(userId: number, offer: Offer, requestedId?: string): Promise<PaidCheckoutPreview> {
  enabled()
  const { instanceId } = await requireInstance()
  const links = await prisma.xboardAccountLink.findMany({ where: { userId, instanceId, status: 'active' }, orderBy: { id: 'asc' }, take: 101 })
  const accounts = links.slice(0, 100).map(link => ({ id: link.id, maskedEmail: mask(link.currentEmail) }))
  // Multiple accounts require an explicit selection. The browser echoes the
  // selected UUID/version even when a sole account was selected automatically.
  const selected = requestedId ?? (links.length === 1 ? links[0].id : null)
  if (!selected) return { accounts, selectedAccountLinkId: null, targetVersion: null, eligible: false,
    blockReason: links.length ? '请选择要重置的套餐账号' : '账号关联尚未就绪，请联系管理员核验历史套餐订单' }
  const result = await preflightPaidCheckout(userId, offer, selected)
  // An explicit owned target may lie beyond the bounded list. It must still
  // be visible in the selector the buyer is about to confirm.
  if (!accounts.some(account => account.id === selected)) {
    if (accounts.length === 100) accounts.pop()
    accounts.push({ id: selected, maskedEmail: mask(result.target.email) })
  }
  return { accounts, selectedAccountLinkId: selected, targetVersion: result.target.version,
    eligible: result.eligible, blockReason: result.eligible ? null : '当前账号套餐不可购买此重置，请核对套餐、有效期及重置售卖状态' }
}
/** Lock the link until task insertion so a concurrent reassignment cannot retarget the order. */
export async function assertPaidCheckoutTarget(tx: Prisma.TransactionClient, userId: number, offer: Offer,
  frozen: PaidCheckoutTarget, expectedVersion: string | undefined) {
  await tx.$queryRaw`SELECT "id" FROM "XboardAccountLink" WHERE "id" = ${frozen.accountLinkId}::uuid FOR SHARE`
  const current = await readPaidCheckoutTarget(userId, offer, frozen.accountLinkId, tx)
  if (!expectedVersion || current.version !== frozen.version || current.version !== expectedVersion) throw changed()
  return current
}
