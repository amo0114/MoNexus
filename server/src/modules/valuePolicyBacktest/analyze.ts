import { serializeCandidate, type NormalizedCandidate } from './candidates.js'
import { convertPoints, formatSignedCnyFromAtomic, isExactConversion, roundingDeltaAtomic } from './convert.js'
import { formatCnyFromAtomic, formatRate } from './format.js'
import {
  concentrationTopShare,
  monthsToAfford,
  quantileMap,
  quantileNearestRank,
  ratioOrNull,
  sumBigint,
  unitsAffordable,
} from './stats.js'
import {
  BASELINE_POINTS_PER_CNY_MAJOR,
  REWARD_BUDGET_DISCLAIMER,
  type GateThresholds,
} from './thresholds.js'
import type {
  AffordabilityAnalysis,
  BacktestReport,
  BalanceAnalysis,
  CandidateAnalysis,
  CoverageMetric,
  MerchantUnitEconomics,
  OfferPriceAnalysis,
  QuantileBundle,
  RewardBudgetAnalysis,
  RoundingStats,
  SensitivityRow,
  UserActivityAnalysis,
  ValidatedInput,
} from './types.js'

function coverage(present: number, total: number): CoverageMetric {
  if (total === 0) {
    return { present, total, rate: null, missingRate: null, reason: 'empty_population' }
  }
  return {
    present,
    total,
    rate: formatRate(BigInt(present), BigInt(total)),
    missingRate: formatRate(BigInt(total - present), BigInt(total)),
    reason: null,
  }
}

function sortBigints(values: readonly bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function pointQuantiles(values: readonly bigint[]) {
  const sorted = sortBigints(values)
  const mapped = quantileMap(sorted)
  return {
    ...mapped,
    min: sorted.length === 0 ? null : sorted[0].toString(10),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1].toString(10),
    median: mapped.p50,
  }
}

function referenceQuantiles(points: readonly bigint[], candidate: NormalizedCandidate) {
  const atomics = points.map(value => convertPoints(value, candidate))
  const mapped = pointQuantiles(atomics)
  return {
    atomic: mapped,
    cny: {
      p10: mapped.p10 === null ? null : formatCnyFromAtomic(BigInt(mapped.p10)),
      p25: mapped.p25 === null ? null : formatCnyFromAtomic(BigInt(mapped.p25)),
      p50: mapped.p50 === null ? null : formatCnyFromAtomic(BigInt(mapped.p50)),
      p75: mapped.p75 === null ? null : formatCnyFromAtomic(BigInt(mapped.p75)),
      p90: mapped.p90 === null ? null : formatCnyFromAtomic(BigInt(mapped.p90)),
      min: mapped.min === null ? null : formatCnyFromAtomic(BigInt(mapped.min)),
      max: mapped.max === null ? null : formatCnyFromAtomic(BigInt(mapped.max)),
      median: mapped.median === null ? null : formatCnyFromAtomic(BigInt(mapped.median)),
    },
  }
}

function bundleDistribution(points: readonly bigint[], candidate: NormalizedCandidate): QuantileBundle {
  const reference = referenceQuantiles(points, candidate)
  return {
    points: pointQuantiles(points),
    referenceAtomic: reference.atomic,
    referenceCny: reference.cny,
  }
}

function roundingStats(points: readonly bigint[], candidate: NormalizedCandidate): RoundingStats {
  if (points.length === 0) {
    return {
      sampleSize: 0,
      roundedCount: 0,
      incidence: null,
      cumulativeRoundingDeltaAtomic: '0',
      reason: 'empty_sample',
    }
  }
  let roundedCount = 0
  let delta = 0n
  for (const value of points) {
    if (!isExactConversion(value, candidate)) {
      roundedCount += 1
    }
    delta += roundingDeltaAtomic(value, candidate)
  }
  return {
    sampleSize: points.length,
    roundedCount,
    incidence: formatRate(BigInt(roundedCount), BigInt(points.length)),
    cumulativeRoundingDeltaAtomic: delta.toString(10),
    reason: null,
  }
}

