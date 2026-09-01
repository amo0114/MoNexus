// catalogIssueMessages.ts — stable-code → user-message projection
// (SPEC-CMI-UX-001 §6.2; D-UX-16; AC-UX-012/022; T-UX-007 DoD).
//
// The default DOM must never render a stable code like `COVER_INVALID` as
// primary copy. This module maps a stable code (+ server-provided `action`)
// to a user message. Branching is keyed on code/action — never on the Chinese
// message substring (plan §4.2 / CHK §4).

export type CoverAction =
  | 'focus_cover'
  | 'reupload_cover'
  | 'set_category_cover'
  | 'reselect_file'
  | 'none'

export interface CatalogIssue {
  code: string
  field?: string
  message?: string
  action?: string
}

export interface ProjectedCatalogIssue {
  /** User-facing message rendered in the default DOM. */
  message: string
  /** Suggested next action for the UI to offer. */
  action: CoverAction
  /** Stable code preserved for logs / technical details / data attributes. */
  code: string
}

/** Frozen mapping for non-cover stable codes (spec §6.2). */
const STABLE_MESSAGES: Record<string, { message: string; action: CoverAction }> = {
  COVER_REQUIRED: { message: '请上传一张封面，或使用分类默认封面', action: 'focus_cover' },
  UNSUPPORTED_MEDIA_TYPE: { message: '请选择 PNG、JPEG、WebP 或 GIF 图片', action: 'reselect_file' },
  FILE_TOO_LARGE: { message: '图片不能超过 5MB', action: 'reselect_file' },
  PLAN_ARCHIVED: { message: '该套餐已关联已归档商品，请恢复后同步，不要重复创建', action: 'none' },
  PLAN_ALREADY_IMPORTED: { message: '该套餐已导入，不会重复创建商品', action: 'none' },
}

const FALLBACK_MESSAGE = '封面暂时无法使用，请重新上传后再试'

/**
 * Project one catalog issue to user-facing copy. Unknown stable codes get a
 * safe fallback message while the original code is preserved for observability.
 */
export function projectCatalogIssue(issue: CatalogIssue): ProjectedCatalogIssue {
  // COVER_INVALID has two sub-cases distinguished by the server-provided
  // `action` (plan §4.2), never by matching the Chinese message.
  if (issue.code === 'COVER_INVALID') {
    if (issue.action === 'set_category_cover') {
      return { message: '所选分类还没有默认封面', action: 'set_category_cover', code: issue.code }
    }
    return { message: '这张封面已失效，请重新上传', action: 'reupload_cover', code: issue.code }
  }

  const mapped = STABLE_MESSAGES[issue.code]
  if (mapped) return { message: mapped.message, action: mapped.action, code: issue.code }

  return { message: FALLBACK_MESSAGE, action: 'reupload_cover', code: issue.code || 'UNKNOWN' }
}

/** True when the issue is a cover-related stable code. */
export function isCoverIssue(issue: CatalogIssue): boolean {
  return issue.code === 'COVER_REQUIRED' || issue.code === 'COVER_INVALID'
}
