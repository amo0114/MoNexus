import { describe, expect, it } from 'vitest'
import { getProductTemplateRegistry, listTemplateExamples } from './registry.js'
import { validateTemplateAttributes } from './validate.js'
import { TEMPLATE_KEYS } from './types.js'

describe('template attribute Ajv validators (SPEC-PRODUCT-COMMERCE-002 §4)', () => {
  const examples = listTemplateExamples()
  const registry = getProductTemplateRegistry()

  it('compiles seven frozen templates and does not expose examples on the public registry', () => {
    expect(registry.registryVersion).toBe(1)
    expect(registry.templates.map(template => template.key)).toEqual([...TEMPLATE_KEYS])
    expect(JSON.stringify(registry)).not.toContain('"examples"')
  })

  it('accepts each frozen example on the matching publish schema', () => {
    for (const template of registry.templates) {
      const example = examples[template.key]
      const product = validateTemplateAttributes({
        templateKey: template.key,
        templateVersion: template.version,
        attributes: example.product,
        mode: 'publish',
        target: 'product',
        pathPrefix: '/attributes',
      })
      const offer = validateTemplateAttributes({
        templateKey: template.key,
        templateVersion: template.version,
        attributes: example.offer,
        mode: 'publish',
        target: 'offer',
        pathPrefix: '/offers/0/attributes',
      })
      expect(product).toEqual({ ok: true, value: example.product })
      expect(offer).toEqual({ ok: true, value: example.offer })
    }
  })

  it('rejects unknown fields and invalid enums for both draft and publish', () => {
    const unknown = validateTemplateAttributes({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: { serviceName: '示例软件', redemptionMethod: '兑换', extra: true },
      mode: 'draft',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.errors.some(error => error.path.startsWith('/attributes'))).toBe(true)
      expect(JSON.stringify(unknown.errors)).not.toContain('示例软件')
    }

    const invalidEnum = validateTemplateAttributes({
      templateKey: 'account',
      templateVersion: 1,
      attributes: {
        serviceName: '示例服务',
        accessModel: 'rented',
        usageRestrictions: '按约定使用',
      },
      mode: 'publish',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(invalidEnum.ok).toBe(false)
  })

  it('allows draft objects to omit required fields but still rejects wrong types', () => {
    const draft = validateTemplateAttributes({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: { region: '全球' },
      mode: 'draft',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(draft).toEqual({ ok: true, value: { region: '全球' } })

    const publish = validateTemplateAttributes({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: { region: '全球' },
      mode: 'publish',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(publish.ok).toBe(false)

    const wrongType = validateTemplateAttributes({
      templateKey: 'redemption_code',
      templateVersion: 1,
      attributes: { serviceName: 12 },
      mode: 'draft',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(wrongType.ok).toBe(false)
  })

  it('does not implicitly fill JSON Schema default annotations', () => {
    const result = validateTemplateAttributes({
      templateKey: 'account',
      templateVersion: 1,
      attributes: {
        serviceName: '示例服务',
        accessModel: 'exclusive',
        usageRestrictions: '按约定使用',
      },
      mode: 'publish',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        serviceName: '示例服务',
        accessModel: 'exclusive',
        usageRestrictions: '按约定使用',
      })
    }
  })

  it('rejects unknown template keys and versions', () => {
    const unknownKey = validateTemplateAttributes({
      templateKey: 'license_key',
      templateVersion: 1,
      attributes: {},
      mode: 'draft',
      target: 'product',
      pathPrefix: '/attributes',
    })
    const unknownVersion = validateTemplateAttributes({
      templateKey: 'redemption_code',
      templateVersion: 2,
      attributes: {},
      mode: 'draft',
      target: 'product',
      pathPrefix: '/attributes',
    })
    expect(unknownKey.ok).toBe(false)
    expect(unknownVersion.ok).toBe(false)
  })
})
