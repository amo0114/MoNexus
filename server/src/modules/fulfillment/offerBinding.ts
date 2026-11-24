import type { Prisma } from '@prisma/client'
import type { ExternalOfferBinding } from '../../extension-contracts/fulfillmentCatalog.js'
import { getFulfillmentProvider, listFulfillmentProviders } from './registry.js'
import { badRequest } from '../../lib/httpError.js'
import { checkoutProviderFor } from './coordination.js'

const SKU_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/

/**
 * Validate an Offer binding to a registered provider (other than the legacy
 * FakaBridge normalizer). The provider's own config/eligibility is checked
 * again at checkout; this keeps the stored binding well-formed.
 */
export function normalizeProviderOfferBinding(input: {
  externalIntegration: string
  externalSku?: string | null
  deliveryMode?: string | null
}): { externalIntegration: string; externalSku: string } {
  const providerId = input.externalIntegration.trim().toLowerCase()
  if (!checkoutProviderFor(providerId)) throw badRequest(`不支持的 externalIntegration: ${providerId}`)
  const sku = input.externalSku == null ? '' : String(input.externalSku).trim().toLowerCase()
  if (!sku) throw badRequest('外部开通规格必须设置 externalSku')
  if (sku.length > 64 || !SKU_RE.test(sku)) {
    throw badRequest('externalSku 格式无效（小写字母、数字、连字符或下划线）')
  }
  if (input.deliveryMode != null && input.deliveryMode !== 'manual_service') {
    throw badRequest('外部开通规格的履约模式必须为 manual_service（冻结积分后开通）')
  }
  return { externalIntegration: providerId, externalSku: sku }
}


export function catalogForProvider(id: string | null | undefined) {
  return id ? getFulfillmentProvider(id)?.catalog : undefined
}

export function normalizeExternalOfferBinding(input: ExternalOfferBinding, options?: { requireConfigured?: boolean }) {
  const id = input.externalIntegration?.trim().toLowerCase()
  if (!id) {
    if (input.externalSku?.trim()) throw badRequest('设置 externalSku 时必须同时指定 externalIntegration')
    return { externalIntegration: null, externalSku: null }
  }
  const catalog = catalogForProvider(id)
  return catalog
    ? catalog.normalizeBinding(input, options)
    : normalizeProviderOfferBinding({ ...input, externalIntegration: id })
}

export function assertOfferProvisionMutex(input: { autoProvision?: boolean | null; externalIntegration?: string | null }) {
  if (input.autoProvision && input.externalIntegration) {
    throw badRequest('不能同时开启「商家自动开通」与「外部供应商开通」。请只保留其中一种自动履约路径。')
  }
}

export async function countOpenExternalOfferTasks(tx: Prisma.TransactionClient, offerIds: number[]) {
  const providers = listFulfillmentProviders()
  const values = await Promise.all([
    ...providers.flatMap(provider => provider.countOpenOfferTasks ? [provider.countOpenOfferTasks(tx, offerIds)] : []),
    tx.order.count({ where: {
      offerId: { in: offerIds },
      status: { in: ['pending', 'processing'] },
      externalFulfillmentProvider: { not: null, notIn: providers.map(provider => provider.id) },
    } }),
  ])
  return values.reduce((sum, count) => sum + count, 0)
}
