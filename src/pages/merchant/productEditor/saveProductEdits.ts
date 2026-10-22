import {
  mapEditorImagesToWriteRefs,
  type CatalogAdapter,
  type DescriptionImageWriteRef,
  type ProductEditorActor,
  type ProductEditorDto,
  type ProductEditorOffer,
} from '../../../api/catalog'
import { getApiErrorCode } from '../../../api/error'
import { updateMerchantOffer } from '../../../api/merchant'
import { CATALOG_ERROR_CODES, type ProductTemplateDefinition, type TemplateKey } from '../../../types/catalog'
import type { OfferWriteRequest } from '../../../types/merchant'
import {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../../components/merchant/PurchaseFormFieldsEditor'
import {
  serializeDeliveryFields,
  serializeStructuredContent,
  validateDeliveryFieldRows,
  validateStructuredRows,
} from '../../../components/catalog/wizard/deliveryFields'
import {
  draftsFromOffers,
  reconcileOfferDrafts,
  cloneOfferStructuredDraft,
  type OfferStructuredDraft,
} from './offerDrafts'
import {
  offerStructuredRequirement,
  shouldEditDeliveryFields,
  shouldEditStructuredContent,
} from './offerRequirements'
import type { EditorForm } from './editorForm'

export interface ProductEditSaveInput {
  adapter: CatalogAdapter
  actor: ProductEditorActor
  productId: number
  form: EditorForm
  contentVersion: number
  baseline: string
  templateKey: TemplateKey | null
  savedTemplateKey: TemplateKey | null
  selectedTemplate: ProductTemplateDefinition | null
  imageKeys: Record<string, string>
  descriptionImages: DescriptionImageWriteRef[]
  descriptionImagesTouched: boolean
  offers: ProductEditorOffer[]
  offerDrafts: Record<number, OfferStructuredDraft>
  offerDraftsBaseline: string
  offerStructuredDirty: boolean
}

type SaveProgress = {
  onContentSaved: (contentVersion: number, assigningTemplate: boolean) => void
  onOffersSaved: (offers: ProductEditorOffer[], baseline: string) => void
}

type SaveResult = { kind: 'saved' } | {
  kind: 'conflict'
  code: string
  recovery: {
    editor: ProductEditorDto
    drafts: Record<number, OfferStructuredDraft>
    conflictLabels: string[]
  } | null
}

export function validateProductEdits(input: ProductEditSaveInput): string | null {
  const { form, actor, offerStructuredDirty, offers, offerDrafts, selectedTemplate } = input
  if (!form.name.trim()) {
    return '请填写商品名称'
  }
  if (form.categoryId == null) {
    return '请选择商品分类'
  }
  const formError = validatePurchaseFormFields(form.purchaseForm)
  if (formError) {
    return formError
  }
  if (actor === 'merchant' && offerStructuredDirty) {
    for (const offer of offers) {
      const draft = offerDrafts[offer.id]
      if (!draft) continue
      const requirement = offerStructuredRequirement(offer, selectedTemplate, form.attributes)
      const showDeliveryFields = shouldEditDeliveryFields(offer, requirement)
      const showStructured = shouldEditStructuredContent(offer, requirement)
      if (showDeliveryFields) {
        const fieldsError = validateDeliveryFieldRows(draft.deliveryFields, `规格「${offer.name}」`)
        if (fieldsError) {
          return fieldsError
        }
      }
      if (showStructured) {
        const structuredError = validateStructuredRows(
          draft.structuredFields,
          draft.structuredValues,
          `规格「${offer.name}」`,
        )
        if (structuredError) {
          return structuredError
        }
      }
    }
  }

  return null
}

/** Save content before offers and report each successful write immediately.
 * The progress callbacks retain the new baseline if a later offer fails. */
export async function saveProductEdits(
  input: ProductEditSaveInput,
  { onContentSaved, onOffersSaved }: SaveProgress,
): Promise<SaveResult> {
  const {
    adapter, actor, productId, form, contentVersion, baseline, templateKey, savedTemplateKey,
    selectedTemplate, imageKeys, descriptionImages, descriptionImagesTouched, offers,
    offerDrafts, offerDraftsBaseline, offerStructuredDirty,
  } = input
  let workingOffers = offers
  const workingDrafts = offerDrafts
  let workingBaseline: Record<number, OfferStructuredDraft> = offerDraftsBaseline !== ''
    ? JSON.parse(offerDraftsBaseline) as Record<number, OfferStructuredDraft>
    : draftsFromOffers(offers)
  try {
    const contentDirty = (baseline !== '' && JSON.stringify(form) !== baseline)
      || descriptionImagesTouched
      || templateKey !== savedTemplateKey
    if (contentDirty) {
      const imageRefs = mapEditorImagesToWriteRefs(form.images, imageKeys)
      const assigningTemplate = savedTemplateKey == null && templateKey != null
      const result = await adapter.patchContent(actor, productId, {
        expectedContentVersion: contentVersion,
        ...(form.promoVideo !== undefined ? { promoVideoAssetId: form.promoVideo?.assetId ?? null } : {}),
        name: form.name.trim(),
        categoryId: form.categoryId!,
        description: form.description,
        richDescription: form.richDescription,
        visibility: form.visibility,
        details: form.details,
        purchaseForm: serializePurchaseFormFields(form.purchaseForm),
        ...(templateKey ? { attributes: form.attributes } : {}),
        ...(assigningTemplate && templateKey
          ? { templateKey, templateVersion: 1 as const }
          : {}),
        ...(imageRefs ? { images: imageRefs } : {}),
        // Sanitizer allowlist: omit descriptionImages with richDescription => strip imgs.
        descriptionImages,
      })
      onContentSaved(result.contentVersion, assigningTemplate)
    }
    if (actor === 'merchant' && offerStructuredDirty) {
      for (const offer of workingOffers) {
        const draft = workingDrafts[offer.id]
        const baselineDraft = workingBaseline[offer.id]
        if (!draft || JSON.stringify(draft) === JSON.stringify(baselineDraft)) continue
        const requirement = offerStructuredRequirement(offer, selectedTemplate, form.attributes)
        const payload: OfferWriteRequest & { fixedStructuredContent?: unknown | null } = {}
        if (shouldEditDeliveryFields(offer, requirement)) {
          payload.deliveryFields = serializeDeliveryFields(draft.deliveryFields)
        }
        if (shouldEditStructuredContent(offer, requirement)) {
          payload.fixedStructuredContent = serializeStructuredContent(
            draft.structuredFields,
            draft.structuredValues,
          )
          payload.fixedContent = null
        }
        if (Object.keys(payload).length === 0) continue
        if (typeof offer.checkoutVersion === 'string') {
          payload.expectedCheckoutVersion = offer.checkoutVersion
        }
        const updated = await updateMerchantOffer(productId, offer.id, payload)
        const nextOffer: ProductEditorOffer = {
          ...offer,
          ...('deliveryFields' in payload ? { deliveryFields: payload.deliveryFields ?? null } : {}),
          ...('fixedStructuredContent' in payload
            ? { fixedStructuredContent: payload.fixedStructuredContent }
            : {}),
          ...(typeof updated.checkoutVersion === 'string'
            ? { checkoutVersion: updated.checkoutVersion }
            : {}),
        }
        workingOffers = workingOffers.map(item => (item.id === offer.id ? nextOffer : item))
        workingBaseline = {
          ...workingBaseline,
          [offer.id]: cloneOfferStructuredDraft(draft),
        }
        onOffersSaved(workingOffers, JSON.stringify(workingBaseline))
      }
      onOffersSaved(workingOffers, JSON.stringify(workingBaseline))
    }
    return { kind: 'saved' }
  } catch (err) {
    const code = getApiErrorCode(err)
    if (code !== CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED && code !== 'CHECKOUT_CHANGED') throw err
    try {
      const fresh = await adapter.getEditor(actor, productId)
      const reconciled = reconcileOfferDrafts(
        workingDrafts,
        workingOffers,
        fresh.offers,
        (offer) => offerStructuredRequirement(offer, selectedTemplate, form.attributes),
      )
      return { kind: 'conflict', code, recovery: { editor: fresh, ...reconciled } }
    } catch {
      return { kind: 'conflict', code, recovery: null }
    }
  }
}
