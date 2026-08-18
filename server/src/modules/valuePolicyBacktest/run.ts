import { analyzeCandidate, buildSensitivity } from './analyze.js'
import {
  defaultRuntime,
  loadGateThresholds,
  parseCliArgs,
  parseLegacyCommissionBps,
  resolveCandidates,
} from './cli.js'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'
import { writeReports } from './io.js'
import { readAndParseInputFile } from './parse.js'
import { assertNoIdentityLeak, buildReport, renderMarkdown, reportJson } from './report.js'
import { SUPPORTED_REFERENCE_ASSET } from './thresholds.js'
import type { BacktestReport, RunOptions } from './types.js'

export function createRunOptionsFromArgv(
  argv: string[],
  runtime = defaultRuntime(),
): RunOptions {
  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_CLI, 'help requested')
  }
  if (parsed.referenceAsset !== SUPPORTED_REFERENCE_ASSET) {
    throw new BacktestError(
      BACKTEST_ERROR_CODES.UNSUPPORTED_REFERENCE_ASSET,
      'D-02 backtest only accepts CNY as the reference asset',
    )
  }
  const resolved = resolveCandidates(parsed)
  const gates = loadGateThresholds(parsed.gatesConfigPath)
  return {
    inputPath: parsed.input,
    outputDir: parsed.output,
    candidates: resolved.candidates,
    candidatesSource: resolved.candidatesSource,
    referenceAsset: parsed.referenceAsset,
    overwrite: parsed.overwrite,
    thresholds: gates.thresholds,
    gatesConfigSource: gates.source,
    legacyCommissionBps: parseLegacyCommissionBps(parsed.legacyCommissionBps),
    allowUnverifiableSource: parsed.allowUnverifiableSource,
    runtime,
  }
}

export function assertVerifiableSource(options: RunOptions): void {
  const identity = options.runtime.gitIdentity()
  if (identity.treeState === 'clean') {
    return
  }
  if (options.allowUnverifiableSource) {
    return
  }
  throw new BacktestError(
    BACKTEST_ERROR_CODES.UNVERIFIABLE_SOURCE,
    'git tree is dirty or unavailable; pass --allow-unverifiable-source to continue with an unverifiable report',
    { gitTreeState: identity.treeState },
  )
}

export function executeBacktest(options: RunOptions): {
  report: BacktestReport
  jsonPath: string
  markdownPath: string
} {
  assertVerifiableSource(options)
  const input = readAndParseInputFile(options.inputPath)
  const report = buildReport(input, options)
  const json = reportJson(report)
  const markdown = renderMarkdown(report)
  assertNoIdentityLeak(json, input)
  assertNoIdentityLeak(markdown, input)
  const written = writeReports(options.outputDir, json, markdown, options.overwrite)
  return { report, jsonPath: written.json, markdownPath: written.markdown }
}

export function formatCliSuccess(result: ReturnType<typeof executeBacktest>): string {
  return [
    result.report.d02StatusText,
    `inputSha256: ${result.report.metadata.inputSha256}`,
    `gitCommit: ${result.report.metadata.gitCommit}`,
    `gitTreeState: ${result.report.metadata.gitTreeState}`,
    `sourceVerifiable: ${result.report.metadata.sourceVerifiable ? 'yes' : 'no'}`,
    `candidates: ${result.report.metadata.candidates.join(',')}`,
    `json: ${result.jsonPath}`,
    `markdown: ${result.markdownPath}`,
    'this report is decision support only; no ValuePolicy was created or activated',
  ].join('\n')
}

export { analyzeCandidate, buildSensitivity }
