import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { HttpError } from '../../lib/httpError.js'
import { callFakaV2Subscription } from '../../lib/fakaBridge/accountV2.js'
import { paidResetPlanId } from '../../lib/fakaBridge/paidResetSku.js'
import { preflightPaidCheckout } from '../fakaBridge/paidCheckout.js'
import { isCurrentlyPubliclyVisible } from '../products/visibility.js'
import { assertActor, assertSelectedAccount, selectedAccount, type AccountActor } from './queries.js'
import { unavailable } from './settings.js'

const offerSelect = { id: true, productId: true, price: true, status: true, externalIntegration: true,
  externalSku: true, deliveryMode: true, stockMode: true, stock: true,
  product: { select: { status: true, archivedAt: true, visibility: true, merchantId: true, publicContentRevision: true,
    merchant: { select: { status: true } }, category: { select: { guestVisibility: true } },
    guestEligibility: { select: { decision: true, reviewedRevision: true } } } } } satisfies Prisma.OfferSelect
const blocked = (accountLinkId: string, blockReason: 'NO_OFFER' | 'SUBSCRIPTION_INELIGIBLE') => ({ accountLinkId, purchase: null, blockReason })
/** A read-only pointer, never a quote or authority to charge. Website rechecks everything. */
export async function purchaseReset(actor: AccountActor, accountLinkId?: string) {
  await assertActor(actor)
  if (!config.xboardAccounts.paidResetEnabled) throw new HttpError(503, 'XBOARD_PAID_RESET_UNAVAILABLE', '重置购买暂未开放')
  const link = await selectedAccount(actor, accountLinkId)
  const recheck = () => assertSelectedAccount(actor, link)
  // Never choose an offer using a stale/cached plan or a registration email.
  const remote = await callFakaV2Subscription(link.xboardUserId)
  await recheck()
  if (!remote.ok) throw unavailable()
  const sub = remote.body.subscription
  if (sub.status !== 'active' || !sub.plan_id || !paidResetPlanId(`plan-${sub.plan_id}-reset_traffic`)) return blocked(link.id, 'SUBSCRIPTION_INELIGIBLE')
  const skus = [`plan-${sub.plan_id}-reset_traffic`, `plan-${sub.plan_id}-reset_price`]
  // Canonical matching agrees with checkout's trim/lower parser, including legacy casing.
  const ids = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT DISTINCT ON (LOWER(BTRIM(o."externalSku"))) o."id"
    FROM "Offer" o JOIN "Product" p ON p."id" = o."productId"
    LEFT JOIN "Merchant" m ON m."id" = p."merchantId"
    WHERE o."status" = 'active' AND o."externalIntegration" = 'faka_bridge'
      AND o."deliveryMode" = 'manual_service' AND LOWER(BTRIM(o."externalSku")) IN (${Prisma.join(skus)})
      AND (o."stockMode" = 'unlimited' OR o."stock" > 0)
      AND p."status" = 'active' AND p."archivedAt" IS NULL
      AND (p."merchantId" IS NULL OR m."status" = 'active')
    ORDER BY LOWER(BTRIM(o."externalSku")) DESC, o."id" ASC`)
  const offers = await prisma.offer.findMany({ where: { id: { in: ids.map(o => o.id) } }, orderBy: { id: 'asc' },
    select: offerSelect })
  for (const offer of offers) {
    if (offer.status !== 'active' || offer.externalIntegration !== 'faka_bridge'
      || offer.deliveryMode !== 'manual_service' || paidResetPlanId(offer.externalSku) !== sub.plan_id
      || !isCurrentlyPubliclyVisible(offer.product, 'member') || offer.stockMode === 'limited' && offer.stock <= 0) continue
    const preview = await preflightPaidCheckout(actor.userId, offer, link.id)
    await recheck()
    if (!preview.eligible) {
      if (preview.blockReason === 'RESET_NOT_FOR_SALE') continue
      return blocked(link.id, 'SUBSCRIPTION_INELIGIBLE')
    }
    // Re-read catalog after HTTP: never return a product withdrawn while waiting.
    const current = await prisma.offer.findUnique({ where: { id: offer.id }, select: offerSelect })
    if (!current || current.status !== 'active' || current.externalIntegration !== 'faka_bridge'
      || current.externalSku !== offer.externalSku || current.deliveryMode !== 'manual_service'
      || !isCurrentlyPubliclyVisible(current.product, 'member') || current.stockMode === 'limited' && current.stock <= 0) continue
    await recheck()
    return { accountLinkId: link.id, blockReason: null, purchase: { productId: current.productId, offerId: current.id,
      accountLinkId: link.id, price: current.price } }
  }
  await recheck()
  return blocked(link.id, 'NO_OFFER')
}
