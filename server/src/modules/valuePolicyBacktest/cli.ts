import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseCandidateList } from './candidates.js'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'
import { DEFAULT_ANALYSIS_CANDIDATES, DEFAULT_GATE_THRESHOLDS, SUPPORTED_REFERENCE_ASSET, type GateThresholds } from './thresholds.js'
import type { ParsedCliArgs } from './types.js'

export const CLI_USAGE = `Usage:
  npm --prefix server run value-policy:backtest -- \\
    --input /path/to/anonymized-input.json \\
    --candidates 50,100,200,500 \\
    --reference-asset CNY \\
    --output /path/to/output

Options:
  --input <file>                 Required. Anonymized JSON input. Never a database URL.
  --output <dir>                 Required. Directory for JSON and Markdown reports.
  --candidates <n,n,...>         Optional. Points per 1 CNY. Default: 50,100,200,500
  --reference-asset <code>       Optional. Only CNY is accepted.
  --gates-config <file>          Optional. JSON object that overrides documented thresholds.
  --legacy-commission-bps <n>    Optional. Explicit FLOOR commission in basis points.
  --overwrite                    Replace only d02-backtest-report.json and .md
  --help                         Show this message

The tool never approves a candidate. Every report includes:
  D-02 STATUS: NOT APPROVED
`

function readFlag(args: string[], name: string): { value: string | true; rest: string[] } | null {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`))
  if (index === -1) {
    return null
  }
  const current = args[index]
  if (current.startsWith(`${name}=`)) {
    return { value: current.slice(name.length + 1), rest: args.filter((_, i) => i !== index) }
  }
  if (name === '--overwrite' || name === '--help') {
    return { value: true, rest: args.filter((_, i) => i !== index) }
  }
  const next = args[index + 1]
  if (next === undefined || next.startsWith('--')) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_CLI, `${name} requires a value`)
  }
  return { value: next, rest: args.filter((_, i) => i !== index && i !== index + 1) }
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let rest = [...argv]
  if (rest.includes('--help') || rest.includes('-h')) {
    return {
      input: '',
      output: '',
      candidates: null,
      referenceAsset: SUPPORTED_REFERENCE_ASSET,
      overwrite: false,
      gatesConfigPath: null,
      legacyCommissionBps: null,
      help: true,
    }
  }

  const help = readFlag(rest, '--help')
  if (help) {
    rest = help.rest
  }
  const overwrite = readFlag(rest, '--overwrite')
  if (overwrite) {
    rest = overwrite.rest
  }
  const input = readFlag(rest, '--input')
  if (input) {
    rest = input.rest
  }
  const output = readFlag(rest, '--output')
  if (output) {
    rest = output.rest
  }
  const candidates = readFlag(rest, '--candidates')
  if (candidates) {
    rest = candidates.rest
  }
  const referenceAsset = readFlag(rest, '--reference-asset')
  if (referenceAsset) {
    rest = referenceAsset.rest
  }
  const gatesConfig = readFlag(rest, '--gates-config')
  if (gatesConfig) {
    rest = gatesConfig.rest
  }
  const commission = readFlag(rest, '--legacy-commission-bps')
  if (commission) {
    rest = commission.rest
  }

  if (rest.length > 0) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_CLI, 'unrecognized CLI arguments')
  }
  if (!input || typeof input.value !== 'string' || input.value.length === 0) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_CLI, '--input is required')
  }
  if (!output || typeof output.value !== 'string' || output.value.length === 0) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_CLI, '--output is required')
  }

  return {
    input: input.value,
    output: output.value,
    candidates: candidates && typeof candidates.value === 'string'
      ? parseCandidateList(candidates.value)
      : null,
    referenceAsset: referenceAsset && typeof referenceAsset.value === 'string'
      ? referenceAsset.value
      : SUPPORTED_REFERENCE_ASSET,
    overwrite: Boolean(overwrite),
    gatesConfigPath: gatesConfig && typeof gatesConfig.value === 'string' ? gatesConfig.value : null,
    legacyCommissionBps: commission && typeof commission.value === 'string' ? commission.value : null,
    help: false,
  }
}

export function resolveCandidates(parsed: ParsedCliArgs): {
  candidates: number[]
  candidatesSource: 'explicit_cli' | 'documented_default_analysis_set'
} {
  if (parsed.candidates && parsed.candidates.length > 0) {
    return { candidates: parsed.candidates, candidatesSource: 'explicit_cli' }
  }
  return {
    candidates: [...DEFAULT_ANALYSIS_CANDIDATES],
    candidatesSource: 'documented_default_analysis_set',
  }
}

export function loadGateThresholds(path: string | null): {
  thresholds: GateThresholds
  source: 'documented_defaults' | 'explicit_file'
} {
  if (path === null) {
    return { thresholds: { ...DEFAULT_GATE_THRESHOLDS }, source: 'documented_defaults' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG, 'gates config is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG, 'gates config must be an object')
  }
  const merged: GateThresholds = { ...DEFAULT_GATE_THRESHOLDS }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in DEFAULT_GATE_THRESHOLDS)) {
      throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG, 'gates config contains an unknown key')
    }
    const current = merged[key as keyof GateThresholds]
    if (typeof current === 'number') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG, 'numeric gate threshold must be a non-negative integer')
      }
      (merged as Record<string, unknown>)[key] = value
    } else if (typeof current === 'string') {
      if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
        throw new BacktestError(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG, 'decimal gate threshold must be a decimal string')
      }
      (merged as Record<string, unknown>)[key] = value
    }
  }
  return { thresholds: merged, source: 'explicit_file' }
}

export function parseLegacyCommissionBps(raw: string | null): bigint | null {
  if (raw === null) {
    return null
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || BigInt(raw) > 10000n) {
    throw new BacktestError(
      BACKTEST_ERROR_CODES.INVALID_CLI,
      'legacy commission must be a non-negative integer basis-point string at most 10000',
    )
  }
  return BigInt(raw)
}

export function readGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'UNAVAILABLE'
  }
}

export function defaultRuntime() {
  return {
    now: () => new Date(),
    gitCommit: readGitCommit,
  }
}
