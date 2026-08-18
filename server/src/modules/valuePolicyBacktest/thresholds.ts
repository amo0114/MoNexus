export const INPUT_SCHEMA_VERSION = 1
export const REPORT_SCHEMA_VERSION = 1
export const CNY_SCALE = 2
export const CNY_ATOMIC_PER_MAJOR = 100n
export const POINT_ASSET_CODE = 'RP'
export const POINT_SCALE = 0
export const SUPPORTED_REFERENCE_ASSET = 'CNY'
export const ROUNDING_MODE = 'HALF_EVEN' as const
export const D02_STATUS = 'NOT APPROVED' as const
export const DEFAULT_ANALYSIS_CANDIDATES = [50, 100, 200, 500] as const
export const BASELINE_POINTS_PER_CNY_MAJOR = 100
export const RATE_DECIMAL_SCALE = 4
export const COUNT_DECIMAL_SCALE = 2

export const INPUT_LIMITS = {
  maxFileBytes: 16 * 1024 * 1024,
  maxOffers: 50_000,
  maxAccounts: 50_000,
  maxMonthlyActivity: 200_000,
  maxOrders: 200_000,
} as const

/**
 * Decision-support thresholds. These are not production policy and do not
 * approve any D-02 candidate. Every value is copied into the report.
 */
export type GateThresholds = {
  minSampleOffers: number
  minSampleAccounts: number
  minSampleMonthlyActivity: number
  minSampleCategory: number
  minSampleConcentrationTop1: number
  minSampleConcentrationTop5: number
  minMerchantCostCoverageRate: string
  dataCoverageWarnBelowRate: string
  priceReadabilityMinP50Atomic: string
  priceReadabilityMaxP50Atomic: string
  priceReadabilityFailIfP50Atomic: string
  rewardBudgetUnspentWarnAboveRate: string
  affordabilityWarnMonthsToP50: string
  affordabilityFailIfCanBuyP50Below: string
  merchantBelowCostWarnAboveRate: string
  merchantBelowCostFailAboveRate: string
  roundingWarnAboveRate: string
  roundingFailAboveRate: string
  concentrationTop1WarnAboveRate: string
  concentrationTop1FailAboveRate: string
  concentrationTop5WarnAboveRate: string
  concentrationTop5FailAboveRate: string
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minSampleOffers: 10,
  minSampleAccounts: 10,
  minSampleMonthlyActivity: 10,
  minSampleCategory: 10,
  minSampleConcentrationTop1: 100,
  minSampleConcentrationTop5: 20,
  minMerchantCostCoverageRate: '0.8000',
  dataCoverageWarnBelowRate: '0.8000',
  priceReadabilityMinP50Atomic: '100',
  priceReadabilityMaxP50Atomic: '100000',
  priceReadabilityFailIfP50Atomic: '0',
  rewardBudgetUnspentWarnAboveRate: '0.8000',
  affordabilityWarnMonthsToP50: '3.00',
  affordabilityFailIfCanBuyP50Below: '1.00',
  merchantBelowCostWarnAboveRate: '0.1000',
  merchantBelowCostFailAboveRate: '0.3000',
  roundingWarnAboveRate: '0.0500',
  roundingFailAboveRate: '0.2000',
  concentrationTop1WarnAboveRate: '0.4000',
  concentrationTop1FailAboveRate: '0.5000',
  concentrationTop5WarnAboveRate: '0.4000',
  concentrationTop5FailAboveRate: '0.7000',
}

export const FIXED_CONCLUSIONS = [
  'D-02 remains NOT APPROVED',
  'this report is decision support only',
  'finance/product/legal approval is still required',
  'no production ValuePolicy was created or activated',
  'CNY reference value is not a cash redemption promise',
] as const

export const REWARD_BUDGET_DISCLAIMER = 'reference-value estimate, not accounting liability'
export const REFERENCE_VALUE_EXPOSURE_LABEL = 'reference-value exposure'