function analyzeOffers(input: ValidatedInput, candidate: NormalizedCandidate, thresholds: GateThresholds): OfferPriceAnalysis {
  const prices = input.offers.map(offer => offer.pricePoints)
  if (prices.length < thresholds.minSampleOffers) {
    return {
      sampleSize: prices.length,
      suppressed: true,
      reason: prices.length === 0 ? 'empty_sample' : 'sample_below_threshold',
      distribution: null,
      rounding: null,
      byCategory: [],
    }
  }

  const byCategoryMap = new Map<string, bigint[]>()
  for (const offer of input.offers) {
    const list = byCategoryMap.get(offer.category) ?? []
    list.push(offer.pricePoints)
    byCategoryMap.set(offer.category, list)
  }

  const byCategory = [...byCategoryMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, categoryPrices]) => {
      if (categoryPrices.length < thresholds.minSampleCategory) {
        return {
          category,
          sampleSize: categoryPrices.length,
          suppressed: true,
          reason: 'sample_below_threshold',
          distribution: null,
          rounding: null,
        }
      }
      return {
        category,
        sampleSize: categoryPrices.length,
        suppressed: false,
        reason: null,
        distribution: bundleDistribution(categoryPrices, candidate),
        rounding: roundingStats(categoryPrices, candidate),
      }
    })

  return {
    sampleSize: prices.length,
    suppressed: false,
    reason: null,
    distribution: bundleDistribution(prices, candidate),
    rounding: roundingStats(prices, candidate),
    byCategory,
  }
}

function userMonthNet(row: ValidatedInput['monthlyActivity'][number]): bigint {
  return row.earnedPoints - row.spentPoints - row.expiredPoints + row.refundedPoints
}

