export { normalizeCandidate, parseCandidateList, serializeCandidate } from './candidates.js'
export { CLI_USAGE, loadGateThresholds, parseCliArgs, readGitIdentity } from './cli.js'
export { convertNetAvailableReferenceAtomic, convertPoints, isExactConversion, netAvailablePoints } from './convert.js'
export { BacktestError, BACKTEST_ERROR_CODES, isBacktestError } from './errors.js'
export { gcd } from './gcd.js'
export { writeReports } from './io.js'
export { hashBufferSha256, parseBacktestInput, readAndParseInputFile } from './parse.js'
export { buildReport, businessContent, renderMarkdown, reportJson } from './report.js'
export { createRunOptionsFromArgv, executeBacktest, formatCliSuccess } from './run.js'
export { concentrationTopShare, quantileNearestRank } from './stats.js'
export {
  DEFAULT_ANALYSIS_CANDIDATES,
  DEFAULT_GATE_THRESHOLDS,
  D02_STATUS,
  D02_STATUS_TEXT,
  FIXED_CONCLUSIONS,
  PRIVACY_FLOORS,
} from './thresholds.js'
