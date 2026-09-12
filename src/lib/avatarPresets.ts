import catalog from '../data/avatarPresets.json'

export const AVATAR_FACTIONS = [
  { id: 'wei', name: '魏', label: '曹魏' },
  { id: 'shu', name: '蜀', label: '蜀汉' },
  { id: 'wu', name: '吴', label: '孙吴' },
] as const

export type AvatarFaction = typeof AVATAR_FACTIONS[number]['id']
export const AVATAR_PRESETS = catalog
export type AvatarPreset = typeof catalog[number]

export function getAvatarPreset(url?: string | null): AvatarPreset | undefined {
  return url ? AVATAR_PRESETS.find((avatar) => avatar.url === url) : undefined
}

export function avatarSrcSet(url?: string | null): string | undefined {
  const preset = getAvatarPreset(url)
  return preset ? `${preset.smallUrl} 48w, ${preset.thumbnailUrl} 96w, ${preset.url} 443w` : undefined
}
