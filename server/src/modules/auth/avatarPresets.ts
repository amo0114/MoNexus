import urls from './avatarPresetUrls.json' with { type: 'json' }

// Exact, versioned product assets only. Do not accept arbitrary /assets/ URLs,
// protocol-relative URLs, query strings, or user-controlled path suffixes.
const presetUrls = new Set<string>(urls)

export function isPresetAvatarUrl(value: string): boolean {
  return presetUrls.has(value)
}
