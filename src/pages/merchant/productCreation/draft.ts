import {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../../components/merchant/PurchaseFormFieldsEditor'
import { buildCreateProductV2Request, type DescriptionImageWriteRef } from '../../../api/catalog'
import type {
  FulfillmentConfiguration,
  ProductDetails,
  ProductTemplateDefinition,
  ProductVisibility,
  TemplateAttributes,
  TemplateKey,
} from '../../../types/catalog'
import type { DeliveryField, DeliveryMode, PurchaseFormField, StockMode } from '../../../types/merchant'

import {
  validateDeliveryFieldRows,
  serializeDeliveryFields,
  serializeStructuredContent,
  validateStructuredRows,
} from '../../../components/catalog/wizard/deliveryFields'
import {
  deliveryModeFor,
  matchedFulfillmentRule,
  structuredRequirementFor,
} from '../../../components/catalog/wizard/fulfillment'
import {
  DEFAULT_OFFER_NAME,
  type DeliverySelection,
  type ExtraOffer,
  type FixedContentType,
} from '../../../components/catalog/wizard/steps/wizardStepTypes'

export interface WizardForm {
  name: string
  /** 稳定分类 id；分类只影响展示/检索，绝不自动切 deliveryMode（D-CAT-05）。 */
  categoryId: number | null
  description: string
  richDescription: string | null
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: FixedContentType
  validityDays: string
  visibility: ProductVisibility
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}

export interface ProductCreationDraft {
  templateKey: TemplateKey | null
  selectedTemplate: ProductTemplateDefinition | null
  form: WizardForm
  productAttributes: TemplateAttributes
  productDetails: ProductDetails
  purchaseForm: PurchaseFormField[]
  primaryOfferName: string
  primaryOfferAttributes: TemplateAttributes
  extraOffers: ExtraOffer[]
  promoVideoAssetId?: string | null
  images: string[]
  imageKeys: Record<string, string>
  descriptionImages: DescriptionImageWriteRef[]
}

export function validateCreationStep(current: number, input: ProductCreationDraft): string | null {
  const { templateKey, selectedTemplate, form, purchaseForm, primaryOfferName, extraOffers, productAttributes } = input
  const allowedModes = selectedTemplate
    ? allowedDeliveryModes(allowedFulfillmentConfigurations(selectedTemplate, productAttributes))
    : []
  const primaryStructuredRequirement = selectedTemplate
    ? structuredRequirementFor(selectedTemplate, productAttributes, form.deliveryMode)
    : 'none'
  if (current === 0 && templateKey == null) return '请选择商品形态'
  if (current === 1) {
    if (!form.name.trim()) return '商品名称不能为空'
    if (form.categoryId == null) return '请选择商品分类'
    const formError = validatePurchaseFormFields(purchaseForm)
    if (formError) return formError
  }
  if (current === 2) {
    const price = Number(form.price)
    if (!Number.isInteger(price) || price <= 0) return '价格必须是大于 0 的整数'
    if (form.originalPrice.trim() !== '') {
      const original = Number(form.originalPrice)
      if (!Number.isInteger(original) || original <= 0) return '原价必须是大于 0 的整数'
      if (original < price) return '原价不能低于售价'
    }
    if (!primaryOfferName.trim()) return '主规格名称不能为空'
    if (form.validityDays.trim() !== '') {
      const days = Number(form.validityDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) return '有效期必须是 1-3650 的整数天数，留空为永久'
    }
    const names = new Set<string>([primaryOfferName.trim()])
    for (const [i, offer] of extraOffers.entries()) {
      const label = `第 ${i + 1} 个附加规格`
      if (!offer.name.trim()) return `${label}：名称不能为空`
      if (names.has(offer.name.trim())) return `${label}：名称与其他规格重复`
      names.add(offer.name.trim())
      const offerPrice = Number(offer.price)
      if (!Number.isInteger(offerPrice) || offerPrice <= 0) return `${label}：价格必须是大于 0 的整数`
      if (offer.originalPrice.trim() !== '') {
        const original = Number(offer.originalPrice)
        if (!Number.isInteger(original) || original < offerPrice) return `${label}：原价不能低于售价`
      }
      if (offer.validityDays.trim() !== '') {
        const days = Number(offer.validityDays)
        if (!Number.isInteger(days) || days < 1 || days > 3650) return `${label}：有效期必须是 1-3650 的整数天数，留空为永久`
      }
      const extraRequirement = selectedTemplate
        ? structuredRequirementFor(selectedTemplate, productAttributes, offer.deliveryMode)
        : 'none'
      if (extraRequirement === 'inventory_fields') {
        const fieldsError = validateDeliveryFieldRows(offer.deliveryFields, `${label}：`)
        if (fieldsError) return fieldsError
      }
      if (offer.deliveryMode === 'instant_fixed' && offer.fixedContentType !== 'file') {
        if (extraRequirement === 'fixed_fields') {
          const structuredError = validateStructuredRows(
            offer.structuredFields,
            offer.structuredValues,
            `${label}：`,
          )
          if (structuredError) return structuredError
        } else {
          if (!offer.fixedContent.trim()) return `${label}：固定内容交付必须填写交付内容`
          if (offer.fixedContentType === 'url' && !/^https?:\/\//i.test(offer.fixedContent.trim())) {
            return `${label}：链接必须以 http(s):// 开头`
          }
        }
      }
    }
  }
  if (current === 3) {
    if (!allowedModes.includes(form.deliveryMode)) return '当前交付方式与所选商品形态不匹配'
    if (primaryStructuredRequirement === 'inventory_fields') {
      const fieldsError = validateDeliveryFieldRows(form.deliveryFields, '')
      if (fieldsError) return fieldsError
    }
    if (form.deliveryMode === 'instant_fixed' && form.fixedContentType !== 'file') {
      if (primaryStructuredRequirement === 'fixed_fields') {
        const structuredError = validateStructuredRows(form.structuredFields, form.structuredValues, '')
        if (structuredError) return structuredError
      } else {
        if (!form.fixedContent.trim()) return '固定内容交付必须填写交付内容'
        if (form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
          return '链接必须以 http(s):// 开头'
        }
      }
    }
  }
  return null
}

export function buildProductDraftRequest(input: ProductCreationDraft & { templateKey: TemplateKey }) {
  const {
    templateKey, selectedTemplate, form, promoVideoAssetId, images, imageKeys, descriptionImages, productAttributes,
    productDetails, purchaseForm, primaryOfferName, primaryOfferAttributes, extraOffers,
  } = input
  function buildOfferInput(input: {
    name: string
    price: string
    originalPrice: string
    deliveryMode: DeliveryMode
    stockMode: StockMode
    validityDays: string
    fixedContent: string
    fixedContentType: FixedContentType
    attributes: TemplateAttributes
    deliveryFields: DeliveryField[]
    structuredFields: DeliveryField[]
    structuredValues: Record<string, string>
  }) {
    const requirement = selectedTemplate
      ? structuredRequirementFor(selectedTemplate, productAttributes, input.deliveryMode)
      : 'none'
    const structured = requirement === 'fixed_fields'
      ? serializeStructuredContent(input.structuredFields, input.structuredValues)
      : null
    return {
      name: input.name.trim(),
      price: Number(input.price),
      originalPrice: input.originalPrice.trim() === '' ? null : Number(input.originalPrice),
      attributes: input.attributes,
      deliveryMode: input.deliveryMode,
      stockMode: input.deliveryMode === 'instant_inventory' ? 'limited' as const : input.stockMode,
      validityDays: input.validityDays.trim() === '' ? null : Number(input.validityDays),
      fixedContentType: input.fixedContentType,
      fixedContent: structured ? null : input.fixedContent,
      // Draft file offers may omit a bind; never invent an id.
      fixedFileId: null,
      fixedStructuredContent: structured,
      deliveryFields: requirement === 'inventory_fields'
        ? serializeDeliveryFields(input.deliveryFields)
        : null,
    }
  }

  return buildCreateProductV2Request({
    templateKey,
    ...(promoVideoAssetId !== undefined ? { promoVideoAssetId } : {}),
    name: form.name.trim(),
    categoryId: form.categoryId ?? 0,
    description: form.description.trim(),
    richDescription: form.richDescription,
    images,
    imageKeys,
    descriptionImages,
    visibility: form.visibility,
    attributes: productAttributes,
    details: productDetails,
    purchaseForm: serializePurchaseFormFields(purchaseForm),
    offers: [
      buildOfferInput({
        name: primaryOfferName.trim() || DEFAULT_OFFER_NAME,
        price: form.price,
        originalPrice: form.originalPrice,
        deliveryMode: form.deliveryMode,
        stockMode: form.stockMode,
        validityDays: form.validityDays,
        fixedContent: form.fixedContent,
        fixedContentType: form.fixedContentType,
        attributes: primaryOfferAttributes,
        deliveryFields: form.deliveryFields,
        structuredFields: form.structuredFields,
        structuredValues: form.structuredValues,
      }),
      ...extraOffers.map(offer => buildOfferInput(offer)),
    ],
  })
}

export function allowedFulfillmentConfigurations(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentConfiguration[] {
  const matched = matchedFulfillmentRule(template, productAttributes)
  if (matched) return [...matched.configurations]
  const union = new Set<FulfillmentConfiguration>()
  for (const rule of template.fulfillmentRules) {
    for (const configuration of rule.configurations) union.add(configuration)
  }
  return [...union]
}

export function allowedDeliveryModes(configs: FulfillmentConfiguration[]): DeliveryMode[] {
  const modes: DeliveryMode[] = []
  const push = (mode: DeliveryMode) => { if (!modes.includes(mode)) modes.push(mode) }
  for (const config of configs) {
    const mode = deliveryModeFor(config)
    if (mode) push(mode)
  }
  return modes
}

export function allowedFixedContentTypes(configs: FulfillmentConfiguration[]): FixedContentType[] {
  const types: FixedContentType[] = []
  const push = (type: FixedContentType) => { if (!types.includes(type)) types.push(type) }
  for (const config of configs) {
    if (config === 'fixed_text') push('text')
    if (config === 'fixed_url') push('url')
    if (config === 'fixed_file') push('file')
  }
  return types
}

export function defaultDeliverySelection(configs: FulfillmentConfiguration[]): DeliverySelection {
  const first = configs[0]
  if (first === 'inventory') return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
  if (first === 'fixed_url') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'url' }
  if (first === 'fixed_file') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file' }
  if (first === 'fixed_text') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'text' }
  if (first) return { deliveryMode: 'manual_service', stockMode: 'unlimited', fixedContentType: 'text' }
  return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
}

