import { describe, expect, it } from 'vitest'
import type { ProductDraftSuggestion } from '../../api/productDraftAssistant'
import { EMPTY_PRODUCT_DETAILS } from '../../types/catalog'
import { getDraftChanges } from './productDraftReview'

const current: ProductDraftSuggestion = {
  name: '商品', description: '人工修改的介绍', templateKey: 'fixed_content', categoryId: 1, offerName: '标准版',
  attributes: { scope: '学习', language: '中文' }, offerAttributes: { devices: 1 },
  details: { ...EMPTY_PRODUCT_DETAILS, faq: [{ question: '问题', answer: '人工回答' }] },
}

describe('draft revision boundaries', () => {
  it('applies selected attribute changes independently and keeps human FAQ and unselected text', () => {
    const candidate = { ...current, description: null, attributes: { scope: '入门', language: '英文' }, details: EMPTY_PRODUCT_DETAILS }
    const changes = getDraftChanges(current, candidate, [], [])
    expect(changes.map(item => item.key)).not.toContain('details.faq')
    const next = changes.find(item => item.key === 'attributes.scope')!.apply(current)
    expect(next).toMatchObject({ description: '人工修改的介绍', attributes: { scope: '入门', language: '中文' }, details: { faq: current.details.faq } })
    expect(current.attributes.scope).toBe('学习')
  })

  it('makes removing a previously filled field an explicit selectable change', () => {
    const candidate = { ...current, attributes: { scope: '学习' } }
    const change = getDraftChanges(current, candidate, [], []).find(item => item.key === 'attributes.language')!
    expect(change.before).toBe('中文')
    expect(change.after).toBe('未填写')
    expect(change.apply(current).attributes).toEqual({ scope: '学习' })
  })
})
