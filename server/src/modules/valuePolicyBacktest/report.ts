import { analyzeCandidate, buildSensitivity, inputCoverage } from './analyze.js'
import { normalizeCandidate } from './candidates.js'
import { evaluateGates } from './gates.js'
import {
  CNY_SCALE,
  D02_STATUS,
  D02_STATUS_TEXT,
  FIXED_CONCLUSIONS,
  INPUT_LIMITS,
  INPUT_SCHEMA_VERSION,
  POINT_ASSET_CODE,
  POINT_SCALE,
  PRIVACY_FLOORS,
  REFERENCE_VALUE_EXPOSURE_LABEL,
  REPORT_SCHEMA_VERSION,
  REWARD_BUDGET_DISCLAIMER,
  ROUNDING_MODE,
} from './thresholds.js'
import type { BacktestReport, RunOptions, ValidatedInput } from './types.js'

const FORBIDDEN_DETAIL_KEYS = new Set([
  'accountRef',
  'orderRef',
  'offerRef',
  'email',
  'phone',
  'address',
  'token',
])

export function assertFiniteAggregates(value: unknown, path = 'report'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteAggregates(item, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_KEYS.has(key)) {
        throw new Error(`${path}.${key} must not appear in an aggregate report`)
      }
      assertFiniteAggregates(child, `${path}.${key}`)
    }
  }
}

export function assertNoIdentityLeak(reportText: string, input: ValidatedInput): void {
  for (const offer of input.offers) {
    if (reportText.includes(offer.offerRef)) {
      throw new Error('report must not contain offerRef values')
    }
  }
  for (const account of input.accounts) {
    if (reportText.includes(account.accountRef)) {
      throw new Error('report must not contain accountRef values')
    }
  }
  for (const order of input.orders) {
    if (reportText.includes(order.orderRef)) {
      throw new Error('report must not contain orderRef values')
    }
  }
}

export function buildReport(input: ValidatedInput, options: RunOptions): BacktestReport {
  const candidates = options.candidates.map(normalizeCandidate)
  const analyses = candidates.map((candidate) => {
    const body = analyzeCandidate(input, candidate, options.thresholds, options.legacyCommissionBps)
    return {
      ...body,
      gates: evaluateGates(body, options.thresholds),
    }
  })

  const git = options.runtime.gitIdentity()
  const report: BacktestReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    d02Status: D02_STATUS,
    d02StatusText: D02_STATUS_TEXT,
    conclusions: FIXED_CONCLUSIONS,
    metadata: {
      inputSha256: input.rawSha256,
      gitCommit: git.commit,
      gitTreeState: git.treeState,
      sourceVerifiable: git.treeState === 'clean',
      executedAt: options.runtime.now().toISOString(),
      candidates: options.candidates,
      candidatesSource: options.candidatesSource,
      referenceAsset: 'CNY',
      inputSchemaVersion: INPUT_SCHEMA_VERSION,
      reportSchemaVersion: REPORT_SCHEMA_VERSION,
      roundingMode: ROUNDING_MODE,
      pointAsset: { code: POINT_ASSET_CODE, scale: POINT_SCALE },
      referenceAssetScale: CNY_SCALE,
      gatesConfigSource: options.gatesConfigSource,
      gatesThresholds: options.thresholds,
      privacyFloors: PRIVACY_FLOORS,
      limits: INPUT_LIMITS,
      period: {
        from: input.period.from,
        to: input.period.to,
        months: input.period.months,
      },
      coverage: inputCoverage(input),
      legacyCommissionRateBps: options.legacyCommissionBps === null
        ? null
        : options.legacyCommissionBps.toString(10),
      rewardBudgetDisclaimer: REWARD_BUDGET_DISCLAIMER,
      referenceValueExposureLabel: REFERENCE_VALUE_EXPOSURE_LABEL,
    },
    candidates: analyses,
    sensitivity: buildSensitivity(analyses),
  }

  assertFiniteAggregates(report)
  return report
}

export function businessContent(report: BacktestReport): unknown {
  return {
    schemaVersion: report.schemaVersion,
    d02Status: report.d02Status,
    conclusions: report.conclusions,
    d02StatusText: report.d02StatusText,
    metadata: {
      ...report.metadata,
      executedAt: undefined,
    },
    candidates: report.candidates,
    sensitivity: report.sensitivity,
  }
}

function cell(value: string | number | null | undefined): string {
  return value === null || value === undefined ? 'null' : String(value)
}

