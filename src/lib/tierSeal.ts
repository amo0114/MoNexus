import type { TierResponse } from '../api/points'

/** Decorative seal glyph per tier; tier names always come from the server label. */
export const TIER_SEALS: Record<TierResponse['tier'], string> = {
  bronze: '素',
  silver: '青',
  gold: '金',
  platinum: '玉',
}
