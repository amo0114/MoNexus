import { pathToFileURL } from 'node:url'
import { CLI_USAGE, parseCliArgs } from '../modules/valuePolicyBacktest/cli.js'
import { isBacktestError } from '../modules/valuePolicyBacktest/errors.js'
import { defaultRuntime } from '../modules/valuePolicyBacktest/cli.js'
import { createRunOptionsFromArgv, executeBacktest, formatCliSuccess } from '../modules/valuePolicyBacktest/run.js'
import type { BacktestRuntime } from '../modules/valuePolicyBacktest/types.js'

export function runValuePolicyBacktestCli(argv: string[], runtime: BacktestRuntime = defaultRuntime()): {
  status: number
  stdout: string
  stderr: string
} {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { status: 0, stdout: CLI_USAGE, stderr: '' }
  }
  try {
    parseCliArgs(argv)
    const result = executeBacktest(createRunOptionsFromArgv(argv, runtime))
    return { status: 0, stdout: `${formatCliSuccess(result)}\n`, stderr: '' }
  } catch (error) {
    if (isBacktestError(error)) {
      const payload = JSON.stringify({
        ok: false,
        code: error.code,
        message: error.message,
        details: error.details,
      })
      return {
        status: error.code === 'OUTPUT_EXISTS' ? 3 : 2,
        stdout: '',
        stderr: `${payload}\n`,
      }
    }
    return {
      status: 1,
      stdout: '',
      stderr: `${JSON.stringify({ ok: false, code: 'UNEXPECTED', message: 'backtest failed' })}\n`,
    }
  }
}

function main() {
  const result = runValuePolicyBacktestCli(process.argv.slice(2))
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  process.exit(result.status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