export function renderMarkdown(report: BacktestReport): string {
  const lines: string[] = [
    '# D-02 CNY Denomination Backtest Report',
    '',
    `**${report.d02StatusText}**`,
    '',
    'This report is decision support only. It does not approve a production face value, create a ValuePolicy, or express a cash redemption promise.',
    '',
    '## Metadata',
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| inputSha256 | \`${report.metadata.inputSha256}\` |`,
    `| gitCommit | \`${report.metadata.gitCommit}\` |`,
    `| gitTreeState | ${report.metadata.gitTreeState} |`,
    `| sourceVerifiable | ${report.metadata.sourceVerifiable ? 'yes' : 'no'} |`,
    `| executedAt | ${report.metadata.executedAt} |`,
    `| candidates | ${report.metadata.candidates.join(', ')} |`,
    `| candidatesSource | ${report.metadata.candidatesSource} |`,
    `| referenceAsset | ${report.metadata.referenceAsset} |`,
    `| roundingMode | ${report.metadata.roundingMode} |`,
    `| gatesConfigSource | ${report.metadata.gatesConfigSource} |`,
    `| legacyCommissionRateBps | ${cell(report.metadata.legacyCommissionRateBps)} |`,
    '',
    '## Gate thresholds',
    '',
    '| Threshold | Value |',
    '| --- | --- |',
    ...Object.entries(report.metadata.gatesThresholds).map(([key, value]) => `| ${key} | ${String(value)} |`),
    '',
    '## Input coverage',
    '',
    `| Collection | Count |`,
    `| --- | ---: |`,
    `| offers | ${report.metadata.coverage.offers} |`,
    `| accounts | ${report.metadata.coverage.accounts} |`,
    `| monthlyActivityRows | ${report.metadata.coverage.monthlyActivityRows} |`,
    `| orders | ${report.metadata.coverage.orders} |`,
    `| merchantCostCoverage | ${cell(report.metadata.coverage.merchantCost.rate)} |`,
    '',
    '## Sensitivity matrix',
    '',
    '| PTS / CNY | Offer P50 CNY | Offer P90 CNY | Period earned reference CNY | Balance reference-value exposure CNY | Rounding incidence | Below-cost rate | P50 offers / median earned | vs 100 PTS/CNY |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.sensitivity.map(row => `| ${row.pointsPerCnyMajor} | ${cell(row.offerP50ReferenceCny)} | ${cell(row.offerP90ReferenceCny)} | ${cell(row.periodEarnedReferenceCny)} | ${cell(row.totalBalanceReferenceValueExposureCny)} | ${cell(row.roundingIncidence)} | ${cell(row.belowCostOfferRate)} | ${cell(row.p50OffersBuyableWithMedianEarned)} | ${cell(row.multiplierVs100PtsPerCny)} |`),
    '',
  ]

  for (const candidate of report.candidates) {
    lines.push(`## Candidate ${candidate.candidate.label}`)
    lines.push('')
    lines.push(`- numerator/denominator: ${candidate.candidate.numerator}/${candidate.candidate.denominator}`)
    lines.push(`- roundingMode: ${candidate.candidate.roundingMode}`)
    lines.push(`- offer sample: ${candidate.offerPrices.sampleSize}${candidate.offerPrices.suppressed ? ' (suppressed)' : ''}`)
    lines.push(`- offer P50 points: ${cell(candidate.offerPrices.distribution?.points.p50)}`)
    lines.push(`- offer P50 CNY: ${cell(candidate.offerPrices.distribution?.referenceCny.p50)}`)
    lines.push(`- rounding incidence: ${cell(candidate.offerPrices.rounding?.incidence)}`)
    lines.push(`- cumulative rounding delta atomic: ${cell(candidate.offerPrices.rounding?.cumulativeRoundingDeltaAtomic)}`)
    lines.push(`- median monthly earned points: ${cell(candidate.affordability.medianMonthlyEarnedPoints)}`)
    lines.push(`- P50 offers buyable with median earned: ${cell(candidate.affordability.p50OffersBuyableWithMedianEarned.units)}`)
    lines.push(`- months of median earned to P50 offer: ${cell(candidate.affordability.monthsOfMedianEarnedToAfford.p50Offer.months)}`)
    lines.push(`- reference-value exposure CNY: ${cell(candidate.balances.referenceValueExposureCny)}`)
    lines.push(`- period earned reference CNY: ${cell(candidate.rewardBudget.totals.earnedReferenceCny)}`)
    lines.push(`- net available reference CNY: ${cell(candidate.rewardBudget.totals.netAvailableReferenceCny)}`)
    lines.push(`- reward budget formula: ${candidate.rewardBudget.formula}`)
    lines.push(`- reward budget disclaimer: ${candidate.rewardBudget.disclaimer}`)
    lines.push(`- merchant unit economics emitted: ${candidate.merchantUnitEconomics.emitted ? 'yes' : 'no'}`)
    if (!candidate.merchantUnitEconomics.emitted) {
      lines.push(`- merchant unit economics reason: ${cell(candidate.merchantUnitEconomics.reason)}`)
    } else {
      lines.push(`- below-cost offer rate: ${cell(candidate.merchantUnitEconomics.belowCostOfferRate?.rate)}`)
    }
    lines.push('')
    lines.push('| Gate | Status | Reason |')
    lines.push('| --- | --- | --- |')
    for (const gate of candidate.gates) {
      lines.push(`| ${gate.name} | ${gate.status} | ${gate.reason} |`)
    }
    lines.push('')
  }

  lines.push('## Fixed conclusions')
  lines.push('')
  for (const conclusion of report.conclusions) {
    lines.push(`- ${conclusion}`)
  }
  lines.push('')
  lines.push(D02_STATUS_TEXT)
  lines.push('')
  return `${lines.join('\n')}`
}

export function reportJson(report: BacktestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}