function analyzeUserActivity(
  input: ValidatedInput,
  candidate: NormalizedCandidate,
  thresholds: GateThresholds,
): UserActivityAnalysis {
  const activityByAccount = new Map<string, ValidatedInput['monthlyActivity']>()
  for (const row of input.monthlyActivity) {
    const list = activityByAccount.get(row.accountRef) ?? []
    list.push(row)
    activityByAccount.set(row.accountRef, list)
  }

  const expectedRows = input.accounts.length * input.period.months.length
  const accountsWithActivity = coverage(activityByAccount.size, input.accounts.length)
  const activityRows = coverage(input.monthlyActivity.length, expectedRows)

  if (input.monthlyActivity.length < thresholds.minSampleMonthlyActivity
    || input.accounts.length < thresholds.minSampleAccounts) {
    return {
      sampleSizeUsers: input.accounts.length,
      sampleSizeUserMonths: input.monthlyActivity.length,
      suppressed: true,
      reason: 'sample_below_threshold',
      monthlyAveragePoints: null,
      monthlyAverageReferenceAtomic: null,
      monthlyAverageReferenceCny: null,
      monthlyEarnSpendRatio: input.period.months.map(month => ({
        month,
        earnedPoints: '0',
        spentPoints: '0',
        ratio: null,
        reason: 'sample_below_threshold',
      })),
      zeroSpendUserRate: { rate: null, reason: 'sample_below_threshold' },
      activeSpenderRate: { rate: null, reason: 'sample_below_threshold' },
      coverage: { accountsWithActivity, activityRows },
    }
  }

  const avgEarned: bigint[] = []
  const avgSpent: bigint[] = []
  const avgNet: bigint[] = []
  const avgEarnedRef: bigint[] = []
  const avgSpentRef: bigint[] = []
  const avgNetRef: bigint[] = []

  for (const rows of activityByAccount.values()) {
    const monthCount = BigInt(rows.length)
    const earned = sumBigint(rows.map(row => row.earnedPoints))
    const spent = sumBigint(rows.map(row => row.spentPoints))
    const net = sumBigint(rows.map(row => userMonthNet(row)))
    const earnedRef = sumBigint(rows.map(row => convertPoints(row.earnedPoints, candidate)))
    const spentRef = sumBigint(rows.map(row => convertPoints(row.spentPoints, candidate)))
    const netRef = earnedRef - spentRef
      - sumBigint(rows.map(row => convertPoints(row.expiredPoints, candidate)))
      + sumBigint(rows.map(row => convertPoints(row.refundedPoints, candidate)))
    avgEarned.push(earned / monthCount)
    avgSpent.push(spent / monthCount)
    avgNet.push(net / monthCount)
    avgEarnedRef.push(earnedRef / monthCount)
    avgSpentRef.push(spentRef / monthCount)
    avgNetRef.push(netRef / monthCount)
  }

  const earnedMap = quantileMap(avgEarned)
  const spentMap = quantileMap(avgSpent)
  const netMap = quantileMap(avgNet)
  const earnedRefMap = quantileMap(avgEarnedRef)
  const spentRefMap = quantileMap(avgSpentRef)
  const netRefMap = quantileMap(avgNetRef)

  const spentByAccount = new Map<string, bigint>()
  for (const account of input.accounts) {
    spentByAccount.set(account.accountRef, 0n)
  }
  for (const row of input.monthlyActivity) {
    spentByAccount.set(row.accountRef, (spentByAccount.get(row.accountRef) ?? 0n) + row.spentPoints)
  }
  let zeroSpend = 0
  let activeSpend = 0
  for (const spent of spentByAccount.values()) {
    if (spent === 0n) {
      zeroSpend += 1
    } else {
      activeSpend += 1
    }
  }

  const monthlyEarnSpendRatio = input.period.months.map((month) => {
    const rows = input.monthlyActivity.filter(row => row.month === month)
    const earnedPoints = sumBigint(rows.map(row => row.earnedPoints))
    const spentPoints = sumBigint(rows.map(row => row.spentPoints))
    const ratio = ratioOrNull(earnedPoints, spentPoints, 'zero_spent_in_month')
    return {
      month,
      earnedPoints: earnedPoints.toString(10),
      spentPoints: spentPoints.toString(10),
      ratio: ratio.rate,
      reason: ratio.reason,
    }
  })

  const toSignedCny = (value: string | null) => (
    value === null ? null : formatSignedCnyFromAtomic(BigInt(value))
  )

  return {
    sampleSizeUsers: input.accounts.length,
    sampleSizeUserMonths: input.monthlyActivity.length,
    suppressed: false,
    reason: null,
    monthlyAveragePoints: {
      earned: { p10: earnedMap.p10, p50: earnedMap.p50, p90: earnedMap.p90 },
      spent: { p10: spentMap.p10, p50: spentMap.p50, p90: spentMap.p90 },
      net: { p10: netMap.p10, p50: netMap.p50, p90: netMap.p90 },
    },
    monthlyAverageReferenceAtomic: {
      earned: { p10: earnedRefMap.p10, p50: earnedRefMap.p50, p90: earnedRefMap.p90 },
      spent: { p10: spentRefMap.p10, p50: spentRefMap.p50, p90: spentRefMap.p90 },
      net: { p10: netRefMap.p10, p50: netRefMap.p50, p90: netRefMap.p90 },
    },
    monthlyAverageReferenceCny: {
      earned: {
        p10: toSignedCny(earnedRefMap.p10),
        p50: toSignedCny(earnedRefMap.p50),
        p90: toSignedCny(earnedRefMap.p90),
      },
      spent: {
        p10: toSignedCny(spentRefMap.p10),
        p50: toSignedCny(spentRefMap.p50),
        p90: toSignedCny(spentRefMap.p90),
      },
      net: {
        p10: toSignedCny(netRefMap.p10),
        p50: toSignedCny(netRefMap.p50),
        p90: toSignedCny(netRefMap.p90),
      },
    },
    monthlyEarnSpendRatio,
    zeroSpendUserRate: ratioOrNull(BigInt(zeroSpend), BigInt(input.accounts.length), 'empty_population'),
    activeSpenderRate: ratioOrNull(BigInt(activeSpend), BigInt(input.accounts.length), 'empty_population'),
    coverage: { accountsWithActivity, activityRows },
  }
}

