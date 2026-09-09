import type { ProductTemplateDefinition, TemplateAttributes } from './types.js'
import {
  type FulfillmentConfiguration,
  type FulfillmentOfferInput,
  type FulfillmentResolveResult,
  type FulfillmentRule,
  type FulfillmentStrategy,
} from './types.js'

function isEmptyJson(value: unknown): boolean {
  return value == null
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
    || (Array.isArray(value) && value.length === 0)
}

function conflict(message: string): FulfillmentResolveResult {
  return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message }
}

/**
 * Pure strategy selection from Offer configuration (SPEC-PRODUCT-COMMERCE-002 §4.2 / §9.4).
 * Does not persist a strategy column and does not execute orders.
 * `fixed_url` is a distinct configuration in the legal matrix; collapsing it
 * into `fixed_text` would hide mixed-config conflicts.
 */
export function resolveFulfillmentStrategy(offer: FulfillmentOfferInput): FulfillmentResolveResult {
  const hasExternal = offer.externalIntegration != null && offer.externalIntegration !== ''
  const isFaka = offer.externalIntegration === 'faka_bridge'
  const hasFile = offer.fixedFileId != null
  const hasFixedText = offer.fixedContent != null && offer.fixedContent !== ''
  const hasDeliveryFields = !isEmptyJson(offer.deliveryFields)
  const hasStructured = !isEmptyJson(offer.fixedStructuredContent)

  if (hasExternal && !isFaka) {
    return conflict('不支持的外部集成')
  }
  if (isFaka && offer.autoProvision) {
    return conflict('FakaBridge 与自动开通不能同时开启')
  }
  if (isFaka) {
    if (offer.deliveryMode !== 'manual_service') return conflict('FakaBridge 必须使用人工开通模式')
    if (hasFile || hasFixedText || hasStructured || hasDeliveryFields) {
      return conflict('FakaBridge 不能混用固定内容或库存字段')
    }
    if (offer.fixedContentType !== 'text') return conflict('FakaBridge 的固定内容类型必须为空协议值 text')
    return { ok: true, strategy: { kind: 'faka_bridge' } }
  }
  if (offer.autoProvision) {
    if (offer.deliveryMode !== 'manual_service') return conflict('自动开通必须使用人工服务模式')
    if (hasFile || hasFixedText || hasStructured || hasDeliveryFields) {
      return conflict('自动开通不能混用固定内容或库存字段')
    }
    if (offer.fixedContentType !== 'text') return conflict('自动开通的固定内容类型必须为空协议值 text')
    return { ok: true, strategy: { kind: 'merchant_webhook' } }
  }

  if (offer.deliveryMode === 'instant_inventory') {
    if (offer.stockMode !== 'limited') return conflict('库存领取必须使用有限库存')
    if (offer.fixedContentType !== 'text') return conflict('库存领取不能设置固定内容类型')
    if (hasFile || hasFixedText || hasStructured) return conflict('库存领取不能混用固定内容或文件')
    return { ok: true, strategy: { kind: 'inventory' } }
  }

  if (offer.deliveryMode === 'instant_fixed') {
    if (offer.stockMode === 'limited' && hasFile) {
      // limited/unlimited still follow original capacity rules; file form forbids mixed fields.
    }
    if (hasDeliveryFields) return conflict('固定交付不能使用库存交付字段')
    if (offer.fixedContentType === 'file') {
      if (!hasFile) return conflict('文件交付必须绑定有效文件')
      if (hasFixedText || hasStructured) return conflict('文件交付不能同时写入固定文本')
      return { ok: true, strategy: { kind: 'fixed_file' } }
    }
    if (hasFile) return conflict('非文件固定交付不能绑定文件')
    if (offer.fixedContentType === 'url') {
      if (hasStructured) return conflict('固定链接不能使用结构化账号内容')
      return { ok: true, strategy: { kind: 'fixed_url' } }
    }
    if (offer.fixedContentType === 'text') {
      return { ok: true, strategy: { kind: 'fixed_text' } }
    }
    return conflict('固定交付内容类型无效')
  }

  if (offer.deliveryMode === 'manual_service') {
    if (hasFile || hasFixedText || hasStructured || hasDeliveryFields) {
      return conflict('人工服务不能混用即时固定内容或库存字段')
    }
    if (offer.fixedContentType !== 'text') return conflict('人工服务的固定内容类型必须为空协议值 text')
    return { ok: true, strategy: { kind: 'manual' } }
  }

  return conflict('履约配置不合法')
}

