import urls from './avatarPresetUrls.json' with { type: 'json' }

// Exact, versioned product assets only. Do not accept arbitrary /assets/ URLs,
// protocol-relative URLs, query strings, or user-controlled path suffixes.
const presetUrls = new Set<string>(urls)

export function isPresetAvatarUrl(value: string): boolean {
  return presetUrls.has(value)
}

/** 固定 v2.3 名单按不可变用户 ID 分配；只计算展示值，不改写用户已保存的选择。 */
export function resolveUserAvatarUrl(user: { id: number; avatarUrl?: string | null }): string {
  return user.avatarUrl || urls[(user.id - 1) % urls.length]
}
