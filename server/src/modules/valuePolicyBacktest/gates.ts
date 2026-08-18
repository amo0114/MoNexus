import { compareFixed } from './analyze.js'
import { formatRate } from './format.js'
import type { GateThresholds } from './thresholds.js'
import type { CandidateAnalysis, GateResult, GateStatus } from './types.js'

function statusByRate(
  rate: string | null,
  warnAbove: string,
  failAbove: string,
  missingReason: string,
): { status: GateStatus; reason: string } {
  if (rate === null) {
    return { status: 'insufficient_data', reason: missingReason }
  }
  if (compareFixed(rate, failAbove) > 0) {
    return { status: 'fail', reason: 'above_fail_threshold' }
  }
  if (compareFixed(rate, warnAbove) > 0) {
    return { status: 'warn', reason: 'above_warn_threshold' }
  }
  return { status: 'pass', reason: 'within_threshold' }
}

function dataCoverageGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  const offerCount = analysis.offerPrices.sampleSize
  const accountCount = analysis.userActivity.sampleSizeUsers
  const activityCount = analysis.userActivity.sampleSizeUserMonths
  if (offerCount < thresholds.minSampleOffers
    || accountCount < thresholds.minSampleAccounts
    || activityCount < thresholds.minSampleMonthlyActivity) {
    return {
      name: 'DATA_COVERAGE',
      status: 'insufficient_data',
      reason: 'core_sample_below_threshold',
      evidence: { offerCount, accountCount, activityCount },
    }
  }
  const activityRate = analysis.userActivity.coverage.accountsWithActivity.rate
  if (activityRate === null) {
    return {
      name: 'DATA_COVERAGE',
      status: 'insufficient_data',
      reason: 'activity_coverage_unavailable',
      evidence: { offerCount, accountCount, activityCount },
    }
  }
  if (compareFixed(activityRate, thresholds.dataCoverageWarnBelowRate) < 0) {
    return {
      name: 'DATA_COVERAGE',
      status: 'warn',
      reason: 'activity_coverage_below_warn_threshold',
      evidence: { activityRate, threshold: thresholds.dataCoverageWarnBelowRate },
    }
  }
  return {
    name: 'DATA_COVERAGE',
    status: 'pass',
    reason: 'core_coverage_meets_threshold',
    evidence: { activityRate, offerCount, accountCount, activityCount },
  }
}

function priceReadabilityGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  const p50 = analysis.offerPrices.distribution?.referenceAtomic.p50 ?? null
  if (p50 === null) {
    return {
      name: 'PRICE_READABILITY',
      status: 'insufficient_data',
      reason: analysis.offerPrices.reason ?? 'missing_p50',
      evidence: { p50Atomic: null },
    }
  }
  if (compareFixed(p50, thresholds.priceReadabilityFailIfP50Atomic) === 0) {
    return {
      name: 'PRICE_READABILITY',
      status: 'fail',
      reason: 'p50_reference_rounds_to_zero',
      evidence: { p50Atomic: p50 },
    }
  }
  if (compareFixed(p50, thresholds.priceReadabilityMinP50Atomic) < 0
    || compareFixed(p50, thresholds.priceReadabilityMaxP50Atomic) > 0) {
    return {
      name: 'PRICE_READABILITY',
      status: 'warn',
      reason: 'p50_outside_readable_range',
      evidence: {
        p50Atomic: p50,
        minAtomic: thresholds.priceReadabilityMinP50Atomic,
        maxAtomic: thresholds.priceReadabilityMaxP50Atomic,
      },
    }
  }
  return {
    name: 'PRICE_READABILITY',
    status: 'pass',
    reason: 'p50_inside_readable_range',
    evidence: { p50Atomic: p50 },
  }
}

function rewardBudgetGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  if (analysis.userActivity.sampleSizeUserMonths === 0) {
    return {
      name: 'REWARD_BUDGET',
      status: 'insufficient_data',
      reason: 'no_monthly_activity',
      evidence: { earnedReferenceAtomic: analysis.rewardBudget.totals.earnedReferenceAtomic },
    }
  }
  const earned = analysis.rewardBudget.totals.earnedReferenceAtomic
  const unspent = analysis.rewardBudget.totals.unspentReferenceAtomic
  if (earned === '0') {
    return {
      name: 'REWARD_BUDGET',
      status: 'warn',
      reason: 'zero_earned_reference_value',
      evidence: { earnedReferenceAtomic: earned, disclaimer: analysis.rewardBudget.disclaimer },
    }
  }
  if (unspent.startsWith('-')) {
    return {
      name: 'REWARD_BUDGET',
      status: 'warn',
      reason: 'spent_exceeds_earned_in_window',
      evidence: { unspentReferenceAtomic: unspent, disclaimer: analysis.rewardBudget.disclaimer },
    }
  }
  const unspentRate = formatRate(BigInt(unspent), BigInt(earned))
  if (unspentRate !== null && compareFixed(unspentRate, thresholds.rewardBudgetUnspentWarnAboveRate) > 0) {
    return {
      name: 'REWARD_BUDGET',
      status: 'warn',
      reason: 'unspent_share_above_warn_threshold',
      evidence: { unspentRate, threshold: thresholds.rewardBudgetUnspentWarnAboveRate, disclaimer: analysis.rewardBudget.disclaimer },
    }
  }
  return {
    name: 'REWARD_BUDGET',
    status: 'pass',
    reason: 'estimate_available_not_accounting',
    evidence: { earnedReferenceAtomic: earned, disclaimer: analysis.rewardBudget.disclaimer },
  }
}

function affordabilityGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  const buyable = analysis.affordability.p50OffersBuyableWithMedianEarned
  const months = analysis.affordability.monthsOfMedianEarnedToAfford.p50Offer
  if (buyable.units === null) {
    return {
      name: 'USER_AFFORDABILITY',
      status: 'insufficient_data',
      reason: buyable.reason ?? 'missing_affordability',
      evidence: { units: null, months: months.months },
    }
  }
  if (compareFixed(buyable.units, thresholds.affordabilityFailIfCanBuyP50Below) < 0) {
    return {
      name: 'USER_AFFORDABILITY',
      status: 'fail',
      reason: 'median_earned_cannot_buy_p50_offer',
      evidence: { units: buyable.units, threshold: thresholds.affordabilityFailIfCanBuyP50Below },
    }
  }
  if (months.months !== null && compareFixed(months.months, thresholds.affordabilityWarnMonthsToP50) > 0) {
    return {
      name: 'USER_AFFORDABILITY',
      status: 'warn',
      reason: 'months_to_p50_above_warn_threshold',
      evidence: { months: months.months, threshold: thresholds.affordabilityWarnMonthsToP50 },
    }
  }
  return {
    name: 'USER_AFFORDABILITY',
    status: 'pass',
    reason: 'median_earned_covers_p50_offer',
    evidence: { units: buyable.units, months: months.months },
  }
}

function merchantGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  if (!analysis.merchantUnitEconomics.emitted) {
    return {
      name: 'MERCHANT_UNIT_ECONOMICS',
      status: 'insufficient_data',
      reason: analysis.merchantUnitEconomics.reason ?? 'not_emitted',
      evidence: {
        costCoverage: analysis.merchantUnitEconomics.costCoverage.rate,
        sampleWithCost: analysis.merchantUnitEconomics.sampleWithCost,
      },
    }
  }
  const below = analysis.merchantUnitEconomics.belowCostOfferRate
  const judged = statusByRate(
    below?.rate ?? null,
    thresholds.merchantBelowCostWarnAboveRate,
    thresholds.merchantBelowCostFailAboveRate,
    below?.reason ?? 'missing_below_cost_rate',
  )
  return {
    name: 'MERCHANT_UNIT_ECONOMICS',
    status: judged.status,
    reason: judged.reason,
    evidence: {
      belowCostOfferRate: below?.rate ?? null,
      warnAbove: thresholds.merchantBelowCostWarnAboveRate,
      failAbove: thresholds.merchantBelowCostFailAboveRate,
    },
  }
}

function roundingGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  const incidence = analysis.offerPrices.rounding?.incidence ?? null
  const judged = statusByRate(
    incidence,
    thresholds.roundingWarnAboveRate,
    thresholds.roundingFailAboveRate,
    analysis.offerPrices.rounding?.reason ?? 'missing_rounding',
  )
  return {
    name: 'ROUNDING_STABILITY',
    status: judged.status,
    reason: judged.reason,
    evidence: {
      incidence,
      warnAbove: thresholds.roundingWarnAboveRate,
      failAbove: thresholds.roundingFailAboveRate,
      cumulativeRoundingDeltaAtomic: analysis.offerPrices.rounding?.cumulativeRoundingDeltaAtomic ?? null,
    },
  }
}

function concentrationGate(analysis: Omit<CandidateAnalysis, 'gates'>, thresholds: GateThresholds): GateResult {
  const top1 = analysis.balances.concentration.top1Percent
  const top5 = analysis.balances.concentration.top5Percent
  if (top1.suppressed && top5.suppressed) {
    return {
      name: 'CONCENTRATION_RISK',
      status: 'insufficient_data',
      reason: 'concentration_sample_below_threshold',
      evidence: { top1Sample: top1.sampleSize, top5Sample: top5.sampleSize },
    }
  }
  const top1Judged = top1.suppressed || top1.share === null
    ? null
    : statusByRate(top1.share, thresholds.concentrationTop1WarnAboveRate, thresholds.concentrationTop1FailAboveRate, 'missing_top1')
  const top5Judged = top5.suppressed || top5.share === null
    ? null
    : statusByRate(top5.share, thresholds.concentrationTop5WarnAboveRate, thresholds.concentrationTop5FailAboveRate, 'missing_top5')
  const ranks: GateStatus[] = [top1Judged?.status, top5Judged?.status].filter((value): value is GateStatus => value !== null)
  const status: GateStatus = ranks.includes('fail')
    ? 'fail'
    : ranks.includes('warn')
      ? 'warn'
      : ranks.includes('pass')
        ? 'pass'
        : 'insufficient_data'
  return {
    name: 'CONCENTRATION_RISK',
    status,
    reason: status === 'pass' ? 'concentration_within_threshold' : 'concentration_exceeds_threshold_or_missing',
    evidence: {
      top1Share: top1.share,
      top5Share: top5.share,
      top1Suppressed: top1.suppressed,
      top5Suppressed: top5.suppressed,
    },
  }
}

export function evaluateGates(
  analysis: Omit<CandidateAnalysis, 'gates'>,
  thresholds: GateThresholds,
): GateResult[] {
  return [
    dataCoverageGate(analysis, thresholds),
    priceReadabilityGate(analysis, thresholds),
    rewardBudgetGate(analysis, thresholds),
    affordabilityGate(analysis, thresholds),
    merchantGate(analysis, thresholds),
    roundingGate(analysis, thresholds),
    concentrationGate(analysis, thresholds),
  ]
}
