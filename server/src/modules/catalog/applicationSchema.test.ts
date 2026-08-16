// T-CAT-BE-002 — CategoryApplication schema/validator pure unit tests
// (SPEC-CATALOG-OPS-001 §5.2/§7.3; D-CAT-10; REQ-CAT-F-008;
// CHK-CAT-006~008; AC-CAT-012~014).
//
// No DB access and no side effects — safe to run in any harness. These tests
// pin the input allowlist (strict schemas, no merchantId/status smuggling),
// the normalized-label canonical form, the reviewReason allowlist, and the
// approve discriminated union.

import { describe, expect, it } from 'vitest'
import {
  approveCategoryApplicationSchema,
  createCategoryApplicationSchema,
  listAdminCategoryApplicationsQuerySchema,
  listMyCategoryApplicationsQuerySchema,
  MAX_APPLICATION_REVIEW_REASON_LENGTH,
  normalizeApplicationLabel,
  rejectCategoryApplicationSchema,
  reviewReasonSchema,
} from './applicationSchema.js'

describe('normalizeApplicationLabel', () => {
  it('trims and lowercases into a deterministic canonical form', () => {
    expect(normalizeApplicationLabel('  网络节点  ')).toBe('网络节点')
    expect(normalizeApplicationLabel(' 云工具 ')).toBe('云工具')
    expect(normalizeApplicationLabel(' Cloud Tools ')).toBe('cloud tools')
    // Different whitespace/case collapse to the SAME canonical value — this is
    // exactly what the "one pending per merchant + normalizedLabel" rule keys on.
    expect(normalizeApplicationLabel('CloudTools')).toBe('cloudtools')
    expect(normalizeApplicationLabel('  cloudtools  ')).toBe('cloudtools')
  })
})

describe('createCategoryApplicationSchema (merchant create body)', () => {
  const valid = {
    proposedLabel: '云工具',
    description: '用于平台云工具与数字服务商品展示检索的分类申请说明文本',
  }

  it('accepts a valid create body and keeps optional fields', () => {
    const result = createCategoryApplicationSchema.safeParse({
      ...valid,
      proposedCode: 'cloud-tool',
      exampleProducts: '示例 A、示例 B',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.proposedLabel).toBe('云工具')
      expect(result.data.proposedCode).toBe('cloud-tool')
      expect(result.data.exampleProducts).toBe('示例 A、示例 B')
    }
  })

  it('treats empty optional strings as unset', () => {
    const result = createCategoryApplicationSchema.safeParse({
      ...valid,
      proposedCode: '   ',
      exampleProducts: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.proposedCode).toBeUndefined()
      expect(result.data.exampleProducts).toBeUndefined()
    }
  })

  it('is strict: merchantId/status/resolution cannot be smuggled in', () => {
    expect(createCategoryApplicationSchema.safeParse({ ...valid, merchantId: 7 }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({ ...valid, status: 'approved' }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({ ...valid, resolution: 'create_new' }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({ ...valid, reviewedByUserId: 1 }).success).toBe(false)
  })

  it('enforces proposedLabel 1..50 and description 20..1000 bounds', () => {
    expect(createCategoryApplicationSchema.safeParse({ ...valid, proposedLabel: '' }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      proposedLabel: 'x'.repeat(51), description: 'd'.repeat(40),
    }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      proposedLabel: 'x', description: '短于 20 字',
    }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      proposedLabel: 'x', description: 'd'.repeat(1001),
    }).success).toBe(false)
  })

  it('bounds proposedCode to code-like text without control characters', () => {
    expect(createCategoryApplicationSchema.safeParse({
      ...valid, proposedCode: 'a'.repeat(65),
    }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      ...valid, proposedCode: 'bad code!',
    }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      ...valid, proposedCode: 'bad\u0000code',
    }).success).toBe(false)
    expect(createCategoryApplicationSchema.safeParse({
      ...valid, proposedCode: 'Cloud-Tool_2',
    }).success).toBe(true)
  })
})

describe('reviewReasonSchema (allowlist)', () => {
  it('accepts a normal bounded reason', () => {
    expect(reviewReasonSchema.safeParse('符合平台目录').success).toBe(true)
    expect(reviewReasonSchema.safeParse('x'.repeat(500)).success).toBe(true)
  })

  it('rejects empty, over-long and control-character reasons', () => {
    expect(reviewReasonSchema.safeParse('   ').success).toBe(false)
    expect(reviewReasonSchema.safeParse('x'.repeat(501)).success).toBe(false)
    expect(reviewReasonSchema.safeParse('有换行\u000a控制').success).toBe(false)
    expect(reviewReasonSchema.safeParse('有制表\u0009符').success).toBe(false)
    expect(reviewReasonSchema.safeParse(`含\u007f删除符`).success).toBe(false)
  })

  it('exports a stable max constant used by the message', () => {
    expect(MAX_APPLICATION_REVIEW_REASON_LENGTH).toBe(500)
  })
})

