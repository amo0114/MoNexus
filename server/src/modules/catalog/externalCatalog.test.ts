import { describe, expect, it } from 'vitest'
import {
  buildExternalCatalogRequestHash,
  canonicalJson,
  normalizeFakaSource,
  validateExternalCatalogIdempotencyKey,
} from './externalCatalog.js'

describe('external catalog canonical contracts', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, rows: [{ z: 1, a: 2 }] }))
      .toBe('{"a":{"b":3,"y":2},"rows":[{"a":2,"z":1}],"z":1}')
  })

  it('normalizes source metadata and never stores raw HTML in sourceSnapshot', () => {
    const source = normalizeFakaSource({
      plan_id: 7,
      name: ' Gold ',
      content: '<p>safe</p><script>secret()</script>',
      show: true,
      sell: true,
      renew: true,
      group_id: 1,
      transfer_enable: 0,
      capacity_limit: null,
      active_users: 0,
      remaining: null,
      periods: [{ period: 'Monthly', price: 1, sku_alias: 'PLAN-7-MONTHLY' }],
      named_skus: [{ period: 'Monthly', sku: 'GOLD-MONTHLY' }],
    })
    expect(source.name).toBe('Gold')
    expect(source.richDescription).toBe('<p>safe</p>')
    expect(JSON.stringify(source.sourceSnapshot)).not.toContain('script')
    expect(source.sourceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('freezes request hashes and validates idempotency keys', () => {
    const input = {
      planId: 7,
      categoryId: 9,
      cover: { mode: 'category_default' as const },
      offers: [{ period: 'MONTHLY', pricePoints: 120 }],
    }
    expect(buildExternalCatalogRequestHash(input, 'a'.repeat(64)))
      .toBe(buildExternalCatalogRequestHash({ ...input }, 'a'.repeat(64)))
    expect(validateExternalCatalogIdempotencyKey(' req:7.monthly ')).toBe('req:7.monthly')
    expect(() => validateExternalCatalogIdempotencyKey('bad key')).toThrow('格式无效')
    expect(() => validateExternalCatalogIdempotencyKey(undefined)).toThrow('缺少')
  })
})
