// T-CAT-BE-001 — Category schema/validator pure unit tests
// (SPEC-CATALOG-OPS-001 §5.1/§7.2; D-CAT-06/D-CAT-07/D-CAT-17).
// No DB access and no side effects — safe to run in any harness.

import { describe, expect, it } from 'vitest'
import {
  categoryCodeSchema,
  createCategorySchema,
  isPlatformPublicAssetUrl,
  listCategoriesQuerySchema,
  MAX_CATEGORY_REORDER_IDS,
  normalizeCategoryLabel,
  reorderCategoriesSchema,
  updateCategorySchema,
} from './categorySchema.js'

describe('normalizeCategoryLabel', () => {
  it('trims and lowercases into a deterministic canonical form', () => {
    expect(normalizeCategoryLabel('  网络节点  ')).toBe('网络节点')
    expect(normalizeCategoryLabel(' Cloud Tools ')).toBe('cloud tools')
    expect(normalizeCategoryLabel('Cloud Tools')).toBe('cloud tools')
  })
})

describe('isPlatformPublicAssetUrl', () => {
  it('accepts platform public objects and repository static resources', () => {
    expect(isPlatformPublicAssetUrl('/uploads/abc123.webp')).toBe(true)
    expect(isPlatformPublicAssetUrl('/assets/cover/network-node.png')).toBe(true)
  })

  it('rejects absolute, protocol-relative and relative URLs', () => {
    expect(isPlatformPublicAssetUrl('https://evil.example/x.png')).toBe(false)
    expect(isPlatformPublicAssetUrl('//evil.example/x.png')).toBe(false)
    expect(isPlatformPublicAssetUrl('uploads/x.png')).toBe(false)
    expect(isPlatformPublicAssetUrl('/x.png')).toBe(false)
  })

  it('rejects path traversal in literal and percent-encoded forms', () => {
    expect(isPlatformPublicAssetUrl('/uploads/../secrets')).toBe(false)
    expect(isPlatformPublicAssetUrl('/uploads/%2e%2e/secrets')).toBe(false)
    expect(isPlatformPublicAssetUrl('/uploads/%2E%2E/secrets')).toBe(false)
    expect(isPlatformPublicAssetUrl('/assets/%2fetc')).toBe(false)
  })

  it('rejects non-asset roots, query/hash and unsafe characters', () => {
    expect(isPlatformPublicAssetUrl('/admin')).toBe(false)
    expect(isPlatformPublicAssetUrl('/api/config/registry')).toBe(false)
    expect(isPlatformPublicAssetUrl('/uploads/x.png?v=1')).toBe(false)
    expect(isPlatformPublicAssetUrl('/uploads/x.png#frag')).toBe(false)
    expect(isPlatformPublicAssetUrl('/uploads/a b.png')).toBe(false)
  })
})

describe('createCategorySchema', () => {
  it('parses a valid create body and defaults sortOrder to 0', () => {
    const result = createCategorySchema.safeParse({
      code: 'cloud-tool',
      label: '云工具',
      description: '平台云工具分类',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.code).toBe('cloud-tool')
      expect(result.data.sortOrder).toBe(0)
      expect(result.data.description).toBe('平台云工具分类')
    }
  })

  it('treats empty optional strings as unset', () => {
    const result = createCategorySchema.safeParse({
      code: 'cloud-tool',
      label: '云工具',
      description: '   ',
      iconKey: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.description).toBeUndefined()
      expect(result.data.iconKey).toBeUndefined()
    }
  })

  it('rejects invalid codes', () => {
    expect(createCategorySchema.safeParse({ code: 'CloudTool', label: 'x' }).success).toBe(false)
    expect(createCategorySchema.safeParse({ code: '', label: 'x' }).success).toBe(false)
    expect(createCategorySchema.safeParse({ code: 'c@t', label: 'x' }).success).toBe(false)
  })

  it('is strict: status/isHot/deliveryMode cannot be smuggled in', () => {
    expect(createCategorySchema.safeParse({ code: 'c', label: 'x', status: 'inactive' }).success).toBe(false)
    expect(createCategorySchema.safeParse({ code: 'c', label: 'x', isHot: true }).success).toBe(false)
    expect(createCategorySchema.safeParse({ code: 'c', label: 'x', deliveryMode: 'instant_inventory' }).success).toBe(false)
  })

  it('rejects an arbitrary remote defaultCoverUrl', () => {
    expect(createCategorySchema.safeParse({
      code: 'c',
      label: 'x',
      defaultCoverUrl: 'https://evil.example/x.png',
    }).success).toBe(false)
  })
})

describe('updateCategorySchema', () => {
  it('is strict: immutable code is rejected rather than silently stripped', () => {
    expect(updateCategorySchema.safeParse({ code: 'new-code' }).success).toBe(false)
  })

  it('is strict: unknown fields are rejected', () => {
    expect(updateCategorySchema.safeParse({ isHot: true }).success).toBe(false)
  })

  it('maps empty optional strings to null so cleared fields store NULL', () => {
    const result = updateCategorySchema.safeParse({
      description: '  ',
      iconKey: '',
      defaultCoverUrl: ' ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.description).toBeNull()
      expect(result.data.iconKey).toBeNull()
      expect(result.data.defaultCoverUrl).toBeNull()
    }
  })

  it('accepts label rename and sortOrder', () => {
    const result = updateCategorySchema.safeParse({ label: '新名字', sortOrder: 5 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.label).toBe('新名字')
      expect(result.data.sortOrder).toBe(5)
    }
  })
})

describe('reorderCategoriesSchema', () => {
  it('accepts a bounded list of positive ids', () => {
    expect(reorderCategoriesSchema.safeParse({ orderedIds: [1, 2, 3] }).success).toBe(true)
  })

  it('rejects empty, non-positive or over-long lists', () => {
    expect(reorderCategoriesSchema.safeParse({ orderedIds: [] }).success).toBe(false)
    expect(reorderCategoriesSchema.safeParse({ orderedIds: [0] }).success).toBe(false)
    expect(reorderCategoriesSchema.safeParse({ orderedIds: [-1] }).success).toBe(false)
    const tooLong = Array.from({ length: MAX_CATEGORY_REORDER_IDS + 1 }, (_, i) => i + 1)
    expect(reorderCategoriesSchema.safeParse({ orderedIds: tooLong }).success).toBe(false)
  })
})

describe('listCategoriesQuerySchema', () => {
  it('coerces page/pageSize and clamps pageSize bounds', () => {
    const ok = listCategoriesQuerySchema.safeParse({ page: '2', pageSize: '50' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.page).toBe(2)
      expect(ok.data.pageSize).toBe(50)
    }
    expect(listCategoriesQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false)
    expect(listCategoriesQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
    expect(listCategoriesQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false)
  })
})

describe('categoryCodeSchema', () => {
  it('matches the frozen ^[a-z][a-z0-9_-]{1,63}$ pattern (min 2, max 64 chars)', () => {
    expect(categoryCodeSchema.safeParse('network-node').success).toBe(true)
    expect(categoryCodeSchema.safeParse('ab').success).toBe(true)
    // Pattern requires first char [a-z] followed by 1..63 of [a-z0-9_-].
    expect(categoryCodeSchema.safeParse('a').success).toBe(false)
    expect(categoryCodeSchema.safeParse('A').success).toBe(false)
    expect(categoryCodeSchema.safeParse('1abc').success).toBe(false)
    expect(categoryCodeSchema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(categoryCodeSchema.safeParse('a'.repeat(65)).success).toBe(false)
  })
})
