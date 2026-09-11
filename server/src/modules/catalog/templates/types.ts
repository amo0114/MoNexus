// SPEC-PRODUCT-COMMERCE-002 §4 — versioned product template contracts.
// These types are the runtime mirror of definitions.json. Validation is Ajv
// (attributes) + fulfillmentRules (publish combinations). UI widgets are not
// a validation source.

export const TEMPLATE_KEYS = [
  'redemption_code',
  'account',
  'digital_file',
  'fixed_content',
  'subscription',
  'manual_service',
  'appointment',
] as const

export type TemplateKey = (typeof TEMPLATE_KEYS)[number]

export const TEMPLATE_WIDGETS = [
  'text',
  'textarea',
  'select',
  'stringList',
  'integer',
] as const

export type TemplateWidget = (typeof TEMPLATE_WIDGETS)[number]

export const FULFILLMENT_CONFIGURATIONS = [
  'inventory',
  'fixed_text',
  'fixed_url',
  'fixed_file',
  'manual',
  'merchant_webhook',
  'faka_bridge',
] as const

export type FulfillmentConfiguration = (typeof FULFILLMENT_CONFIGURATIONS)[number]

export const STRUCTURED_DELIVERY_REQUIREMENTS = [
  'none',
  'inventory_fields',
  'fixed_fields',
] as const

export type StructuredDeliveryRequirement =
  (typeof STRUCTURED_DELIVERY_REQUIREMENTS)[number]

export type TemplateAttributes = Record<string, string | number | boolean | string[]>

export type ProductDetails = {
  highlights: string[]
  usageInstructions: string
  purchaseNotes: string
  afterSalesInstructions: string
  faq: Array<{ question: string; answer: string }>
}

export const EMPTY_PRODUCT_DETAILS: ProductDetails = {
  highlights: [],
  usageInstructions: '',
  purchaseNotes: '',
  afterSalesInstructions: '',
  faq: [],
}

export const EMPTY_PRODUCT_DETAILS_JSON = JSON.stringify(EMPTY_PRODUCT_DETAILS)

export type FulfillmentRule = {
  whenProductAttributes: Record<string, string | number | boolean>
  configurations: FulfillmentConfiguration[]
  requireStructuredDelivery: StructuredDeliveryRequirement
  requireRequiredDateField: boolean
}

export type ProductTemplateUi = {
  productOrder: string[]
  offerOrder: string[]
  widgets: Record<string, TemplateWidget>
  enumLabels?: Record<string, Record<string, string>>
}

export type ProductTemplateDefinition = {
  key: TemplateKey
  version: number
  label: string
  productSchema: Record<string, unknown>
  offerSchema: Record<string, unknown>
  ui: ProductTemplateUi
  fulfillmentRules: FulfillmentRule[]
}

export type ProductTemplateRegistryDto = {
  registryVersion: 1
  templates: ProductTemplateDefinition[]
}

export type AttributeFieldError = {
  path: string
  message: string
}

export type FulfillmentStrategy =
  | { kind: 'inventory' }
  | { kind: 'fixed_text' }
  | { kind: 'fixed_url' }
  | { kind: 'fixed_file' }
  | { kind: 'manual' }
  | { kind: 'merchant_webhook' }
  | { kind: 'faka_bridge' }

export type FulfillmentOfferInput = {
  deliveryMode: string
  stockMode: string
  fixedContentType: string
  fixedContent: string | null
  fixedFileId: number | null
  deliveryFields: unknown
  autoProvision: boolean
  externalIntegration: string | null
  externalSku?: string | null
  fixedStructuredContent?: unknown
}

export type FulfillmentResolveResult =
  | { ok: true; strategy: FulfillmentStrategy }
  | { ok: false; code: 'FULFILLMENT_CONFIG_INVALID'; message: string }
