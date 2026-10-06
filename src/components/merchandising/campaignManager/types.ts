/**
 * R09a — shared campaign-dialog contracts.
 *
 * Only what is genuinely read on BOTH sides of the extraction lives here: the
 * strict mutation action union (the page dispatches it, the action dialog
 * switches on it) and the admin reason length cap (the page validates on
 * submit, the action dialog mirrors it as the textarea maxLength). Anything a
 * single component owns stays in that component.
 */

/**
 * Strictly-typed mutation action union. Every entry-button maps to exactly one
 * kind; no type assertion is used to smuggle a value through.
 */
export type AdminCampaignDialogAction =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'cancel' }
  | { kind: 'refund-adjustment' }

export type AdminCampaignActionKind = AdminCampaignDialogAction['kind']

/** Max length for admin-entered reasons (mirrors the frozen server cap). */
export const MAX_REASON_LENGTH = 500
