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

export function createRunOptionsFromArgv(argv: string[]): RunOptions {
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
    runtime: defaultRuntime(),
  }
}

export function executeBacktest(options: RunOptions): {
  report: BacktestReport
  jsonPath: string
  markdownPath: string
} {
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
    `D-02 STATUS: ${result.report.d02Status}`,
    `inputSha256: ${result.report.metadata.inputSha256}`,
    `gitCommit: ${result.report.metadata.gitCommit}`,
    `candidates: ${result.report.metadata.candidates.join(',')}`,
    `json: ${result.jsonPath}`,
    `markdown: ${result.markdownPath}`,
    'this report is decision support only; no ValuePolicy was created or activated',
  ].join('\n')
}

export { analyzeCandidate, buildSensitivity }
