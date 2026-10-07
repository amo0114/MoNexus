import { describe, expect, it } from 'vitest'
import { assertNoSentinel, assertUnknownPreserved, collectKeyPaths } from '../../../__tests__/aiProjection.js'
import { EMPTY_PRODUCT_DETAILS } from '../templates/types.js'
import { FIXTURE_SENSITIVE_SKU, domainInput, offer } from './__fixtures__/fixtures.js'
import { MAX_CONTEXT_CHARS } from './constants.js'
import { ContentContextTooLargeError, buildProductContentAiContext, deriveXboardPeriod } from './projection.js'

const SNAPSHOT = {
  planId: 4242,
  name: '示例线路',
  periods: [
    { period: 'monthly', price: 9999, skuAlias: 'plan-4242-monthly' },
    { period: 'yearly', price: 8888, skuAlias: 'alias-yearly' },
  ],
  namedSkus: [{ period: 'quarterly', sku: 'aster-pro-quarterly' }],
}

describe('content copilot projection (SPEC-AI-001 §4.2, SPEC-AI-PRODUCT-001 §5)', () => {
  it('never carries secrets, prices, stock, SKUs or upstream capacity even when the caller loaded them', () => {
    const input = domainInput('subscription', {
      actorKind: 'admin',
      offers: [
        {
          ...offer({ id: 1, deliveryMode: 'manual_service', externalIntegration: 'faka_bridge', externalSku: FIXTURE_SENSITIVE_SKU }),
          // Extra fields a careless caller might pass through.
          fixedContent: 'SENTINEL_FIXED_CONTENT',
          fixedStructuredContent: { secret: 'SENTINEL_STRUCTURED' },
          price: 777777,
          stock: 666666,
          deliveryFields: [{ key: 'pwd', label: '密码', sensitive: true, placeholder: 'SENTINEL_PLACEHOLDER' }],
        } as never,
      ],
      externalLink: { sourceSnapshot: { ...SNAPSHOT, capacity: { remaining: 555555 } }, latestDescriptionText: '上游介绍' },
      useUpstreamDescription: true,
    })
    const context = buildProductContentAiContext(input)
    assertNoSentinel(context, [
      'SENTINEL_FIXED_CONTENT',
      'SENTINEL_STRUCTURED',
      'SENTINEL_PLACEHOLDER',
      FIXTURE_SENSITIVE_SKU,
      '777777',
      '666666',
      '555555',
      '4242',
      '9999',
      '"pwd"',
    ])
    expect(context.facts.offers[0].deliveryFieldLabels).toEqual(['密码'])
  })

  it('matches the frozen allowlist of key paths', () => {
    const context = buildProductContentAiContext(domainInput('appointment', {
      actorKind: 'admin',
      attributes: { deliveryChannel: 'video', timeZone: 'Asia/Shanghai', preparation: '准备资料' },
      offers: [offer({ id: 1, deliveryMode: 'manual_service', attributes: { servicePackage: '咨询', estimatedMinutes: 30 } })],
      externalLink: { sourceSnapshot: SNAPSHOT, latestDescriptionText: '上游' },
      useUpstreamDescription: true,
    }))
    const paths = collectKeyPaths(context).filter(path => !/Attributes\.|attributes\./.test(path))
    expect(paths).toEqual([
      'facts',
      'facts.category',
      'facts.category.label',
      'facts.common',
      'facts.common.deliveryMethod',
      'facts.common.validity',
      'facts.common.validity.kind',
      'facts.offers',
      'facts.offers[].attributes',
      'facts.offers[].autoProvision',
      'facts.offers[].deliveryFieldLabels',
      'facts.offers[].deliveryMethod',
      'facts.offers[].externalProvisioning',
      'facts.offers[].name',
      'facts.offers[].ref',
      'facts.offers[].validity',
      'facts.offers[].validity.kind',
      'facts.offers[].xboardPeriod',
      'facts.productAttributes',
      'facts.purchaseFormFieldLabels',
      'facts.template',
      'facts.template.key',
      'facts.template.label',
      'facts.template.version',
      'facts.xboard',
      'facts.xboard.periods',
      'limits',
      'limits.afterSalesInstructionsMax',
      'limits.descriptionMax',
      'limits.faqAnswerMax',
      'limits.faqMaxItems',
      'limits.faqQuestionMax',
      'limits.highlightMax',
      'limits.highlightsMaxItems',
      'limits.purchaseNotesMax',
      'limits.usageInstructionsMax',
      'schemaVersion',
      'targetFields',
      'truncated',
      'untrusted',
      'untrusted.currentContent',
      'untrusted.currentContent.description',
      'untrusted.currentContent.details',
      'untrusted.currentContent.details.afterSalesInstructions',
      'untrusted.currentContent.details.faq',
      'untrusted.currentContent.details.highlights',
      'untrusted.currentContent.details.purchaseNotes',
      'untrusted.currentContent.details.usageInstructions',
      'untrusted.productName',
      'untrusted.sourceNotes',
      'untrusted.upstreamDescriptionText',
    ])
    expect(context.facts.offers[0].attributes.estimatedMinutes).toEqual({
      kind: 'integer', title: '预计服务时长（分钟）', value: 30, unit: 'minute',
    })
    expect(context.facts.productAttributes.deliveryChannel).toMatchObject({ kind: 'enum', value: 'video' })
  })

  it('projects validityDays=null faithfully as perpetual_access and keeps unknown attributes null', () => {
    const context = buildProductContentAiContext(domainInput('subscription', {
      offers: [offer({ id: 1, deliveryMode: 'manual_service', validityDays: null })],
    }))
    expect(context.facts.offers[0].validity).toEqual({ kind: 'perpetual_access' })
    expect(context.facts.common.validity).toEqual({ kind: 'perpetual_access' })
    expect(context.facts.productAttributes.serviceName).toEqual({ kind: 'text', title: '服务名称', value: null })
    expect(context.facts.offers[0].attributes.quotaText).toEqual({ kind: 'text', title: '额度说明', value: null })
    assertUnknownPreserved(context)
  })

  it('computes common facts only when every active offer agrees', () => {
    const context = buildProductContentAiContext(domainInput('subscription', {
      offers: [
        offer({ id: 1, deliveryMode: 'manual_service', validityDays: 30 }),
        offer({ id: 2, deliveryMode: 'manual_service', validityDays: 90 }),
      ],
    }))
    expect(context.facts.common).toEqual({ deliveryMethod: 'manual_service', validity: null })
  })

  it('derives xboardPeriod by exact match only, never falling back to monthly', () => {
    expect(deriveXboardPeriod(SNAPSHOT, 'plan-4242-monthly')).toBe('monthly')
    expect(deriveXboardPeriod(SNAPSHOT, 'ALIAS-YEARLY')).toBe('yearly')
    expect(deriveXboardPeriod(SNAPSHOT, 'aster-pro-quarterly')).toBe('quarterly')
    expect(deriveXboardPeriod({ ...SNAPSHOT, periods: [...SNAPSHOT.periods, { period: 'half_yearly', price: 1, skuAlias: 'x' }] }, 'plan-4242-half_yearly'))
      .toBe('half_yearly')
    expect(deriveXboardPeriod(SNAPSHOT, 'plan-4242-two_yearly')).toBeNull()
    expect(deriveXboardPeriod(SNAPSHOT, 'something-unparseable')).toBeNull()
    expect(deriveXboardPeriod(SNAPSHOT, null)).toBeNull()
  })

  it('never exposes Xboard facts or upstream text on the merchant path', () => {
    const context = buildProductContentAiContext(domainInput('subscription', {
      actorKind: 'merchant',
      offers: [offer({ id: 1, deliveryMode: 'manual_service', externalIntegration: 'faka_bridge', externalSku: 'plan-4242-monthly' })],
      externalLink: { sourceSnapshot: SNAPSHOT, latestDescriptionText: 'SENTINEL_UPSTREAM' },
      useUpstreamDescription: true,
    }))
    expect(context.facts.xboard).toBeNull()
    expect(context.facts.offers[0].xboardPeriod).toBeNull()
    expect(context.untrusted.upstreamDescriptionText).toBeNull()
    assertNoSentinel(context, ['SENTINEL_UPSTREAM'])
  })

  it('projects Xboard periods for admins independently of useUpstreamDescription', () => {
    const context = buildProductContentAiContext(domainInput('subscription', {
      actorKind: 'admin',
      offers: [offer({ id: 1, deliveryMode: 'manual_service', externalSku: 'plan-4242-monthly' })],
      externalLink: { sourceSnapshot: SNAPSHOT, latestDescriptionText: '上游介绍' },
      useUpstreamDescription: false,
    }))
    expect(context.facts.xboard).toEqual({ periods: ['monthly', 'yearly'] })
    expect(context.facts.offers[0].xboardPeriod).toBe('monthly')
    expect(context.untrusted.upstreamDescriptionText).toBeNull()
  })

  it('truncates every untrusted field before giving up, then refuses instead of exceeding the limit', () => {
    const fullOffers = (count: number) => Array.from({ length: count }, (_, index) => offer({
      id: index + 1,
      name: `规格${index + 1}`,
      deliveryMode: 'manual_service',
      validityDays: 30,
      attributes: { entitlementSummary: '权'.repeat(500), quotaText: '额'.repeat(200), regionText: '区'.repeat(200) },
    }))
    const heavyDetails = {
      highlights: ['亮'.repeat(40), '点'.repeat(40)],
      usageInstructions: '用'.repeat(4_000),
      purchaseNotes: '须'.repeat(2_000),
      afterSalesInstructions: '售'.repeat(2_000),
      faq: [{ question: '问'.repeat(100), answer: '答'.repeat(1_000) }],
    }

    const fits = buildProductContentAiContext(domainInput('subscription', { offers: fullOffers(10), details: heavyDetails, description: '简'.repeat(2_000) }))
    expect(JSON.stringify(fits).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(fits.truncated).toBe(true)
    expect(fits.facts.offers).toHaveLength(10)

    expect(() => buildProductContentAiContext(domainInput('subscription', { offers: fullOffers(20), details: heavyDetails })))
      .toThrow(ContentContextTooLargeError)
  })

  it('truncates untrusted text in the frozen order and flags it', () => {
    const context = buildProductContentAiContext(domainInput('redemption_code', {
      actorKind: 'admin',
      externalLink: { sourceSnapshot: SNAPSHOT, latestDescriptionText: '上'.repeat(30_000) },
      useUpstreamDescription: true,
      sourceNotes: '备'.repeat(1_000),
      details: { ...EMPTY_PRODUCT_DETAILS, usageInstructions: '用'.repeat(4_000) },
    }))
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(context.truncated).toBe(true)
    expect(context.untrusted.upstreamDescriptionText?.endsWith('…')).toBe(true)
    expect(context.untrusted.sourceNotes).toBe('备'.repeat(1_000))
    expect(context.untrusted.currentContent.details.usageInstructions).toBe('用'.repeat(4_000))
  })
})