function analyzeBalances(input: ValidatedInput, candidate: NormalizedCandidate, thresholds: GateThresholds): BalanceAnalysis {
  const available = input.accounts.map(account => account.balancePoints)
  const frozen = input.accounts.map(account => account.frozenPoints)
  const total = input.accounts.map(account => account.balancePoints + account.frozenPoints)
  const availableMap = quantileMap(available)
  const frozenMap = quantileMap(frozen)
  const totalMap = quantileMap(total)
  const availableRef = available.map(value => convertPoints(value, candidate))
  const frozenRef = frozen.map(value => convertPoints(value, candidate))
  const totalRef = total.map(value => convertPoints(value, candidate))
  const availableRefMap = quantileMap(availableRef)
  const frozenRefMap = quantileMap(frozenRef)
  const totalRefMap = quantileMap(totalRef)
  const exposure = sumBigint(totalRef)
  const suppressed = input.accounts.length < thresholds.minSampleAccounts

  return {
    sampleSize: input.accounts.length,
    suppressed,
    reason: suppressed ? (input.accounts.length === 0 ? 'empty_sample' : 'sample_below_threshold') : null,
    availablePoints: { p10: availableMap.p10, p50: availableMap.p50, p90: availableMap.p90 },
    frozenPoints: { p10: frozenMap.p10, p50: frozenMap.p50, p90: frozenMap.p90 },
    totalPoints: { p10: totalMap.p10, p50: totalMap.p50, p90: totalMap.p90 },
    availableReferenceAtomic: { p10: availableRefMap.p10, p50: availableRefMap.p50, p90: availableRefMap.p90 },
    frozenReferenceAtomic: { p10: frozenRefMap.p10, p50: frozenRefMap.p50, p90: frozenRefMap.p90 },
    totalReferenceAtomic: { p10: totalRefMap.p10, p50: totalRefMap.p50, p90: totalRefMap.p90 },
    availableReferenceCny: {
      p10: availableRefMap.p10 === null ? null : formatCnyFromAtomic(BigInt(availableRefMap.p10)),
      p50: availableRefMap.p50 === null ? null : formatCnyFromAtomic(BigInt(availableRefMap.p50)),
      p90: availableRefMap.p90 === null ? null : formatCnyFromAtomic(BigInt(availableRefMap.p90)),
    },
    frozenReferenceCny: {
      p10: frozenRefMap.p10 === null ? null : formatCnyFromAtomic(BigInt(frozenRefMap.p10)),
      p50: frozenRefMap.p50 === null ? null : formatCnyFromAtomic(BigInt(frozenRefMap.p50)),
      p90: frozenRefMap.p90 === null ? null : formatCnyFromAtomic(BigInt(frozenRefMap.p90)),
    },
    totalReferenceCny: {
      p10: totalRefMap.p10 === null ? null : formatCnyFromAtomic(BigInt(totalRefMap.p10)),
      p50: totalRefMap.p50 === null ? null : formatCnyFromAtomic(BigInt(totalRefMap.p50)),
      p90: totalRefMap.p90 === null ? null : formatCnyFromAtomic(BigInt(totalRefMap.p90)),
    },
    referenceValueExposureAtomic: exposure.toString(10),
    referenceValueExposureCny: formatCnyFromAtomic(exposure),
    concentration: {
      top1Percent: concentrationTopShare(totalRef, 1, thresholds.minSampleConcentrationTop1),
      top5Percent: concentrationTopShare(totalRef, 5, thresholds.minSampleConcentrationTop5),
    },
  }
}

