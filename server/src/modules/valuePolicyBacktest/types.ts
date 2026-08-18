import type { NormalizedCandidate } from './candidates.js'
import type { GateThresholds } from './thresholds.js'

export type OrderStatus = 'completed' | 'refunded' | 'cancelled' | 'pending'

export type BacktestOffer = {
  offerRef: string
  category: string
  pricePoints: bigint
  merchantCostCnyAtomic: bigint | null
}

export type BacktestAccount = {
  accountRef: string
  balancePoints: bigint
  frozenPoints: bigint
}

export type BacktestMonthlyActivity = {
  month: string
  accountRef: string
  earnedPoints: bigint
  spentPoints: bigint
  expiredPoints: bigint
  refundedPoints: bigint
}

export type BacktestOrder = {
  orderRef: string
  offerRef: string
  accountRef: string | null
  points: bigint
  status: OrderStatus
}

export type ValidatedInput = {
  schemaVersion: 1
  period: { from: string; to: string; fromMs: number; toMs: number; months: string[] }
  offers: BacktestOffer[]
  accounts: BacktestAccount[]
  monthlyActivity: BacktestMonthlyActivity[]
  orders: BacktestOrder[]
  rawSha256: string
  byteLength: number
}

export type CoverageMetric = {
  present: number
  total: number
  rate: string | null
  missingRate: string | null
  reason: string | null
}

export type QuantileBundle = {
  points: {
    p10: string | null
    p25: string | null
    p50: string | null
    p75: string | null
    p90: string | null
    min: string | null
    max: string | null
    median: string | null
  }
  referenceAtomic: {
    p10: string | null
    p25: string | null
    p50: string | null
    p75: string | null
    p90: string | null
    min: string | null
    max: string | null
    median: string | null
  }
  referenceCny: {
    p10: string | null
    p25: string | null
    p50: string | null
    p75: string | null
    p90: string | null
    min: string | null
    max: string | null
    median: string | null
  }
}

export type RoundingStats = {
  sampleSize: number
  roundedCount: number
  incidence: string | null
  cumulativeRoundingDeltaAtomic: string
  reason: string | null
}

export type OfferPriceAnalysis = {
  sampleSize: number
  suppressed: boolean
  reason: string | null
  distribution: QuantileBundle | null
  rounding: RoundingStats | null
  byCategory: Array<{
    category: string
    sampleSize: number
    suppressed: boolean
    reason: string | null
    distribution: QuantileBundle | null
    rounding: RoundingStats | null
  }>
}

export type UserActivityAnalysis = {
  sampleSizeUsers: number
  sampleSizeUserMonths: number
  suppressed: boolean
  reason: string | null
  monthlyAveragePoints: {
    earned: { p10: string | null; p50: string | null; p90: string | null }
    spent: { p10: string | null; p50: string | null; p90: string | null }
    net: { p10: string | null; p50: string | null; p90: string | null }
  } | null
  monthlyAverageReferenceAtomic: {
    earned: { p10: string | null; p50: string | null; p90: string | null }
    spent: { p10: string | null; p50: string | null; p90: string | null }
    net: { p10: string | null; p50: string | null; p90: string | null }
  } | null
  monthlyAverageReferenceCny: {
    earned: { p10: string | null; p50: string | null; p90: string | null }
    spent: { p10: string | null; p50: string | null; p90: string | null }
    net: { p10: string | null; p50: string | null; p90: string | null }
  } | null
  monthlyEarnSpendRatio: Array<{
    month: string
    earnedPoints: string
    spentPoints: string
    ratio: string | null
    reason: string | null
  }>
  zeroSpendUserRate: { rate: string | null; reason: string | null }
  activeSpenderRate: { rate: string | null; reason: string | null }
  coverage: {
    accountsWithActivity: CoverageMetric
    activityRows: CoverageMetric
  }
}

export type BalanceAnalysis = {
  sampleSize: number
  suppressed: boolean
  reason: string | null
  availablePoints: { p10: string | null; p50: string | null; p90: string | null }
  frozenPoints: { p10: string | null; p50: string | null; p90: string | null }
  totalPoints: { p10: string | null; p50: string | null; p90: string | null }
  availableReferenceAtomic: { p10: string | null; p50: string | null; p90: string | null }
  frozenReferenceAtomic: { p10: string | null; p50: string | null; p90: string | null }
  totalReferenceAtomic: { p10: string | null; p50: string | null; p90: string | null }
  availableReferenceCny: { p10: string | null; p50: string | null; p90: string | null }
  frozenReferenceCny: { p10: string | null; p50: string | null; p90: string | null }
  totalReferenceCny: { p10: string | null; p50: string | null; p90: string | null }
  referenceValueExposureAtomic: string
  referenceValueExposureCny: string
  concentration: {
    top1Percent: ReturnType<typeof import('./stats.js').concentrationTopShare>
    top5Percent: ReturnType<typeof import('./stats.js').concentrationTopShare>
  }
}

export type AffordabilityAnalysis = {
  medianMonthlyEarnedPoints: string | null
  p50OfferPoints: string | null
  p50OffersBuyableWithMedianEarned: { units: string | null; reason: string | null }
  monthsOfMedianEarnedToAfford: {
    p10Offer: { months: string | null; reason: string | null }
    p50Offer: { months: string | null; reason: string | null }
    p90Offer: { months: string | null; reason: string | null }
  }
  insufficientBalanceCoverage: {
    accountsBelowP50Offer: CoverageMetric
  }
}

