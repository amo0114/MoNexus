import frozenRegistry from './definitions.json' with { type: 'json' }
import {
  FULFILLMENT_CONFIGURATIONS,
  STRUCTURED_DELIVERY_REQUIREMENTS,
  TEMPLATE_KEYS,
  TEMPLATE_WIDGETS,
  type FulfillmentConfiguration,
  type FulfillmentRule,
  type ProductTemplateDefinition,
  type ProductTemplateRegistryDto,
  type ProductTemplateUi,
  type StructuredDeliveryRequirement,
  type TemplateKey,
  type TemplateWidget,
} from './types.js'
import { compileTemplateValidators } from './validate.js'

export const PRODUCT_TEMPLATE_REGISTRY_VERSION = 1 as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value)
}

function isTemplateWidget(value: unknown): value is TemplateWidget {
  return typeof value === 'string' && (TEMPLATE_WIDGETS as readonly string[]).includes(value)
}

function isFulfillmentConfiguration(value: unknown): value is FulfillmentConfiguration {
  return typeof value === 'string'
    && (FULFILLMENT_CONFIGURATIONS as readonly string[]).includes(value)
}

function isStructuredRequirement(value: unknown): value is StructuredDeliveryRequirement {
  return typeof value === 'string'
    && (STRUCTURED_DELIVERY_REQUIREMENTS as readonly string[]).includes(value)
}

function parseUi(raw: unknown, key: string): ProductTemplateUi {
  if (!isRecord(raw)) throw new Error(`template ${key} ui must be an object`)
  if (!Array.isArray(raw.productOrder) || !raw.productOrder.every(item => typeof item === 'string')) {
    throw new Error(`template ${key} ui.productOrder is invalid`)
  }
  if (!Array.isArray(raw.offerOrder) || !raw.offerOrder.every(item => typeof item === 'string')) {
    throw new Error(`template ${key} ui.offerOrder is invalid`)
  }
  if (!isRecord(raw.widgets)) throw new Error(`template ${key} ui.widgets must be an object`)
  const widgets: Record<string, TemplateWidget> = {}
  for (const [field, widget] of Object.entries(raw.widgets)) {
    if (!isTemplateWidget(widget)) {
      throw new Error(`template ${key} uses unsupported widget ${String(widget)} for ${field}`)
    }
    widgets[field] = widget
  }
  let enumLabels: Record<string, Record<string, string>> | undefined
  if (raw.enumLabels != null) {
    if (!isRecord(raw.enumLabels)) throw new Error(`template ${key} ui.enumLabels must be an object`)
    enumLabels = {}
    for (const [field, labels] of Object.entries(raw.enumLabels)) {
      if (!isRecord(labels) || !Object.values(labels).every(label => typeof label === 'string')) {
        throw new Error(`template ${key} ui.enumLabels.${field} is invalid`)
      }
      enumLabels[field] = Object.fromEntries(
        Object.entries(labels).map(([enumKey, label]) => [enumKey, String(label)]),
      )
    }
  }
  return {
    productOrder: raw.productOrder,
    offerOrder: raw.offerOrder,
    widgets,
    ...(enumLabels ? { enumLabels } : {}),
  }
}

function parseFulfillmentRules(raw: unknown, key: string): FulfillmentRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`template ${key} fulfillmentRules must be a non-empty array`)
  }
  return raw.map((rule, index) => {
    if (!isRecord(rule)) throw new Error(`template ${key} fulfillmentRules[${index}] is invalid`)
    if (!isRecord(rule.whenProductAttributes)) {
      throw new Error(`template ${key} fulfillmentRules[${index}].whenProductAttributes is invalid`)
    }
    const whenProductAttributes: Record<string, string | number | boolean> = {}
    for (const [attr, value] of Object.entries(rule.whenProductAttributes)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`template ${key} fulfillmentRules[${index}] condition ${attr} must be a scalar`)
      }
      whenProductAttributes[attr] = value
    }
    if (!Array.isArray(rule.configurations) || rule.configurations.length === 0
      || !rule.configurations.every(isFulfillmentConfiguration)) {
      throw new Error(`template ${key} fulfillmentRules[${index}].configurations is invalid`)
    }
    if (!isStructuredRequirement(rule.requireStructuredDelivery)) {
      throw new Error(`template ${key} fulfillmentRules[${index}].requireStructuredDelivery is invalid`)
    }
    if (typeof rule.requireRequiredDateField !== 'boolean') {
      throw new Error(`template ${key} fulfillmentRules[${index}].requireRequiredDateField is invalid`)
    }
    return {
      whenProductAttributes,
      configurations: rule.configurations,
      requireStructuredDelivery: rule.requireStructuredDelivery,
      requireRequiredDateField: rule.requireRequiredDateField,
    }
  })
}

