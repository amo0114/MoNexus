// Shared pure commercial evaluation for publication and workbench navigation.
export interface ReadinessOffer {
  externalIntegration: string | null
  externalSku: string | null
  deliveryMode: string
  stockMode: string
  stock: number
  fixedContentType: string
  fixedFileId: number | null
  fixedFile: { status: string } | null
  fixedContent: string | null
  autoProvision: boolean
}

interface OfferEvaluation {
  externalInvalid?: boolean
  configValid: boolean
  sellable: boolean
  reason?: string
}

/**
 * Evaluate one active offer's commercial/fulfilment config and current
 * sellability. Pure sync decision tree — the only async inputs (available
 * inventory count, auto-provision webhook presence) are resolved by the
 * caller before invoking.
 */
export function evaluateActiveOffer(
  offer: ReadinessOffer,
  availableInventory: number,
  hasActiveWebhook: boolean,
  isProviderConfigured: () => boolean,
): OfferEvaluation {
  // External-integration offers (spec §6.1 #6): DB unique `(externalIntegration,
  // externalSku)` guarantees identity uniqueness; here we only re-check that the
  // local provider config is still valid. NO network call in the publish txn.
  if (offer.externalIntegration === 'faka_bridge') {
    if (!offer.externalSku) {
      return {
        externalInvalid: true,
        configValid: false,
        sellable: false,
        reason: 'FakaBridge 规格缺少 externalSku',
      }
    }
    if (!isProviderConfigured()) {
      return {
        externalInvalid: true,
        configValid: false,
        sellable: false,
        reason: '平台尚未配置 FakaBridge',
      }
    }
    if (offer.deliveryMode !== 'manual_service') {
      return {
        configValid: false,
        sellable: false,
        reason: 'FakaBridge 规格的履约模式必须为 manual_service',
      }
    }
    const sellable = offer.stockMode === 'unlimited' || offer.stock > 0
    return {
      configValid: true,
      sellable,
      reason: sellable ? undefined : '该规格当前没有可售名额',
    }
  }

  switch (offer.deliveryMode) {
    case 'instant_inventory': {
      // One available InventoryItem per deliverable secret (spec §6.1 #5).
      const configValid = offer.stockMode === 'limited'
      const sellable = configValid && availableInventory > 0
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格没有可用的交付库存'
          : '即时库存规格必须为限量库存',
      }
    }
    case 'instant_fixed': {
      // fixed content/file must be complete (spec §6.1 #5). File form is only
      // sellable while the bound DeliveryFile is still active — a revoked or
      // deleted pointer must not look publish-ready (checkout already rejects it).
      const fileFormValid =
        offer.fixedFileId != null && offer.fixedFile?.status === 'active'
      const contentValid =
        offer.fixedContentType === 'file'
          ? fileFormValid
          : Boolean(offer.fixedContent?.trim())
      const configValid = contentValid
      const sellable = configValid && (offer.stockMode === 'unlimited' || offer.stock > 0)
      const invalidReason =
        offer.fixedContentType === 'file' && offer.fixedFileId != null
          ? '固定文件已不可用，请重新绑定'
          : '固定内容规格缺少交付内容'
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格当前可售名额为 0'
          : invalidReason,
      }
    }
    case 'manual_service': {
      // 人工/自动/Faka 配置完整（spec §6.1 #5）。Faka handled above.
      let configValid = true
      let configReason: string | undefined
      if (offer.autoProvision && !hasActiveWebhook) {
        configValid = false
        configReason = '自动开通规格缺少可用的商家 webhook 配置'
      }
      const sellable = configValid && (offer.stockMode === 'unlimited' || offer.stock > 0)
      return {
        configValid,
        sellable,
        reason: configValid
          ? sellable ? undefined : '该规格当前可售名额为 0'
          : configReason,
      }
    }
    default:
      return { configValid: false, sellable: false, reason: '未知的履约模式' }
  }
}
