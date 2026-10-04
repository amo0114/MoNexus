// Shared symbols for the extracted editorial dialogs (SPEC-MERCH-001 §5.5 admin
// lane).
//
// Only what BOTH dialogs genuinely need lives here. Anything owned by a single
// dialog (its form state, initial values, validation, date conversion) stays in
// that dialog's module.

/**
 * Max length of the internal reason and of the revoke reason. The server caps
 * both at the same value and both dialogs must enforce the identical limit, so
 * it is defined once here instead of being duplicated per dialog.
 */
export const MAX_INTERNAL_REASON_LENGTH = 500
