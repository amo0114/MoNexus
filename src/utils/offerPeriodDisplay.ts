/**
 * Faka / 订阅规格在商品页的展示文案。
 * 一次性 ≠ 流量重置：前者是长期订阅，后者只清零已用流量且要求已有同套餐。
 */

export type OfferPeriodKind =
  | 'monthly'
  | 'quarterly'
  | 'half_yearly'
  | 'yearly'
  | 'two_yearly'
  | 'three_yearly'
  | 'onetime'
  | 'reset_traffic'
  | 'unknown'

const NAME_HINTS: Array<{ re: RegExp; kind: OfferPeriodKind }> = [
  // 先匹配重置包，避免被「流量」字样误判
  { re: /重置包|流量重置|reset[_\s-]?traffic/i, kind: 'reset_traffic' },
  // Xboard 后台称 onetime 为「流量包 / 一次性流量包，无时间限制」
  { re: /流量包|一次性开通|一次性|长期|onetime|one[_\s-]?time/i, kind: 'onetime' },
  { re: /三年|three[_\s-]?year/i, kind: 'three_yearly' },
  { re: /两年|two[_\s-]?year/i, kind: 'two_yearly' },
  { re: /半年|half[_\s-]?year/i, kind: 'half_yearly' },
  { re: /年付|yearly|年卡/i, kind: 'yearly' },
  { re: /季付|quarter|季卡/i, kind: 'quarterly' },
  { re: /月付|monthly|月卡/i, kind: 'monthly' },
]

export function detectOfferPeriodKind(offer: {
  name?: string | null
  validityDays?: number | null
}): OfferPeriodKind {
  const name = offer.name ?? ''
  for (const { re, kind } of NAME_HINTS) {
    if (re.test(name)) return kind
  }
  return 'unknown'
}

/** 规格卡片副标题：比单纯「有效期 N 天」更清楚 */
export function offerPeriodSubtitle(offer: {
  name?: string | null
  validityDays?: number | null
}): string | null {
  const kind = detectOfferPeriodKind(offer)
  switch (kind) {
    case 'reset_traffic':
      return '重置流量 · 可多次使用 · 不延长到期'
    case 'onetime':
      return '一次性流量包 · 无时间限制'
    case 'monthly':
    case 'quarterly':
    case 'half_yearly':
    case 'yearly':
    case 'two_yearly':
    case 'three_yearly':
      return offer.validityDays != null ? `有效期 ${offer.validityDays} 天` : null
    default:
      return offer.validityDays != null ? `有效期 ${offer.validityDays} 天` : null
  }
}

/** 详情页「订阅时长」说明 */
export function offerPeriodDetailNote(offer: {
  name?: string | null
  validityDays?: number | null
}): { title: string; hint: string } | null {
  const kind = detectOfferPeriodKind(offer)
  if (kind === 'reset_traffic') {
    return {
      title: '重置包',
      hint: '对应 Xboard「重置包」：重置已用流量，可多次购买；不延长订阅到期；须已有本套餐',
    }
  }
  if (kind === 'onetime') {
    return {
      title: '流量包',
      hint: '对应 Xboard「流量包 / 一次性流量包」：无时间限制（长期）；与「重置包」不同',
    }
  }
  if (offer.validityDays != null) {
    return {
      title: `有效期 ${offer.validityDays} 天`,
      hint: '自交付起计算，到期前后均可续费',
    }
  }
  return null
}