export function matchFulfillmentRule(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentRule | null {
  for (const rule of template.fulfillmentRules) {
    const matches = Object.entries(rule.whenProductAttributes).every(
      ([key, expected]) => productAttributes[key] === expected,
    )
    if (matches) return rule
  }
  return null
}

export function allowedFulfillmentConfigurations(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentConfiguration[] {
  const matched = matchFulfillmentRule(template, productAttributes)
  if (matched) return [...matched.configurations]
  const union = new Set<FulfillmentConfiguration>()
  for (const rule of template.fulfillmentRules) {
    for (const configuration of rule.configurations) union.add(configuration)
  }
  return [...union]
}

export function strategyToConfiguration(strategy: FulfillmentStrategy): FulfillmentConfiguration {
  return strategy.kind
}

function intendedConfiguration(offer: FulfillmentOfferInput): FulfillmentConfiguration | null {
  if (offer.externalIntegration === 'faka_bridge') return 'faka_bridge'
  if (offer.autoProvision) return 'merchant_webhook'
  if (offer.deliveryMode === 'instant_inventory') return 'inventory'
  if (offer.deliveryMode === 'instant_fixed') {
    if (offer.fixedContentType === 'file') return 'fixed_file'
    if (offer.fixedContentType === 'url') return 'fixed_url'
    if (offer.fixedContentType === 'text') return 'fixed_text'
  }
  if (offer.deliveryMode === 'manual_service') return 'manual'
  return null
}

export function evaluateTemplateFulfillment(input: {
  template: ProductTemplateDefinition
  productAttributes: TemplateAttributes
  offer: FulfillmentOfferInput
  mode: 'draft' | 'publish'
  purchaseForm?: Array<{ type?: string; required?: boolean }> | null
}): FulfillmentResolveResult & { rule: FulfillmentRule | null } {
  const rule = matchFulfillmentRule(input.template, input.productAttributes)
  const allowed = allowedFulfillmentConfigurations(input.template, input.productAttributes)
  const resolved = resolveFulfillmentStrategy(input.offer)
  if (!resolved.ok) {
    if (input.mode === 'draft') {
      const intended = intendedConfiguration(input.offer)
      if (intended && allowed.includes(intended)) {
        return { ok: true, strategy: { kind: intended }, rule }
      }
    }
    return { ...resolved, rule }
  }
  const configuration = strategyToConfiguration(resolved.strategy)

  if (input.mode === 'draft') {
    if (!allowed.includes(configuration)) {
      return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '履约配置与当前模板选项不符', rule }
    }
    return { ...resolved, rule }
  }

  if (!rule) {
    return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '发布前必须补齐用于选择履约路径的模板属性', rule }
  }
  if (!rule.configurations.includes(configuration)) {
    return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '履约配置不在该模板的合法组合中', rule }
  }
  if (rule.requireStructuredDelivery === 'inventory_fields') {
    const fields = input.offer.deliveryFields
    const count = Array.isArray(fields) ? fields.length : 0
    if (count < 1 || count > 8) {
      return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '独享账号发布必须配置 1..8 个交付字段', rule }
    }
  }
  if (rule.requireStructuredDelivery === 'fixed_fields') {
    if (isEmptyJson(input.offer.fixedStructuredContent)) {
      return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '共享账号发布必须提供结构化固定内容', rule }
    }
  }
  if (rule.requireRequiredDateField) {
    const hasRequiredDate = (input.purchaseForm ?? []).some(
      field => field.type === 'date' && field.required === true,
    )
    if (!hasRequiredDate) {
      return { ok: false, code: 'FULFILLMENT_CONFIG_INVALID', message: '预约服务必须包含必填日期购买字段', rule }
    }
  }
  return { ...resolved, rule }
}
