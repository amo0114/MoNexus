import type { EditorFocus } from '../../../api/merchant/workbench'

// SPEC-MERCHANT-WORKBENCH-001 §8.1 — closed focus targets for the product
// editor. Anchors come only from this table (or a validated offer id); the
// URL never supplies a selector, field path, HTML or script.

const FOCUS_ANCHORS: Record<Exclude<EditorFocus, 'offers'>, string> = {
  publication: 'publication-checklist',
  images: 'product-images-uploader',
  'purchase-notes': 'product-details-purchaseNotes',
  'after-sales': 'product-details-afterSalesInstructions',
  attributes: 'product-edit-attributes',
  category: 'product-category-field',
}

const FOCUS_LABELS: Record<EditorFocus, string> = {
  publication: '发布检查',
  images: '商品封面',
  'purchase-notes': '购买须知',
  'after-sales': '售后说明',
  attributes: '商品参数',
  offers: '规格',
  category: '商品分类',
}

export type ResolvedEditorFocus = {
  anchor: string
  /** The publication checklist lives in the preview column on narrow screens. */
  inPreview: boolean
  notice: string
}

export function resolveEditorFocus(input: {
  focus: EditorFocus | null
  focusProvided: boolean
  offerId: number | null
  offerIdProvided: boolean
  offerIds: readonly number[]
  hasAttributes: boolean
  canShowOffers: boolean
}): ResolvedEditorFocus {
  const fallback = (reason: string): ResolvedEditorFocus => ({
    anchor: FOCUS_ANCHORS.publication, inPreview: true, notice: `${reason}，已显示发布检查。`,
  })
  const focus = input.focus ?? (input.focusProvided ? null : 'publication')
  if (focus == null) return fallback('未识别的定位目标')

  if (focus === 'offers') {
    if (!input.canShowOffers) return fallback('当前无法在本页查看规格')
    if (input.offerIdProvided) {
      if (input.offerId == null || !input.offerIds.includes(input.offerId)) return fallback('目标规格不可用')
      return { anchor: `product-edit-offer-${input.offerId}`, inPreview: false, notice: '已定位到对应规格。' }
    }
    return { anchor: 'product-edit-offers', inPreview: false, notice: '已定位到规格。' }
  }
  if (focus === 'attributes' && !input.hasAttributes) return fallback('商品参数区暂不可用')

  const notice = focus === 'category'
    ? '已定位到商品分类。如分类已停用，请更换分类或联系平台。'
    : `已定位到${FOCUS_LABELS[focus]}。`
  return { anchor: FOCUS_ANCHORS[focus], inPreview: focus === 'publication', notice }
}

/** Scroll to and focus the anchor; returns false when it is not rendered. */
export function focusEditorAnchor(anchor: string): boolean {
  const element = document.querySelector<HTMLElement>(`[data-testid="${anchor}"]`)
  if (!element) return false
  element.scrollIntoView?.({ block: 'center' })
  const focusable = element.matches('input, textarea, select, button')
    ? element
    : element.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, button')
  if (focusable) {
    focusable.focus({ preventScroll: true })
  } else {
    element.tabIndex = -1
    element.focus({ preventScroll: true })
  }
  return true
}
