import zxcvbn from 'zxcvbn'
import frequencyLists from 'zxcvbn/lib/frequency_lists.js'

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
const MIN_ZXCVBN_SCORE = 3

// zxcvbn's password list is ordered by frequency; its head is the common-password blacklist.
const COMMON_PASSWORDS = new Set(frequencyLists.passwords.slice(0, 10_000))

export interface PasswordContext {
  email?: string | null
  nickname?: string | null
}

/** Returns a user-facing reason when the password is rejected, otherwise null. */
export function passwordPolicyIssue(password: string, context: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return '该密码过于常见，请更换'

  const userInputs = [context.email?.split('@')[0], context.nickname, 'monexus']
    .filter((value): value is string => Boolean(value))
  if (zxcvbn(password, userInputs).score < MIN_ZXCVBN_SCORE) {
    return '密码强度不足，请使用字母、数字和符号的不易猜测组合，且不要包含邮箱或昵称'
  }
  return null
}
