// catalogIssueMessages.test.ts — stable-code projection tests
// (SPEC-CMI-UX-001 §6.2; AC-UX-012/022; T-UX-007 DoD).

import { describe, expect, it } from 'vitest'
import { isCoverIssue, projectCatalogIssue } from './catalogIssueMessages'

describe('projectCatalogIssue — COVER stable codes', () => {
  it('COVER_REQUIRED → focus-cover message, never the raw code', () => {
    const projected = projectCatalogIssue({ code: 'COVER_REQUIRED', field: 'cover' })
    expect(projected.message).toBe('请上传一张封面，或使用分类默认封面')
    expect(projected.action).toBe('focus_cover')
    expect(projected.code).toBe('COVER_REQUIRED')
  })

  it('COVER_INVALID + object action → re-upload message (AC-UX-022)', () => {
    const projected = projectCatalogIssue({ code: 'COVER_INVALID', field: 'cover', action: 'reupload_cover' })
    expect(projected.message).toBe('这张封面已失效，请重新上传')
    expect(projected.action).toBe('reupload_cover')
  })

  it('COVER_INVALID + set_category_cover action → category-default message (AC-UX-012)', () => {
    const projected = projectCatalogIssue({ code: 'COVER_INVALID', field: 'cover', action: 'set_category_cover' })
    expect(projected.message).toBe('所选分类还没有默认封面')
    expect(projected.action).toBe('set_category_cover')
  })

  it('does not branch on the Chinese message substring', () => {
    // Even if the server message is a raw internal sentence, projection keys
    // off code/action and returns the frozen user copy.
    const projected = projectCatalogIssue({
      code: 'COVER_INVALID',
      field: 'cover',
      message: 'object missing or expired',
    })
    expect(projected.message).toBe('这张封面已失效，请重新上传')
  })
})

describe('projectCatalogIssue — upload media codes', () => {
  it('UNSUPPORTED_MEDIA_TYPE → reselect-file message', () => {
    const projected = projectCatalogIssue({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(projected.message).toBe('请选择 PNG、JPEG、WebP 或 GIF 图片')
    expect(projected.action).toBe('reselect_file')
  })

  it('FILE_TOO_LARGE → 5MB message', () => {
    const projected = projectCatalogIssue({ code: 'FILE_TOO_LARGE' })
    expect(projected.message).toBe('图片不能超过 5MB')
    expect(projected.action).toBe('reselect_file')
  })
})

describe('projectCatalogIssue — unknown stable code safe fallback', () => {
  it('unknown code → safe message while preserving the original code', () => {
    const projected = projectCatalogIssue({ code: 'SOME_NEW_SERVER_CODE', message: 'raw' })
    expect(projected.message).toBe('封面暂时无法使用，请重新上传后再试')
    expect(projected.action).toBe('reupload_cover')
    expect(projected.code).toBe('SOME_NEW_SERVER_CODE')
  })

  it('missing code → UNKNOWN marker', () => {
    const projected = projectCatalogIssue({ code: '' })
    expect(projected.code).toBe('UNKNOWN')
  })
})

describe('isCoverIssue', () => {
  it('recognizes cover stable codes only', () => {
    expect(isCoverIssue({ code: 'COVER_REQUIRED' })).toBe(true)
    expect(isCoverIssue({ code: 'COVER_INVALID' })).toBe(true)
    expect(isCoverIssue({ code: 'OFFER_REQUIRED' })).toBe(false)
  })
})
