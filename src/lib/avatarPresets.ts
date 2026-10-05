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

/**
 * 基于用户标识（用户名、邮箱或 ID）计算确定性哈希，分配默认三国预设头像。
 * 确保同一用户在不同组件和会话间始终拥有一致、固定的三国人物头像，避免单调字母，同时避免每次刷新随机跳动。
 */
export function getDefaultAvatarPreset(seed?: string | number | null): AvatarPreset {
  if (!AVATAR_PRESETS || AVATAR_PRESETS.length === 0) {
    return {
      id: 'default',
      name: '默认',
      faction: 'wei',
      url: '',
      thumbnailUrl: '',
      smallUrl: '',
    }
  }

  if (!seed) {
    return AVATAR_PRESETS[0]
  }

  const str = String(seed).trim()
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0 // 转换为 32 位整数
  }
  const index = Math.abs(hash) % AVATAR_PRESETS.length
  return AVATAR_PRESETS[index]
}

export function avatarSrcSet(url?: string | null): string | undefined {
  const preset = getAvatarPreset(url)
  return preset ? `${preset.smallUrl} 48w, ${preset.thumbnailUrl} 96w, ${preset.url} 443w` : undefined
}