function analyzeAffordability(
  input: ValidatedInput,
  candidate: NormalizedCandidate,
  activity: UserActivityAnalysis,
  offers: OfferPriceAnalysis,
): AffordabilityAnalysis {
  const medianMonthlyEarnedPoints = activity.monthlyAveragePoints?.earned.p50 ?? null
  const p10Offer = offers.distribution?.points.p10 ?? null
  const p50Offer = offers.distribution?.points.p50 ?? null
  const p90Offer = offers.distribution?.points.p90 ?? null
  const earned = medianMonthlyEarnedPoints === null ? null : BigInt(medianMonthlyEarnedPoints)
  const p50OfferPoints = p50Offer === null ? null : BigInt(p50Offer)

  let insufficient = coverage(0, input.accounts.length)
  if (p50OfferPoints !== null && input.accounts.length > 0) {
    const below = input.accounts.filter(account => account.balancePoints < p50OfferPoints).length
    insufficient = coverage(below, input.accounts.length)
  } else if (p50OfferPoints === null) {
    insufficient = { present: 0, total: input.accounts.length, rate: null, missingRate: null, reason: 'missing_p50_offer' }
  }

  return {
    medianMonthlyEarnedPoints,
    p50OfferPoints: p50Offer,
    p50OffersBuyableWithMedianEarned: earned === null || p50OfferPoints === null
      ? { units: null, reason: earned === null ? 'missing_median_earned' : 'missing_p50_offer' }
      : unitsAffordable(earned, p50OfferPoints),
    monthsOfMedianEarnedToAfford: {
      p10Offer: earned === null || p10Offer === null
        ? { months: null, reason: earned === null ? 'missing_median_earned' : 'missing_p10_offer' }
        : monthsToAfford(BigInt(p10Offer), earned),
      p50Offer: earned === null || p50OfferPoints === null
        ? { months: null, reason: earned === null ? 'missing_median_earned' : 'missing_p50_offer' }
        : monthsToAfford(p50OfferPoints, earned),
      p90Offer: earned === null || p90Offer === null
        ? { months: null, reason: earned === null ? 'missing_median_earned' : 'missing_p90_offer' }
        : monthsToAfford(BigInt(p90Offer), earned),
    },
    insufficientBalanceCoverage: {
      accountsBelowP50Offer: insufficient,
    },
  }
}

function analyzeRewardBudget(input: ValidatedInput, candidate: NormalizedCandidate): RewardBudgetAnalysis {
  const byMonth = input.period.months.map((month) => {
    const rows = input.monthlyActivity.filter(row => row.month === month)
    const earnedPoints = sumBigint(rows.map(row => row.earnedPoints))
    const spentPoints = sumBigint(rows.map(row => row.spentPoints))
    const expiredPoints = sumBigint(rows.map(row => row.expiredPoints))
    const refundedPoints = sumBigint(rows.map(row => row.refundedPoints))
    const unspentPoints = earnedPoints - spentPoints
    const earnedReferenceAtomic = convertPoints(earnedPoints, candidate)
    const spentReferenceAtomic = convertPoints(spentPoints, candidate)
    const unspentReferenceAtomic = earnedReferenceAtomic - spentReferenceAtomic
    return {
      month,
      earnedPoints: earnedPoints.toString(10),
      spentPoints: spentPoints.toString(10),
      expiredPoints: expiredPoints.toString(10),
      refundedPoints: refundedPoints.toString(10),
      unspentPoints: unspentPoints.toString(10),
      earnedReferenceAtomic: earnedReferenceAtomic.toString(10),
      spentReferenceAtomic: spentReferenceAtomic.toString(10),
      unspentReferenceAtomic: unspentReferenceAtomic.toString(10),
      earnedReferenceCny: formatCnyFromAtomic(earnedReferenceAtomic),
      spentReferenceCny: formatCnyFromAtomic(spentReferenceAtomic),
      unspentReferenceCny: formatSignedCnyFromAtomic(unspentReferenceAtomic),
    }
  })

  const earnedPoints = sumBigint(byMonth.map(row => BigInt(row.earnedPoints)))
  const spentPoints = sumBigint(byMonth.map(row => BigInt(row.spentPoints)))
  const expiredPoints = sumBigint(byMonth.map(row => BigInt(row.expiredPoints)))
  const refundedPoints = sumBigint(byMonth.map(row => BigInt(row.refundedPoints)))
  const unspentPoints = earnedPoints - spentPoints
  const earnedReferenceAtomic = convertPoints(earnedPoints, candidate)
  const spentReferenceAtomic = convertPoints(spentPoints, candidate)
  const unspentReferenceAtomic = earnedReferenceAtomic - spentReferenceAtomic

  return {
    disclaimer: REWARD_BUDGET_DISCLAIMER,
    byMonth,
    totals: {
      earnedPoints: earnedPoints.toString(10),
      spentPoints: spentPoints.toString(10),
      expiredPoints: expiredPoints.toString(10),
      refundedPoints: refundedPoints.toString(10),
      unspentPoints: unspentPoints.toString(10),
      earnedReferenceAtomic: earnedReferenceAtomic.toString(10),
      spentReferenceAtomic: spentReferenceAtomic.toString(10),
      unspentReferenceAtomic: unspentReferenceAtomic.toString(10),
      earnedReferenceCny: formatCnyFromAtomic(earnedReferenceAtomic),
      spentReferenceCny: formatCnyFromAtomic(spentReferenceAtomic),
      unspentReferenceCny: formatSignedCnyFromAtomic(unspentReferenceAtomic),
    },
  }
}