describe('approveCategoryApplicationSchema (admin approve body)', () => {
  const createNewBody = {
    resolution: 'create_new',
    category: { code: 'cloud-tool', label: '云工具', iconKey: 'cloud' },
    reviewReason: '符合平台目录',
  }
  const mapExistingBody = {
    resolution: 'map_existing',
    categoryId: 12,
    reviewReason: '已存在等价分类',
  }

  it('accepts create_new with the category block', () => {
    const result = approveCategoryApplicationSchema.safeParse(createNewBody)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resolution).toBe('create_new')
      if (result.data.resolution === 'create_new') {
        expect(result.data.category.code).toBe('cloud-tool')
        expect(result.data.category.label).toBe('云工具')
        expect(result.data.reviewReason).toBe('符合平台目录')
      }
    }
  })

  it('accepts map_existing with a positive categoryId', () => {
    const result = approveCategoryApplicationSchema.safeParse(mapExistingBody)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.resolution).toBe('map_existing')
      if (result.data.resolution === 'map_existing') {
        expect(result.data.categoryId).toBe(12)
      }
    }
  })

  it('rejects a missing or empty reviewReason on both branches', () => {
    expect(approveCategoryApplicationSchema.safeParse({
      ...createNewBody, reviewReason: ' ',
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      ...mapExistingBody, reviewReason: '',
    }).success).toBe(false)
  })

  it('is strict: unknown/resolution-mismatched fields are rejected', () => {
    expect(approveCategoryApplicationSchema.safeParse({
      ...createNewBody, status: 'approved',
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      ...createNewBody, category: { ...createNewBody.category, sortOrder: 5 },
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      ...mapExistingBody, categoryId: 0,
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      ...mapExistingBody, resolution: 'bogus',
    }).success).toBe(false)
    // create_new cannot carry categoryId; map_existing cannot carry category.
    expect(approveCategoryApplicationSchema.safeParse({
      resolution: 'create_new', categoryId: 12, reviewReason: 'x',
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      resolution: 'map_existing', category: createNewBody.category, reviewReason: 'x',
    }).success).toBe(false)
  })

  it('rejects a category code that violates the frozen code pattern', () => {
    expect(approveCategoryApplicationSchema.safeParse({
      ...createNewBody, category: { code: 'CloudTool', label: '云工具' },
    }).success).toBe(false)
    expect(approveCategoryApplicationSchema.safeParse({
      ...createNewBody, category: { code: 'c@t', label: '云工具' },
    }).success).toBe(false)
  })
})

describe('rejectCategoryApplicationSchema', () => {
  it('requires a bounded reviewReason and rejects unknown fields', () => {
    expect(rejectCategoryApplicationSchema.safeParse({ reviewReason: '与现有分类重复' }).success).toBe(true)
    expect(rejectCategoryApplicationSchema.safeParse({}).success).toBe(false)
    expect(rejectCategoryApplicationSchema.safeParse({ reviewReason: '' }).success).toBe(false)
    expect(rejectCategoryApplicationSchema.safeParse({ reviewReason: 'x', status: 'rejected' }).success).toBe(false)
  })
})

describe('application list query schemas', () => {
  it('merchant list coerces pagination and only accepts valid statuses', () => {
    const ok = listMyCategoryApplicationsQuerySchema.safeParse({ status: 'pending', page: '2', pageSize: '50' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.page).toBe(2)
      expect(ok.data.pageSize).toBe(50)
    }
    expect(listMyCategoryApplicationsQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false)
    expect(listMyCategoryApplicationsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
    // merchantId cannot be used to filter another merchant's applications — it
    // is stripped by the schema and ownership is forced server-side anyway.
    const stripped = listMyCategoryApplicationsQuerySchema.safeParse({ merchantId: 3, status: 'pending' })
    expect(stripped.success).toBe(true)
    if (stripped.success) expect('merchantId' in stripped.data).toBe(false)
  })

  it('admin list adds an optional merchantId filter', () => {
    const ok = listAdminCategoryApplicationsQuerySchema.safeParse({ status: 'approved', merchantId: '7', pageSize: '25' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.merchantId).toBe(7)
    }
    expect(listAdminCategoryApplicationsQuerySchema.safeParse({ merchantId: 0 }).success).toBe(false)
    expect(listAdminCategoryApplicationsQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false)
  })
})
