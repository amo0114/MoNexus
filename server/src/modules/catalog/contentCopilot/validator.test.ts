import { describe, expect, it } from 'vitest'
import { COPILOT_FIXTURES, domainInput, offer, output, unit } from './__fixtures__/fixtures.js'
import { MAX_MODEL_ISSUES } from './constants.js'
import { buildProductContentAiContext } from './projection.js'
import { ModelOutputInvalidError, countIssues, suggestedFieldCount, validateModelOutput } from './validator.js'

const recordedCases = COPILOT_FIXTURES.flatMap(fixture =>
  fixture.recorded.map(recorded => ({ fixture, recorded })))

describe('content copilot validator — recorded outputs (L2.5, SPEC-AI-PRODUCT-001 §11.2)', () => {
  it.each(recordedCases.map(item => [`${item.fixture.id}: ${item.recorded.label}`, item] as const))(
    '%s',
    (_name, { fixture, recorded }) => {
      const context = buildProductContentAiContext(fixture.input)
      const result = validateModelOutput({
        raw: recorded.output,
        context,
        readinessCodes: fixture.readinessCodes,
        upstreamRequested: fixture.input.useUpstreamDescription,
      })
      for (const [field, status] of Object.entries(recorded.expectFields)) {
        expect(result.fields[field as keyof typeof result.fields]?.status, field).toBe(status)
      }
      const outputSideKinds = new Set(
        result.issues
          .filter(issue => issue.origin === 'validator' && issue.kind !== 'missing' && issue.field != null)
          .map(issue => issue.kind),
      )
      for (const kind of recorded.expectIssueKinds ?? []) {
        expect(outputSideKinds.has(kind), kind).toBe(true)
      }
      for (const suggestion of Object.values(result.fields)) {
        if (suggestion?.status !== 'suggested') continue
        const text = JSON.stringify(suggestion.value)
        for (const forbidden of fixture.forbiddenInSuggestions) {
          expect(text.includes(forbidden), `suggested text contains ${forbidden}`).toBe(false)
        }
      }
    },
  )
})