function floorCommissionPoints(pricePoints: bigint, rateBps: bigint): bigint {
  return (pricePoints * rateBps) / 10000n
}

function analyzeMerchant(
  input: ValidatedInput,
  candidate: NormalizedCandidate,
  thresholds: GateThresholds,
  legacyCommissionBps: bigint | null,
): MerchantUnitEconomics {
  const withCost = input.offers.filter(offer => offer.merchantCostCnyAtomic !== null)
  const costCoverage = coverage(withCost.length, input.offers.length)
  const minCoverage = thresholds.minMerchantCostCoverageRate
  const coverageRate = costCoverage.rate
  const sufficient = coverageRate !== null && compareFixed(coverageRate, minCoverage) >= 0

  if (!sufficient) {
    return {
      emitted: false,
      reason: withCost.length === 0 ? 'merchant_cost_missing' : 'merchant_cost_coverage_below_threshold',
      costCoverage,
      sampleWithCost: withCost.length,
      referenceMinusCostAtomic: null,
      belowCostOfferRate: null,
      legacyCommission: {
        applied: false,
        rateBps: legacyCommissionBps === null ? null : legacyCommissionBps.toString(10),
        convention: 'FLOOR_on_points_then_HALF_EVEN_to_reference',
        beforeCommissionMinusCostAtomic: null,
        afterCommissionMinusCostAtomic: null,
        reason: 'unit_economics_suppressed',
      },
    }
  }

  const spreads = withCost.map((offer) => {
    const reference = convertPoints(offer.pricePoints, candidate)
    return reference - (offer.merchantCostCnyAtomic as bigint)
  })
  const spreadMap = quantileMap(spreads)
  const below = withCost.filter((offer) => {
    const reference = convertPoints(offer.pricePoints, candidate)
    return reference < (offer.merchantCostCnyAtomic as bigint)
  }).length

  let legacy: MerchantUnitEconomics['legacyCommission']
  if (legacyCommissionBps === null) {
    legacy = {
      applied: false,
      rateBps: null,
      convention: 'FLOOR_on_points_then_HALF_EVEN_to_reference',
      beforeCommissionMinusCostAtomic: null,
      afterCommissionMinusCostAtomic: null,
      reason: 'legacy_commission_rate_not_provided',
    }
  } else {
    const before = spreads
    const after = withCost.map((offer) => {
      const remainingPoints = offer.pricePoints - floorCommissionPoints(offer.pricePoints, legacyCommissionBps)
      return convertPoints(remainingPoints, candidate) - (offer.merchantCostCnyAtomic as bigint)
    })
    legacy = {
      applied: true,
      rateBps: legacyCommissionBps.toString(10),
      convention: 'FLOOR_on_points_then_HALF_EVEN_to_reference',
      beforeCommissionMinusCostAtomic: {
        p50: quantileMap(before).p50,
        sum: sumBigint(before).toString(10),
      },
      afterCommissionMinusCostAtomic: {
        p50: quantileMap(after).p50,
        sum: sumBigint(after).toString(10),
      },
      reason: null,
    }
  }

  return {
    emitted: true,
    reason: null,
    costCoverage,
    sampleWithCost: withCost.length,
    referenceMinusCostAtomic: {
      p10: spreadMap.p10,
      p50: spreadMap.p50,
      p90: spreadMap.p90,
      sum: sumBigint(spreads).toString(10),
    },
    belowCostOfferRate: ratioOrNull(BigInt(below), BigInt(withCost.length), 'empty_sample'),
    legacyCommission: legacy,
  }
}

