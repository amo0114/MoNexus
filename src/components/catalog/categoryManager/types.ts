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
}

export type ReviewMode = 'create_new' | 'map_existing' | 'reject'