describe('content copilot validator — contract', () => {
  const context = buildProductContentAiContext(domainInput('redemption_code', {
    attributes: { serviceName: '示例软件', redemptionMethod: '在兑换入口输入卡密。' },
    offers: [offer({ id: 1, attributes: { unitLabel: '1 个兑换码' } })],
  }))

  it('rejects structurally invalid output as a whole', () => {
    expect(() => validateModelOutput({ raw: { description: 'x' }, context, readinessCodes: [], upstreamRequested: false }))
      .toThrow(ModelOutputInvalidError)
    expect(() => validateModelOutput({
      raw: { ...output({}), extra: true },
      context,
      readinessCodes: [],
      upstreamRequested: false,
    })).toThrow(ModelOutputInvalidError)
  })

  it('drops values for fields outside targetFields', () => {
    const narrow = buildProductContentAiContext(domainInput('redemption_code', { targetFields: ['faq'] }))
    const result = validateModelOutput({
      raw: output({ description: unit('简介'), faq: [{ question: '怎么兑换？', answer: '在兑换入口输入卡密。', claims: [] }] }),
      context: narrow,
      readinessCodes: [],
      upstreamRequested: false,
    })
    expect(Object.keys(result.fields)).toEqual(['faq'])
    expect(result.fields.faq?.status).toBe('suggested')
  })

  it('rejects over-length units and counts list items beyond the AI limit', () => {
    const result = validateModelOutput({
      raw: output({
        description: unit('长'.repeat(301)),
        highlights: ['一', '二', '三', '四', '五'].map(text => unit(`亮点${text}`)),
      }),
      context,
      readinessCodes: [],
      upstreamRequested: false,
    })
    expect(result.fields.description).toEqual({ status: 'rejected', value: null, rejectedItemCount: 1 })
    expect(result.fields.highlights).toEqual({
      status: 'suggested',
      value: ['亮点一', '亮点二', '亮点三', '亮点四'],
      rejectedItemCount: 1,
    })
    expect(suggestedFieldCount(result.fields)).toBe(1)
  })

  it('rejects claims whose span is not in the text', () => {
    const result = validateModelOutput({
      raw: output({ description: unit('兑换码简介。', [{ kind: 'duration', span: '30 天', factRef: 'offers[0].validity' }]) }),
      context,
      readinessCodes: [],
      upstreamRequested: false,
    })
    expect(result.fields.description?.status).toBe('rejected')
  })

  it('does not let a verified claim cover other hard facts inside its span', () => {
    const days30 = buildProductContentAiContext(domainInput('subscription', {
      attributes: { serviceName: '示例订阅', serviceScope: '订阅服务' },
      offers: [offer({ id: 1, deliveryMode: 'manual_service', validityDays: 30, attributes: { entitlementSummary: '基础套餐' } })],
    }))
    const result = validateModelOutput({
      raw: output({
        description: unit('有效期30天，售价1积分，支持美国', [
          { kind: 'duration', span: '有效期30天，售价1积分，支持美国', factRef: 'offers[0].validity' },
        ]),
      }),
      context: days30,
      readinessCodes: [],
      upstreamRequested: false,
    })
    expect(result.fields.description?.status).toBe('rejected')
    expect(result.issues.some(issue => issue.kind === 'unsupported_fact' && issue.field === 'description')).toBe(true)
  })

  it('checks offer attribution at every occurrence of a repeated span', () => {
    const twoPlans = buildProductContentAiContext(domainInput('subscription', {
      attributes: { serviceName: '示例订阅', serviceScope: '订阅服务' },
      offers: [
        offer({ id: 1, name: '月套餐', deliveryMode: 'manual_service', validityDays: 30, attributes: { entitlementSummary: '月' } }),
        offer({ id: 2, name: '年套餐', deliveryMode: 'manual_service', validityDays: 365, attributes: { entitlementSummary: '年' } }),
      ],
    }))
    const result = validateModelOutput({
      raw: output({
        description: unit('月套餐有效期30天。年套餐有效期30天。', [
          { kind: 'duration', span: '30天', factRef: 'offers[0].validity' },
        ]),
      }),
      context: twoPlans,
      readinessCodes: [],
      upstreamRequested: false,
    })
    expect(result.fields.description?.status).toBe('rejected')
  })

  describe('per-mention verification (review of dbc8b58)', () => {
    const singleManual30 = buildProductContentAiContext(domainInput('subscription', {
      attributes: { serviceName: '示例订阅', serviceScope: '订阅服务' },
      offers: [offer({ id: 1, deliveryMode: 'manual_service', validityDays: 30, attributes: { entitlementSummary: '基础套餐' } })],
    }))
    const run = (ctx: typeof singleManual30, raw: ReturnType<typeof output>) =>
      validateModelOutput({ raw, context: ctx, readinessCodes: [], upstreamRequested: false })

    it('a duration claim does not vouch for a second, unmatched duration in its span', () => {
      const result = run(singleManual30, output({
        description: unit('有效期30天，5分钟内完成交付', [
          { kind: 'duration', span: '有效期30天，5分钟内完成交付', factRef: 'offers[0].validity' },
        ]),
      }))
      expect(result.fields.description?.status).toBe('rejected')
    })

    it('a manual delivery claim does not vouch for timing words', () => {
      const result = run(singleManual30, output({
        description: unit('人工处理，秒到', [
          { kind: 'delivery_method', span: '人工处理，秒到', factRef: 'offers[0].deliveryMethod' },
        ]),
      }))
      expect(result.fields.description?.status).toBe('rejected')
    })

    it('rejects delivery wording that no claim verified', () => {
      expect(run(singleManual30, output({ description: unit('由商家人工处理。') })).fields.description?.status).toBe('rejected')
      expect(run(singleManual30, output({
        description: unit('由商家人工处理。', [{ kind: 'delivery_method', span: '商家人工处理', factRef: 'offers[0].deliveryMethod' }]),
      })).fields.description?.status).toBe('suggested')
    })

    const mixed = buildProductContentAiContext(domainInput('subscription', {
      attributes: { serviceName: '示例订阅', serviceScope: '订阅服务' },
      offers: [
        offer({ id: 1, name: '人工套餐', deliveryMode: 'manual_service', validityDays: 30, attributes: { entitlementSummary: '人工' } }),
        offer({ id: 2, name: '自动套餐', deliveryMode: 'instant_inventory', validityDays: 30, attributes: { entitlementSummary: '自动' } }),
      ],
    }))

    it('rejects a repeated span whose second occurrence belongs to another offer', () => {
      const result = run(mixed, output({
        description: unit('人工套餐由商家人工处理。自动套餐由商家人工处理。', [
          { kind: 'delivery_method', span: '商家人工处理', factRef: 'offers[0].deliveryMethod' },
        ]),
      }))
      expect(result.fields.description?.status).toBe('rejected')
      expect(result.issues.some(issue => issue.kind === 'ambiguous')).toBe(true)
    })

    it('accepts identical words when each occurrence is verified by its own claim', () => {
      const result = run(mixed, output({
        description: unit('人工套餐有效期30天。自动套餐有效期30天。', [
          { kind: 'duration', span: '30天', factRef: 'offers[0].validity' },
          { kind: 'duration', span: '30天', factRef: 'offers[1].validity' },
        ]),
      }))
      expect(result.fields.description?.status).toBe('suggested')
    })

    it.each(['售价几元', '可供若干台设备使用', '支持数位用户同时使用'])('rejects vague quantity 「%s」 without a fact', text => {
      expect(run(singleManual30, output({ description: unit(text) })).fields.description?.status).toBe('rejected')
    })
  })

  it.each(['5秒内完成交付', '半天内完成交付', '几分钟内完成交付'])('rejects undeclared timing 「%s」', text => {
    const result = validateModelOutput({ raw: output({ description: unit(text) }), context, readinessCodes: [], upstreamRequested: false })
    expect(result.fields.description?.status).toBe('rejected')
  })

  it('keeps at most 12 model issues and clips their text', () => {
    const result = validateModelOutput({
      raw: output({
        issues: Array.from({ length: 20 }, () => ({
          kind: 'missing' as const,
          field: null,
          message: '缺'.repeat(300),
          evidence: null,
        })),
      }),
      context,
      readinessCodes: [],
      upstreamRequested: false,
    })
    const modelIssues = result.issues.filter(issue => issue.origin === 'model')
    expect(modelIssues).toHaveLength(MAX_MODEL_ISSUES)
    expect(modelIssues[0].message).toHaveLength(200)
  })

  it('derives missing issues from readiness codes, unknown attributes and the upstream request', () => {
    const sparse = buildProductContentAiContext(domainInput('subscription', {
      actorKind: 'admin',
      offers: [offer({ id: 1, deliveryMode: 'manual_service' })],
      externalLink: { sourceSnapshot: { planId: 1, periods: [], namedSkus: [] }, latestDescriptionText: null },
      useUpstreamDescription: true,
    }))
    const result = validateModelOutput({
      raw: output({}),
      context: sparse,
      readinessCodes: ['PURCHASE_NOTES_REQUIRED', 'TEMPLATE_FIELDS_REQUIRED', 'COVER_REQUIRED'],
      upstreamRequested: true,
    })
    const missing = result.issues.filter(issue => issue.kind === 'missing')
    expect(missing.map(issue => issue.field)).toEqual(['purchaseNotes', 'attributes', 'attributes', null])
    expect(missing[2].message).toContain('额度说明')
    expect(countIssues(result.issues).missing).toBe(4)
  })

  it('reports risky wording found in the input without rejecting anything', () => {
    const risky = buildProductContentAiContext(domainInput('redemption_code', { sourceNotes: '永久有效，包退包换' }))
    const result = validateModelOutput({ raw: output({}), context: risky, readinessCodes: [], upstreamRequested: false })
    expect(result.issues.filter(issue => issue.kind === 'risky_claim' && issue.field == null)).toHaveLength(2)
  })
})