export function compareFixed(left: string, right: string): number {
  const normalize = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    const sign = whole.startsWith('-') ? -1n : 1n
    const absWhole = whole.startsWith('-') ? whole.slice(1) : whole
    return { sign, whole: BigInt(absWhole || '0'), fraction }
  }
  const a = normalize(left)
  const b = normalize(right)
  const scale = Math.max(a.fraction.length, b.fraction.length)
  const toScaled = (part: typeof a) => {
    const frac = part.fraction.padEnd(scale, '0')
    return part.sign * (part.whole * (10n ** BigInt(scale)) + BigInt(frac || '0'))
  }
  const leftValue = toScaled(a)
  const rightValue = toScaled(b)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

export function analyzeCandidate(
  input: ValidatedInput,
  candidate: NormalizedCandidate,
  thresholds: GateThresholds,
  legacyCommissionBps: bigint | null,
): Omit<CandidateAnalysis, 'gates'> {
  const offerPrices = analyzeOffers(input, candidate, thresholds)
  const userActivity = analyzeUserActivity(input, candidate, thresholds)
  const balances = analyzeBalances(input, candidate, thresholds)
  const affordability = analyzeAffordability(input, candidate, userActivity, offerPrices)
  const rewardBudget = analyzeRewardBudget(input, candidate)
  const merchantUnitEconomics = analyzeMerchant(input, candidate, thresholds, legacyCommissionBps)
  return {
    candidate: serializeCandidate(candidate),
    offerPrices,
    userActivity,
    balances,
    affordability,
    rewardBudget,
    merchantUnitEconomics,
  }
}

export function buildSensitivity(analyses: Array<Omit<CandidateAnalysis, 'gates'> | CandidateAnalysis>): SensitivityRow[] {
  return analyses.map((analysis) => {
    const n = analysis.candidate.pointsPerCnyMajor
    const monthlyReward = analysis.rewardBudget.totals.earnedReferenceAtomic
    return {
      pointsPerCnyMajor: n,
      offerP50ReferenceAtomic: analysis.offerPrices.distribution?.referenceAtomic.p50 ?? null,
      offerP50ReferenceCny: analysis.offerPrices.distribution?.referenceCny.p50 ?? null,
      offerP90ReferenceAtomic: analysis.offerPrices.distribution?.referenceAtomic.p90 ?? null,
      offerP90ReferenceCny: analysis.offerPrices.distribution?.referenceCny.p90 ?? null,
      monthlyRewardReferenceAtomic: monthlyReward,
      monthlyRewardReferenceCny: analysis.rewardBudget.totals.earnedReferenceCny,
      totalBalanceReferenceValueExposureAtomic: analysis.balances.referenceValueExposureAtomic,
      totalBalanceReferenceValueExposureCny: analysis.balances.referenceValueExposureCny,
      roundingIncidence: analysis.offerPrices.rounding?.incidence ?? null,
      belowCostOfferRate: analysis.merchantUnitEconomics.belowCostOfferRate?.rate ?? null,
      p50OffersBuyableWithMedianEarned: analysis.affordability.p50OffersBuyableWithMedianEarned.units,
      multiplierVs100PtsPerCny: formatRate(BigInt(BASELINE_POINTS_PER_CNY_MAJOR), BigInt(n)),
    }
  })
}

export function inputCoverage(input: ValidatedInput): BacktestReport['metadata']['coverage'] {
  const withCost = input.offers.filter(offer => offer.merchantCostCnyAtomic !== null).length
  return {
    offers: input.offers.length,
    accounts: input.accounts.length,
    monthlyActivityRows: input.monthlyActivity.length,
    orders: input.orders.length,
    merchantCost: coverage(withCost, input.offers.length),
  }
}

export function medianOfferPoints(input: ValidatedInput): bigint | null {
  const prices = sortBigints(input.offers.map(offer => offer.pricePoints))
  return quantileNearestRank(prices, 50)
}
