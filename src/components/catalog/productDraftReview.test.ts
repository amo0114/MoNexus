import { describe, expect, it } from 'vitest'
import type { ProductDraftSuggestion } from '../../api/productDraftAssistant'
import { EMPTY_PRODUCT_DETAILS } from '../../types/catalog'
import { draftIntroductionHtml, getDraftChanges } from './productDraftReview'

const current: ProductDraftSuggestion = {
  name: '商品', description: '人工修改的介绍', introduction: null, templateKey: 'fixed_content', categoryId: 1, offerName: '标准版',
  attributes: { scope: '学习', language: '中文' }, offerAttributes: { devices: 1 },
  details: { ...EMPTY_PRODUCT_DETAILS, faq: [{ question: '问题', answer: '人工回答' }] },
}

describe('draft revision boundaries', () => {
  it('preserves paragraphs while escaping all user-editable HTML before saving', () => {
    expect(draftIntroductionHtml('服务介绍\n排版 & 整理\n\n<script>alert("x")</script>')).toBe('<p>服务介绍<br>排版 &amp; 整理</p><p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>')
    expect(draftIntroductionHtml('  ')).toBeNull()
  })

  it('lets users adopt detailed copy independently of their edited short description', () => {
    const next = { ...current, description: '新的短简介', introduction: '详细商品介绍\n更完整的内容' }
    const changes = getDraftChanges(current, next, [], [])
    const result = changes.find(item => item.key === 'introduction')!.apply(current)
    expect(result.description).toBe(current.description)
    expect(result.introduction).toBe(next.introduction)
  })

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
