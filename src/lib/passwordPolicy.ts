// Mirrors server/src/lib/passwordPolicy.ts for early feedback; the server stays authoritative.
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const PASSWORD_RULE_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位，避免常见密码，且不要包含邮箱或昵称`
const MIN_ZXCVBN_SCORE = 3

let estimatorPromise: Promise<(password: string, userInputs: string[]) => number> | undefined

// zxcvbn and its dictionaries are large, so only password forms load them.
function loadEstimator() {
  estimatorPromise ??= Promise.all([
    import('zxcvbn'),
    import('zxcvbn/lib/frequency_lists.js'),
  ]).then(([{ default: zxcvbn }, { default: frequencyLists }]) => {
    const commonPasswords = new Set(frequencyLists.passwords.slice(0, 10_000))
    return (password: string, userInputs: string[]) => (
      commonPasswords.has(password.toLowerCase()) ? -1 : zxcvbn(password, userInputs).score
    )
  }).catch((error: unknown) => {
    // Let the next submit retry a failed chunk load instead of caching the rejection.
    estimatorPromise = undefined
    throw error
  })
  return estimatorPromise
}

export interface PasswordContext {
  email?: string | null
  nickname?: string | null
}

/** Returns a user-facing reason when the password is rejected, otherwise null. */
export async function passwordPolicyIssue(password: string, context: PasswordContext = {}): Promise<string | null> {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`

  const estimate = await loadEstimator()
  const userInputs = [context.email?.split('@')[0], context.nickname, 'monexus']
    .filter((value): value is string => Boolean(value))
  const score = estimate(password, userInputs)
  if (score < 0) return '该密码过于常见，请更换'
  if (score < MIN_ZXCVBN_SCORE) {
    return '密码强度不足，请使用字母、数字和符号的不易猜测组合，且不要包含邮箱或昵称'
  }
  return null
}