export type RewardBudgetAnalysis = {
  disclaimer: string
  byMonth: Array<{
    month: string
    earnedPoints: string
    spentPoints: string
    expiredPoints: string
    refundedPoints: string
    unspentPoints: string
    earnedReferenceAtomic: string
    spentReferenceAtomic: string
    unspentReferenceAtomic: string
    earnedReferenceCny: string
    spentReferenceCny: string
    unspentReferenceCny: string
  }>
  totals: {
    earnedPoints: string
    spentPoints: string
    expiredPoints: string
    refundedPoints: string
    unspentPoints: string
    earnedReferenceAtomic: string
    spentReferenceAtomic: string
    unspentReferenceAtomic: string
    earnedReferenceCny: string
    spentReferenceCny: string
    unspentReferenceCny: string
  }
}

export type MerchantUnitEconomics = {
  emitted: boolean
  reason: string | null
  costCoverage: CoverageMetric
  sampleWithCost: number
  referenceMinusCostAtomic: {
    p10: string | null
    p50: string | null
    p90: string | null
    sum: string | null
  } | null
  belowCostOfferRate: { rate: string | null; reason: string | null } | null
  legacyCommission: {
    applied: boolean
    rateBps: string | null
    convention: 'FLOOR_on_points_then_HALF_EVEN_to_reference'
    beforeCommissionMinusCostAtomic: { p50: string | null; sum: string | null } | null
    afterCommissionMinusCostAtomic: { p50: string | null; sum: string | null } | null
    reason: string | null
  }
}

export type GateName =
  | 'DATA_COVERAGE'
  | 'PRICE_READABILITY'
  | 'REWARD_BUDGET'
  | 'USER_AFFORDABILITY'
  | 'MERCHANT_UNIT_ECONOMICS'
  | 'ROUNDING_STABILITY'
  | 'CONCENTRATION_RISK'

export type GateStatus = 'pass' | 'warn' | 'fail' | 'insufficient_data'

export type GateResult = {
  name: GateName
  status: GateStatus
  reason: string
  evidence: Record<string, string | number | boolean | null>
}

export type CandidateAnalysis = {
  candidate: ReturnType<typeof import('./candidates.js').serializeCandidate>
  offerPrices: OfferPriceAnalysis
  userActivity: UserActivityAnalysis
  balances: BalanceAnalysis
  affordability: AffordabilityAnalysis
  rewardBudget: RewardBudgetAnalysis
  merchantUnitEconomics: MerchantUnitEconomics
  gates: GateResult[]
}

export type SensitivityRow = {
  pointsPerCnyMajor: number
  offerP50ReferenceAtomic: string | null
  offerP50ReferenceCny: string | null
  offerP90ReferenceAtomic: string | null
  offerP90ReferenceCny: string | null
  monthlyRewardReferenceAtomic: string | null
  monthlyRewardReferenceCny: string | null
  totalBalanceReferenceValueExposureAtomic: string | null
  totalBalanceReferenceValueExposureCny: string | null
  roundingIncidence: string | null
  belowCostOfferRate: string | null
  p50OffersBuyableWithMedianEarned: string | null
  multiplierVs100PtsPerCny: string | null
}

export type BacktestReport = {
  schemaVersion: 1
  d02Status: 'NOT APPROVED'
  conclusions: readonly string[]
  metadata: {
    inputSha256: string
    gitCommit: string
    executedAt: string
    candidates: number[]
    candidatesSource: 'explicit_cli' | 'documented_default_analysis_set'
    referenceAsset: 'CNY'
    inputSchemaVersion: 1
    reportSchemaVersion: 1
    roundingMode: 'HALF_EVEN'
    pointAsset: { code: 'RP'; scale: 0 }
    referenceAssetScale: 2
    gatesConfigSource: 'documented_defaults' | 'explicit_file'
    gatesThresholds: GateThresholds
    limits: typeof import('./thresholds.js').INPUT_LIMITS
    period: { from: string; to: string; months: string[] }
    coverage: {
      offers: number
      accounts: number
      monthlyActivityRows: number
      orders: number
      merchantCost: CoverageMetric
    }
    legacyCommissionRateBps: string | null
    rewardBudgetDisclaimer: string
    referenceValueExposureLabel: string
  }
  candidates: CandidateAnalysis[]
  sensitivity: SensitivityRow[]
}

export type BacktestRuntime = {
  now: () => Date
  gitCommit: () => string
}

export type ParsedCliArgs = {
  input: string
  output: string
  candidates: number[] | null
  referenceAsset: string
  overwrite: boolean
  gatesConfigPath: string | null
  legacyCommissionBps: string | null
  help: boolean
}

export type RunOptions = {
  inputPath: string
  outputDir: string
  candidates: number[]
  candidatesSource: 'explicit_cli' | 'documented_default_analysis_set'
  referenceAsset: string
  overwrite: boolean
  thresholds: GateThresholds
  gatesConfigSource: 'documented_defaults' | 'explicit_file'
  legacyCommissionBps: bigint | null
  runtime: BacktestRuntime
}

export type { NormalizedCandidate, GateThresholds }
