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
