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
