import { formatDateTime as formatBusinessDateTime } from '../../../utils/datetime'
/**
 * R09a — safe local-time formatting shared by both campaign dialogs.
 *
 * Kept as one module because both dialogs render the same DTO timestamps with
 * the same rules; the page-level table keeps its own copies untouched.
 */

/** Safe date formatting: unparseable input is shown verbatim. */
export function formatDateTime(iso: string): string {
  return formatBusinessDateTime(iso)
}

/** Nullable timestamps render as — when absent; else safe local formatting. */
export function formatMaybeDate(iso: string | null): string {
  return iso == null ? '—' : formatDateTime(iso)
}
