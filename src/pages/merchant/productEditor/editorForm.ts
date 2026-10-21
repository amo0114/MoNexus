import type { ProductEditorDto, ProductEditorImage } from '../../../api/catalog'
import {
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_VISIBILITY,
  TEMPLATE_KEYS,
  type ProductDetails,
  type ProductVisibility,
  type TemplateAttributes,
  type TemplateKey,
} from '../../../types/catalog'
import type { PurchaseFormField } from '../../../types/merchant'

export type EditorForm = {
  name: string
  categoryId: number | null
  description: string
  richDescription: string | null
  visibility: ProductVisibility
  attributes: TemplateAttributes
  details: ProductDetails
  purchaseForm: PurchaseFormField[]
  images: ProductEditorImage[]
}

export function emptyForm(): EditorForm {
  return {
    name: '',
    categoryId: null,
    description: '',
    richDescription: null,
    visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY,
    attributes: {},
    details: { ...EMPTY_PRODUCT_DETAILS },
    purchaseForm: [],
    images: [],
  }
}

export function formFromEditor(dto: ProductEditorDto): EditorForm {
  const visibility = dto.product.visibility === PRODUCT_VISIBILITY.PUBLIC
    ? PRODUCT_VISIBILITY.PUBLIC
    : PRODUCT_VISIBILITY.MEMBERS_ONLY
  return {
    name: dto.product.name ?? '',
    categoryId: typeof dto.product.categoryId === 'number' ? dto.product.categoryId : null,
    description: dto.product.description ?? '',
    richDescription: dto.product.richDescription,
    visibility,
    attributes: dto.product.attributes && typeof dto.product.attributes === 'object' ? dto.product.attributes : {},
    details: {
      ...EMPTY_PRODUCT_DETAILS,
      ...(dto.product.details ?? {}),
    },
    purchaseForm: parsePurchaseForm(dto.product.purchaseForm),
    images: Array.isArray(dto.product.images)
      ? dto.product.images.map(image => ({
          url: image.url,
          ref: image.ref ?? null,
        }))
      : [],
  }
}

function parsePurchaseForm(raw: unknown): PurchaseFormField[] {
  if (!Array.isArray(raw)) return []
  const fields: PurchaseFormField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.label !== 'string') continue
    const type = record.type === 'select' || record.type === 'date' ? record.type : 'text'
    const field: PurchaseFormField = {
      key: record.key,
      label: record.label,
      type,
      required: record.required === true,
    }
    if (typeof record.placeholder === 'string') field.placeholder = record.placeholder
    if (type === 'select' && Array.isArray(record.options)) {
      field.options = record.options.filter((option): option is string => typeof option === 'string')
    }
    if (type === 'date') {
      if (typeof record.minDaysAhead === 'number') field.minDaysAhead = record.minDaysAhead
      if (typeof record.maxDaysAhead === 'number') field.maxDaysAhead = record.maxDaysAhead
    }
    fields.push(field)
  }
  return fields
}

export function bindImageRefs(
  urls: string[],
  previous: ProductEditorImage[],
  keys?: Record<string, string>,
): ProductEditorImage[] {
  const unused = [...previous]
  return urls.map(url => {
    const index = unused.findIndex(image => image.url === url)
    const objectKey = keys?.[url]
    if (index >= 0) {
      const [found] = unused.splice(index, 1)
      if (!found.ref && objectKey) {
        return { url, ref: { kind: 'upload', objectKey } }
      }
      return found
    }
    if (objectKey) return { url, ref: { kind: 'upload', objectKey } }
    return { url, ref: null }
  })
}

export function writableImage(image: ProductEditorImage, keys?: Record<string, string>): boolean {
  return Boolean(image.ref) || image.url.startsWith('/assets/') || Boolean(keys?.[image.url])
}

export function isTemplateKey(value: string | null | undefined): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value)
}
