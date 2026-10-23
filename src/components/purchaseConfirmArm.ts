/**
 * How long a freshly loaded checkout quote stays unconfirmable. Separate
 * module so component tests that click straight through can mock it to 0.
 */
export const CONFIRM_ARM_MS: number = 500
