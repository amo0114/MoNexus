import { describe, expect, it } from 'vitest'
import { resolveEditorFocus } from './editorFocus'

const base = {
  focus: null, focusProvided: false, offerId: null, offerIdProvided: false,
  offerIds: [11, 12], hasAttributes: true, canShowOffers: true,
} as const

describe('resolveEditorFocus', () => {
  it.each([
    ['publication', 'publication-checklist', true],
    ['images', 'product-images-uploader', false],
    ['purchase-notes', 'product-details-purchaseNotes', false],
    ['after-sales', 'product-details-afterSalesInstructions', false],
    ['attributes', 'product-edit-attributes', false],
    ['category', 'product-category-field', false],
    ['offers', 'product-edit-offers', false],
  ] as const)('maps %s to its closed anchor', (focus, anchor, inPreview) => {
    const resolved = resolveEditorFocus({ ...base, focus, focusProvided: true })
    expect(resolved.anchor).toBe(anchor)
    expect(resolved.inPreview).toBe(inPreview)
  })

  it('targets the exact offer when it belongs to the product', () => {
    expect(resolveEditorFocus({ ...base, focus: 'offers', focusProvided: true, offerId: 12, offerIdProvided: true }).anchor)
      .toBe('product-edit-offer-12')
  })

  it('falls back to the publication checklist for a foreign or malformed offer', () => {
    for (const offerId of [99, null]) {
      const resolved = resolveEditorFocus({ ...base, focus: 'offers', focusProvided: true, offerId, offerIdProvided: true })
      expect(resolved.anchor).toBe('publication-checklist')
      expect(resolved.notice).toContain('目标规格不可用')
    }
  })

  it('falls back for an unknown focus value', () => {
    const resolved = resolveEditorFocus({ ...base, focus: null, focusProvided: true })
    expect(resolved.anchor).toBe('publication-checklist')
    expect(resolved.notice).toContain('未识别')
  })

  it('falls back when the target section is not rendered', () => {
    expect(resolveEditorFocus({ ...base, focus: 'attributes', focusProvided: true, hasAttributes: false }).anchor).toBe('publication-checklist')
    expect(resolveEditorFocus({ ...base, focus: 'offers', focusProvided: true, canShowOffers: false }).anchor).toBe('publication-checklist')
  })

  it('tells the merchant to change category or contact the platform', () => {
    expect(resolveEditorFocus({ ...base, focus: 'category', focusProvided: true }).notice).toContain('更换分类或联系平台')
  })
})