function parseTemplate(raw: unknown): ProductTemplateDefinition {
  if (!isRecord(raw)) throw new Error('template definition must be an object')
  if (!isTemplateKey(raw.key)) throw new Error(`unknown template key ${String(raw.key)}`)
  if (raw.version !== 1) throw new Error(`template ${raw.key} version must be 1`)
  if (typeof raw.label !== 'string' || raw.label.trim() === '') {
    throw new Error(`template ${raw.key} label is required`)
  }
  if (!isRecord(raw.productSchema) || !isRecord(raw.offerSchema)) {
    throw new Error(`template ${raw.key} schemas must be objects`)
  }
  return {
    key: raw.key,
    version: raw.version,
    label: raw.label,
    productSchema: raw.productSchema,
    offerSchema: raw.offerSchema,
    ui: parseUi(raw.ui, raw.key),
    fulfillmentRules: parseFulfillmentRules(raw.fulfillmentRules, raw.key),
  }
}

function loadRegistry(raw: unknown): ProductTemplateRegistryDto {
  if (!isRecord(raw)) throw new Error('product template registry must be an object')
  if (raw.registryVersion !== PRODUCT_TEMPLATE_REGISTRY_VERSION) {
    throw new Error('product template registryVersion must be 1')
  }
  if (!Array.isArray(raw.templates) || raw.templates.length !== TEMPLATE_KEYS.length) {
    throw new Error('product template registry must contain exactly seven templates')
  }
  const templates = raw.templates.map(parseTemplate)
  const keys = templates.map(template => `${template.key}:${template.version}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error('product template key+version must be unique')
  }
  for (const expected of TEMPLATE_KEYS) {
    if (!templates.some(template => template.key === expected && template.version === 1)) {
      throw new Error(`missing frozen template ${expected}@1`)
    }
  }
  return { registryVersion: 1, templates }
}

const registry = loadRegistry(frozenRegistry)

compileTemplateValidators(registry.templates)

export function getProductTemplateRegistry(): ProductTemplateRegistryDto {
  return {
    registryVersion: 1,
    templates: registry.templates.map(template => ({
      key: template.key,
      version: template.version,
      label: template.label,
      productSchema: template.productSchema,
      offerSchema: template.offerSchema,
      ui: template.ui,
      fulfillmentRules: template.fulfillmentRules,
    })),
  }
}

export function getProductTemplate(
  key: TemplateKey,
  version: number,
): ProductTemplateDefinition | null {
  return registry.templates.find(template => template.key === key && template.version === version)
    ?? null
}

export function listTemplateExamples(): Record<TemplateKey, { product: unknown; offer: unknown }> {
  if (!isRecord(frozenRegistry) || !Array.isArray(frozenRegistry.templates)) {
    return {} as Record<TemplateKey, { product: unknown; offer: unknown }>
  }
  const examples = {} as Record<TemplateKey, { product: unknown; offer: unknown }>
  for (const raw of frozenRegistry.templates) {
    if (!isRecord(raw) || !isTemplateKey(raw.key) || !isRecord(raw.examples)) continue
    examples[raw.key] = {
      product: raw.examples.product,
      offer: raw.examples.offer,
    }
  }
  return examples
}
