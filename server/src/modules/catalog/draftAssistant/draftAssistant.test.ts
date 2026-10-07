import { describe, expect, it } from 'vitest'
import { assertNoSentinel, assertUnknownPreserved, collectKeyPaths } from '../../../__tests__/aiProjection.js'
import { getProductTemplateRegistry } from '../templates/registry.js'
import { buildProductDraftAiContext, MAX_DRAFT_CONTEXT } from './projection.js'
import { validateDraftSuggestion } from './validator.js'
import { DRAFT_SAMPLE_DESCRIPTION, sampleDraftOutput } from './fixtures.js'
import { draftSuggestionRequestSchema } from './schema.js'

const templates = getProductTemplateRegistry().templates
function context(description = DRAFT_SAMPLE_DESCRIPTION) {
  return buildProductDraftAiContext({ description, templates, categories: [{ id: 1, label: '学习资料' }] })
}

describe('draft assistant projection and validation', () => {
  it('projects only the governed catalog and dedicated public text, retaining unknown product facts', () => {
    const input = {
      description: DRAFT_SAMPLE_DESCRIPTION, templates: templates.map(template => ({ ...template, secret: 'SENTINEL_TEMPLATE' })),
      categories: [{ id: 1, label: '学习资料', email: 'SENTINEL_EMAIL' }],
      fixedContent: 'SENTINEL_PAID_CONTENT', apiKey: 'SENTINEL_KEY', merchantId: 88,
    }
    const projected = buildProductDraftAiContext(input)
    assertNoSentinel(projected, ['SENTINEL_TEMPLATE', 'SENTINEL_EMAIL', 'SENTINEL_PAID_CONTENT', 'SENTINEL_KEY'])
    assertUnknownPreserved(projected)
    expect(projected.facts.product).toBeNull()
    expect(collectKeyPaths(projected)).toEqual([
      'declared', 'facts', 'facts.categories', 'facts.categories[].id', 'facts.categories[].label', 'facts.product',
      'facts.templates', 'facts.templates[].key', 'facts.templates[].label',
      ...['offerFields', 'productFields'].flatMap(field => [
        `facts.templates[].${field}`, `facts.templates[].${field}[].key`, `facts.templates[].${field}[].label`,
        `facts.templates[].${field}[].options`,
        ...(field === 'productFields' ? [`facts.templates[].${field}[].options[].label`, `facts.templates[].${field}[].options[].value`] : []),
        `facts.templates[].${field}[].type`,
      ]), 'truncated', 'untrusted', 'untrusted.description',
    ].sort())
  })

  it('truncates public text and fails closed when the governed directory alone is oversized', () => {
    const projected = context('公开介绍'.repeat(3000))
    expect(projected.truncated).toBe(true)
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(MAX_DRAFT_CONTEXT)
    expect(() => buildProductDraftAiContext({ description: '指南', templates, categories: [{ id: 1, label: '类'.repeat(MAX_DRAFT_CONTEXT) }] }))
      .toThrow('商品信息或目录过多')
  })

  it('extracts supported attributes and preserves absent policies as empty', () => {
    const result = validateDraftSuggestion(sampleDraftOutput(), context())
    expect(result.suggestion).toMatchObject({ templateKey: 'fixed_content', name: '网络入门学习指南', categoryId: 1,
      attributes: { contentCategory: '学习指引', applicableScope: '入门学习' }, offerAttributes: { contentScope: '完整文字指引' },
      details: { purchaseNotes: '', afterSalesInstructions: '' } })
    expect(result.missingFields).toEqual([])
    expect(result.rejectedFieldCount).toBe(0)
  })

  it('drops fabricated text, unknown catalogs and unsupported or repeated attribute keys', () => {
    const output = sampleDraftOutput(999)
    output.description = '支持全球，售价100积分'
    output.productAttributes.push({ key: 'apiKey', values: ['学习指引'] }, { key: 'contentCategory', values: ['入门学习'] })
    output.offerAttributes = [{ key: 'contentScope', values: ['编造内容'] }]
    const result = validateDraftSuggestion(output, context())
    expect(result.suggestion.categoryId).toBeNull()
    expect(result.suggestion.description).toBeNull()
    expect(result.suggestion.attributes).toEqual({ applicableScope: '入门学习' })
    expect(result.suggestion.offerAttributes).toEqual({})
    expect(result.rejectedFieldCount).toBeGreaterThan(0)
    expect(validateDraftSuggestion({ ...output, templateKey: 'invented' }, context()).suggestion.templateKey).toBeNull()
  })

  it('does not turn part of a number into a different numeric parameter', () => {
    const output = { ...sampleDraftOutput(), templateKey: 'appointment', productAttributes: [], offerAttributes: [{ key: 'estimatedMinutes', values: ['30'] }] }
    for (const description of ['服务时长130分钟', '服务时长30.5分钟', '服务时长-30分钟']) {
      expect(validateDraftSuggestion(output, context(description)).suggestion.offerAttributes).toEqual({})
    }
    expect(validateDraftSuggestion(output, context('服务时长130分钟，另有30分钟套餐')).suggestion.offerAttributes).toEqual({ estimatedMinutes: 30 })
  })

  it('maps only original enum labels and rejects out-of-range numeric fields', () => {
    const template = templates.find(item => item.key === 'account')!
    const label = template.ui.enumLabels?.accessModel?.shared ?? 'shared'
    const output = { ...sampleDraftOutput(), templateKey: 'account', productAttributes: [{ key: 'accessModel', values: [label] }], offerAttributes: [] }
    expect(validateDraftSuggestion(output, context(label)).suggestion.attributes).toEqual({ accessModel: 'shared' })
    expect(validateDraftSuggestion(output, context('独享')).suggestion.attributes).toEqual({})
    expect(validateDraftSuggestion({ ...output, templateKey: 'appointment', offerAttributes: [{ key: 'estimatedMinutes', values: ['999999'] }] }, context('999999分钟')).suggestion.offerAttributes).toEqual({})
  })

  it('rejects copied prices, promises and markup even when present in the source', () => {
    for (const description of ['售价100积分', '永久有效', '保证退款', '<script>alert(1)</script>', 'https://example.com']) {
      const result = validateDraftSuggestion({ ...sampleDraftOutput(), description }, context(description))
      expect(result.suggestion.description).toBeNull()
    }
  })

  it('refuses extra sensitive or business fields and malformed model output', () => {
    expect(draftSuggestionRequestSchema.safeParse({ description: '指南', fixedContent: 'secret' }).success).toBe(false)
    expect(draftSuggestionRequestSchema.safeParse({ description: 'x'.repeat(4001) }).success).toBe(false)
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), price: 1 }, context())).toThrow('structure')
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), name: 'x'.repeat(101) }, context())).toThrow('structure')
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), details: null }, context())).toThrow('structure')
  })
})
