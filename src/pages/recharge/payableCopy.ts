import { formatCurrencyAmount } from './money'

export type PayableRecognitionNotice = {
  headline: string
  detail: string
}

/**
 * Extra copy is only shown when the buyer pays a different provider amount
 * than the quoted recharge amount. Points always follow amountMinor.
 */
export function buildPayableRecognitionNotice(input: {
  amountMinor: string
  payableAmountMinor: string
  totalPoints: string
  currency: string
}): PayableRecognitionNotice | null {
  if (input.amountMinor === input.payableAmountMinor) return null
  let deltaMinor: string
  try {
    const delta = BigInt(input.payableAmountMinor) - BigInt(input.amountMinor)
    deltaMinor = (delta < 0n ? -delta : delta).toString(10)
  } catch {
    return null
  }
  const payable = formatCurrencyAmount(input.payableAmountMinor, input.currency)
  const base = formatCurrencyAmount(input.amountMinor, input.currency)
  const delta = formatCurrencyAmount(deltaMinor, input.currency)
  return {
    headline: `应付 ${payable}，到账后获得 ${input.totalPoints} 积分`,
    detail: `（基础充值金额 ${base}；${delta} 为订单识别金额，不增加积分）`,
  }
}