export function coerceDeliverySelection(current: DeliverySelection, configs: FulfillmentConfiguration[]): DeliverySelection {
  const modes = allowedDeliveryModes(configs)
  const types = allowedFixedContentTypes(configs)
  if (!modes.includes(current.deliveryMode)) return defaultDeliverySelection(configs)
  if (current.deliveryMode === 'instant_inventory') {
    return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
  }
  if (current.deliveryMode === 'instant_fixed') {
    const fixedContentType = types.includes(current.fixedContentType) ? current.fixedContentType : (types[0] ?? 'text')
    return { deliveryMode: 'instant_fixed', stockMode: current.stockMode, fixedContentType }
  }
  return { deliveryMode: current.deliveryMode, stockMode: current.stockMode, fixedContentType: 'text' }
}

export function createEmptyExtraOffer(form: Pick<WizardForm, 'deliveryMode' | 'stockMode' | 'fixedContentType'>): ExtraOffer {
  const deliveryMode = form.deliveryMode
  return {
    name: '',
    price: '',
    originalPrice: '',
    deliveryMode,
    stockMode: deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode,
    fixedContent: '',
    fixedContentType: form.fixedContentType,
    validityDays: '',
    attributes: {},
    deliveryFields: [],
    structuredFields: [],
    structuredValues: {},
  }
}
