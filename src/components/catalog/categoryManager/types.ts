import type { PlatformMediaRef } from '../../../types/catalog'

/**
 * Shared types between the category manager panel and its extracted dialogs.
 * Only types genuinely consumed on both sides live here; form-local helpers
 * (initial value, validation, slug derivation) stay with the form dialog.
 */
export interface CategoryFormState {
  code: string
  label: string
  description: string
  iconKey: string
  /** Form-draft cover ref; undefined = untouched (edit keeps existing). */
  defaultCover: PlatformMediaRef | null | undefined
  sortOrder: string
  /** SPEC-CATALOG-VIS-001 §3.1：分类级游客可见性。 */
  guestVisibility: 'public' | 'members_only'
}

export type ReviewMode = 'create_new' | 'map_existing' | 'reject'
