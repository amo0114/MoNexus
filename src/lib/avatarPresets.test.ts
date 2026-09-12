import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { AVATAR_PRESETS, avatarSrcSet } from './avatarPresets'

describe('released avatar contract', () => {
  it('ships the approved roster and every backend-accepted URL as an immutable image', () => {
    const backendUrls = JSON.parse(readFileSync('server/src/modules/auth/avatarPresetUrls.json', 'utf8'))
    const provenance = JSON.parse(readFileSync('docs/assets/three-kingdoms-v2.3.json', 'utf8'))
    expect(AVATAR_PRESETS).toHaveLength(24)
    expect(new Set(AVATAR_PRESETS.map((a) => a.id)).size).toBe(24)
    expect(AVATAR_PRESETS.map((a) => a.url)).toEqual(backendUrls)
    for (const faction of ['wei', 'shu', 'wu']) expect(AVATAR_PRESETS.filter((a) => a.faction === faction)).toHaveLength(8)
    expect(AVATAR_PRESETS.map((a) => a.id)).toEqual(expect.arrayContaining(['wei-guo-jia', 'wei-xun-yu', 'wu-zhou-tai']))
    expect(AVATAR_PRESETS.some((a) => ['wei-cao-pi', 'wu-sun-jian'].includes(a.id))).toBe(false)
    for (const a of AVATAR_PRESETS) {
      const record = provenance.avatars.find((r: { id: string }) => r.id === a.id)
      for (const url of [a.url, a.thumbnailUrl, a.smallUrl]) {
        const data = readFileSync(`public${url}`)
        expect(data.toString('ascii', 8, 12)).toBe('WEBP')
        expect(createHash('sha256').update(data).digest('hex')).toBe(record.assets.find((r: { url: string }) => r.url === url).sha256)
      }
    }
  })

  it('offers responsive sizes only for exact known preset URLs', () => {
    const a = AVATAR_PRESETS[0]
    expect(avatarSrcSet(a.url)).toContain(`${a.smallUrl} 48w`)
    expect(avatarSrcSet(a.url)).toContain(`${a.thumbnailUrl} 96w`)
    expect(avatarSrcSet(a.url)).toContain(`${a.url} 443w`)
    expect(avatarSrcSet(`https://files.example${a.url}`)).toBeUndefined()
    expect(avatarSrcSet(null)).toBeUndefined()
  })
})
