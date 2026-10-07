import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertNoSentinel, assertUnknownPreserved, collectKeyPaths } from '../../../__tests__/aiProjection.js'
import { getProductTemplateRegistry } from '../templates/registry.js'
import { buildProductDraftAiContext, MAX_DRAFT_CONTEXT } from './projection.js'
import { validateDraftSuggestion } from './validator.js'
import { DRAFT_SAMPLE_DESCRIPTION, sampleDraftOutput, grounded, RESUME_LAYOUT_DESCRIPTION } from './fixtures.js'
import { validateGroundedDraftCopy } from './copyGuard.js'
import { draftSuggestionRequestSchema } from './schema.js'

const templates = getProductTemplateRegistry().templates
function context(description = DRAFT_SAMPLE_DESCRIPTION) {
  return buildProductDraftAiContext({ description, templates, categories: [{ id: 1, label: '学习资料' }] })
}

describe('draft assistant projection and validation', () => {
  it('replays real sparse-brief output with useful detail and without invented service terms', () => {
    const raw = JSON.parse(readFileSync(new URL('./__fixtures__/resume-layout-v2.json', import.meta.url), 'utf8'))
    const { suggestion } = validateDraftSuggestion(raw, context(RESUME_LAYOUT_DESCRIPTION))
    expect(suggestion.description!.length).toBeGreaterThanOrEqual(40)
    expect(suggestion.introduction!.length).toBeGreaterThanOrEqual(180)
    expect(suggestion.introduction!.split('\n\n')).toHaveLength(4)
    expect(suggestion.introduction).toContain('适用于求职准备，基础版包含单份简历排版。')
    expect(suggestion.details.afterSalesInstructions).toBe('')
    expect(JSON.stringify(suggestion)).not.toMatch(/免费|修改|代写|润色|PDF|Word|DOCX|保证|原文未说明/)
  })

  it('allows richer paraphrased copy and distinct introduction sections supported by original text', () => {
    const output = sampleDraftOutput()
    output.templateKey = 'manual_service'
    output.name = '简历排版服务'
    output.productAttributes = []
    output.offerAttributes = []
    output.description = grounded('面向求职准备，围绕已有简历文字与版式进行整理，让简历的内容呈现更清楚、有条理，便于阅读和查看。', RESUME_LAYOUT_DESCRIPTION)
    output.introduction = [
      { section: 'content', ...grounded('服务围绕客户已有的简历材料展开，重点在于文字呈现与版式整理。', RESUME_LAYOUT_DESCRIPTION) },
      { section: 'scope', ...grounded('适用于求职准备，基础版包含单份简历排版。', RESUME_LAYOUT_DESCRIPTION) },
    ]
    output.details.highlights = [grounded('梳理已有文字与版式', RESUME_LAYOUT_DESCRIPTION)]
    output.details.usageInstructions = null
    const result = validateDraftSuggestion(output, context(RESUME_LAYOUT_DESCRIPTION))
    expect(result.suggestion.description).toBe(output.description.text)
    expect(result.suggestion.introduction).toContain('内容与服务\n服务围绕客户已有')
    expect(result.suggestion.introduction).toContain('套餐范围\n适用于求职准备')
    expect(result.suggestion.details.highlights).toEqual(['梳理已有文字与版式'])
    expect(result.suggestion.details.afterSalesInstructions).toBe('')
    expect(JSON.stringify(result)).not.toContain('sourceQuotes')
  })

  it.each(['含三次修改', '２４小时交付', '提供 PDF 和 Word 文件', '增加代写服务', '免费返工', '美国用户均可使用', '人工处理后立即到账', '保证拿到面试', '售价100积分', '<img src=x>', '联系 https://example.test'])('rejects unsupported expansion: %s', text => {
    expect(validateGroundedDraftCopy(grounded(text, RESUME_LAYOUT_DESCRIPTION), RESUME_LAYOUT_DESCRIPTION)).toBeNull()
  })

  it('cannot use a broad quote or a matching number to launder another service or package fact', () => {
    const source = '基础版包含3次排版。高级版包含5次排版。'
    expect(validateGroundedDraftCopy(grounded('基础版包含3次排版。', source), source)).toBe('基础版包含3次排版。')
    expect(validateGroundedDraftCopy(grounded('基础版包含5次排版。', source), source)).toBeNull()
    expect(validateGroundedDraftCopy(grounded('基础版包含3次排版。基础版包含5次排版。', source), source)).toBe('基础版包含3次排版。')
    expect(validateGroundedDraftCopy(grounded('基础版包含3次排版，3小时交付。', source), source)).toBeNull()
    expect(validateGroundedDraftCopy(grounded('包含3次排版', '不包含3次排版'), '不包含3次排版')).toBe('不包含3次排版')
  })

  it('restores a uniquely quoted complete scope sentence instead of losing its qualifier', () => {
    const copy = grounded('基础版包含单份简历排版。', RESUME_LAYOUT_DESCRIPTION)
    expect(validateGroundedDraftCopy(copy, RESUME_LAYOUT_DESCRIPTION)).toBe('适用于求职准备，基础版包含单份简历排版。')
    expect(validateGroundedDraftCopy(grounded('基础版包含单份简历排版，适用于求职准备。', RESUME_LAYOUT_DESCRIPTION), RESUME_LAYOUT_DESCRIPTION)).toBe('适用于求职准备，基础版包含单份简历排版。')
    const ambiguous = '活动期，基础版包含单份简历排版。非活动期，基础版包含单份简历排版。'
    expect(validateGroundedDraftCopy(grounded(copy.text, ambiguous), ambiguous)).toBeNull()
    const price = '售价100积分，基础版包含单份简历排版。'
    expect(validateGroundedDraftCopy(grounded(copy.text, price), price)).toBeNull()
  })

  it('keeps field limits after restoring a complete source sentence', () => {
    const source = `${DRAFT_SAMPLE_DESCRIPTION}在这些学习场景和适用范围均经过双方确认的情况下，且需要用户在指定范围内按要求使用，基础版包含单份资料。`
    const output = sampleDraftOutput()
    output.details.highlights = [grounded('基础版包含单份资料。', source)]
    const result = validateDraftSuggestion(output, context(source))
    expect(result.suggestion.details.highlights).toEqual([])
    expect(result.suggestion.name).toBe('网络入门学习指南')
  })

  it('keeps useful prose when a separate sentence invents terms, without copying those terms through', () => {
    const text = '围绕已有简历文字与版式进行整理，便于阅读。包含三次免费修改。适合求职准备。'
    expect(validateGroundedDraftCopy(grounded(text, RESUME_LAYOUT_DESCRIPTION), RESUME_LAYOUT_DESCRIPTION))
      .toBe('围绕已有简历文字与版式进行整理，便于阅读。适合求职准备。')
    expect(validateGroundedDraftCopy(grounded('便于阅读。不提供后续调整。文案不延伸为原文未说明的服务。', RESUME_LAYOUT_DESCRIPTION), RESUME_LAYOUT_DESCRIPTION)).toBe('便于阅读。')
  })

  it('rejects fabricated evidence and repeated section types without dropping safe sections', () => {
    expect(validateGroundedDraftCopy(grounded('整理已有文字', '没有出现的引用'), RESUME_LAYOUT_DESCRIPTION)).toBeNull()
    const output = sampleDraftOutput()
    output.introduction = [
      { section: 'content', ...grounded('便于入门学习时查找与阅读。', DRAFT_SAMPLE_DESCRIPTION) },
      { section: 'scope', ...grounded('含3次服务', DRAFT_SAMPLE_DESCRIPTION) },
      { section: 'overview', ...grounded('概念整理', DRAFT_SAMPLE_DESCRIPTION) },
      { section: 'overview', ...grounded('概念说明', DRAFT_SAMPLE_DESCRIPTION) },
    ]
    const result = validateDraftSuggestion(output, context())
    expect(result.suggestion.introduction).toBe('内容与服务\n便于入门学习时查找与阅读。')
    expect(result.rejectedFieldCount).toBe(3)
  })

  it('still requires exact extraction for parameters and policies even when prose can expand', () => {
    const output = sampleDraftOutput()
    output.details.afterSalesInstructions = '客户可以申请免费返工'
    output.productAttributes = [{ key: 'applicableScope', values: ['高级学习'] }]
    const result = validateDraftSuggestion(output, context())
    expect(result.suggestion.details.afterSalesInstructions).toBe('')
    expect(result.suggestion.attributes).toEqual({})
    expect(() => validateDraftSuggestion({ ...output, description: { text: '介绍', sourceQuotes: [] } }, context())).toThrow('structure')
  })

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
    output.description = grounded('支持全球，售价100积分')
    output.productAttributes.push({ key: 'apiKey', values: ['学习指引'] }, { key: 'contentCategory', values: ['入门学习'] })
    output.offerAttributes = [{ key: 'contentScope', values: ['编造内容'] }]
    const result = validateDraftSuggestion(output, context())
    expect(result.suggestion.categoryId).toBeNull()
    expect(result.suggestion.description).toBe(output.introduction[0].text)
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
      const result = validateDraftSuggestion({ ...sampleDraftOutput(), description: grounded(description) }, context(description))
      expect(result.suggestion.description).toBeNull()
    }
  })

  it('reuses only an accepted model overview when short copy is rejected', () => {
    const output = sampleDraftOutput()
    output.description = grounded('含三次免费修改', DRAFT_SAMPLE_DESCRIPTION)
    const result = validateDraftSuggestion(output, context())
    expect(result.suggestion.description).toBe(output.introduction[0].text)
    expect(result.suggestion.description).not.toContain('免费')
    output.introduction = []
    expect(validateDraftSuggestion(output, context()).suggestion.description).toBeNull()
  })

  it('refuses extra sensitive or business fields and malformed model output', () => {
    expect(draftSuggestionRequestSchema.safeParse({ description: '指南', fixedContent: 'secret' }).success).toBe(false)
    expect(draftSuggestionRequestSchema.safeParse({ description: 'x'.repeat(4001) }).success).toBe(false)
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), price: 1 }, context())).toThrow('structure')
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), name: 'x'.repeat(101) }, context())).toThrow('structure')
    expect(() => validateDraftSuggestion({ ...sampleDraftOutput(), details: null }, context())).toThrow('structure')
  })
})
