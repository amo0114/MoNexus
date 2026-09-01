import { describe, expect, it } from 'vitest'
import {
  formatFenPointRatio,
  previewTenYuanCredit,
  vmqfoxCnyExampleRateMismatch,
} from './pricePolicyPreview'

describe('pricePolicyPreview', () => {
  it('renders 1 PTS per fen and ¥10.00 → 1000 积分', () => {
    expect(formatFenPointRatio('1', '1')).toBe('1 PTS / 1 分')
    expect(previewTenYuanCredit({
      currency: 'CNY',
      pointsNumerator: '1',
      pointsDenominator: '1',
    })).toEqual({
      ratio: '1 PTS / 1 分',
      tenYuanPoints: '1000',
      preview: '¥10.00 → 1000 积分',
    })
  })

  it('flags the VMQFox CNY example when ¥10.00 would not credit 1000 points', () => {
    expect(vmqfoxCnyExampleRateMismatch({
      code: 'rp-cny-vmqfox-v1',
      pointsNumerator: '1',
      pointsDenominator: '1',
    })).toBe(false)
    expect(vmqfoxCnyExampleRateMismatch({
      code: 'rp-cny-vmqfox-v1',
      pointsNumerator: '100',
      pointsDenominator: '1',
    })).toBe(true)
  })
})
