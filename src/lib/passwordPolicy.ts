// The server (server/src/lib/passwordPolicy.ts) is the only authority on password
// strength. The client only checks length for instant feedback and shows the rule
// hint; strength and blocklist rejections come back from the API per field.
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const PASSWORD_RULE_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位，避免常见密码，且不要包含邮箱或昵称`

/** Returns a user-facing reason when the length is out of range, otherwise null. */
export function passwordLengthIssue(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`
  return null
}
