import { describe, expect, it } from 'vitest'
import { buildPayableRecognitionNotice } from './payableCopy'

describe('buildPayableRecognitionNotice', () => {
  it('returns prominent copy when payable amount differs from quoted amount', () => {
    expect(buildPayableRecognitionNotice({
      amountMinor: '1000',
      payableAmountMinor: '1001',
      totalPoints: '1000',
      currency: 'CNY',
    })).toEqual({
      headline: '应付 ¥10.01，到账后获得 1000 积分',
      detail: '（基础充值金额 ¥10.00；¥0.01 为订单识别金额，不增加积分）',
    })
  })

  it('returns null when amounts match so the UI adds no extra copy', () => {
    expect(buildPayableRecognitionNotice({
      amountMinor: '1000',
      payableAmountMinor: '1000',
      totalPoints: '1000',
      currency: 'CNY',
    })).toBeNull()
  })
})
