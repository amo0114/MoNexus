import { badRequest } from '../httpError.js'
import { isFakaBridgeConfigured } from './client.js'

/** Supported Offer.externalIntegration values. */
export const FAKA_EXTERNAL_INTEGRATION = 'faka_bridge' as const

export type FakaExternalIntegration = typeof FAKA_EXTERNAL_INTEGRATION

// Xboard period keys use underscores (half_yearly, reset_traffic); named SKUs use hyphens.
const SKU_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/

export interface FakaOfferIntegrationInput {
  externalIntegration?: string | null
  externalSku?: string | null
  deliveryMode?: string | null
}

export interface NormalizedFakaOfferIntegration {
  externalIntegration: string | null
  externalSku: string | null
}

/**
 * Normalize + validate Offer fields for FakaBridge.
 * Call from merchant/admin offer write paths (M3 will also re-check at order time).
 *
 * Rules when externalIntegration = faka_bridge:
 * - externalSku required, lowercase slug
 * - deliveryMode must be manual_service (freeze points until provision)
 * - platform FAKA_BRIDGE_* env must be configured
 */
export function normalizeFakaOfferIntegration(
  input: FakaOfferIntegrationInput,
  options: { requireConfigured?: boolean } = {}
): NormalizedFakaOfferIntegration {
  const rawIntegration =
    input.externalIntegration == null || input.externalIntegration === ''
      ? null
      : String(input.externalIntegration).trim().toLowerCase()

  const rawSku =
    input.externalSku == null || input.externalSku === ''
      ? null
      : String(input.externalSku).trim().toLowerCase()

  if (rawIntegration == null) {
    // Orphan sku without integration is rejected to avoid silent misconfig.
    if (rawSku != null) {
      throw badRequest('设置 externalSku 时必须同时指定 externalIntegration')
    }
    return { externalIntegration: null, externalSku: null }
  }

  if (rawIntegration !== FAKA_EXTERNAL_INTEGRATION) {
    throw badRequest(`不支持的 externalIntegration: ${rawIntegration}`)
  }

  if (rawSku == null) {
    throw badRequest('FakaBridge 规格必须设置 externalSku（如 aster-basic-monthly）')
  }
  if (rawSku.length > 64 || !SKU_RE.test(rawSku)) {
    throw badRequest('externalSku 格式无效（小写字母、数字、连字符或下划线，如 plan-3-half_yearly）')
  }

  const mode = input.deliveryMode ?? null
  if (mode != null && mode !== 'manual_service') {
    throw badRequest('FakaBridge 规格的履约模式必须为 manual_service（冻结积分后开通）')
  }

  if (options.requireConfigured !== false && !isFakaBridgeConfigured()) {
    throw badRequest('平台未配置 FakaBridge（FAKA_BRIDGE_URL / FAKA_BRIDGE_SECRET）')
  }

  return {
    externalIntegration: FAKA_EXTERNAL_INTEGRATION,
    externalSku: rawSku,
  }
}

export function isFakaBridgeOffer(offer: {
  externalIntegration?: string | null
}): boolean {
  return offer.externalIntegration === FAKA_EXTERNAL_INTEGRATION
}

/**
 * P7b 商家 webhook 自动开通 与 平台 FakaBridge 互斥。
 * 冲突时明确 400 拒绝，不静默关闭另一项。
 */
export function assertOfferProvisionMutex(input: {
  autoProvision?: boolean | null
  externalIntegration?: string | null
}): void {
  const auto = input.autoProvision === true
  const faka = input.externalIntegration === FAKA_EXTERNAL_INTEGRATION
  if (auto && faka) {
    throw badRequest(
      '不能同时开启「商家自动开通」与「FakaBridge/Xboard 开通」。请只保留其中一种自动履约路径。'
    )
  }
}
