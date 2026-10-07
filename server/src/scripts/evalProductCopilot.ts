// SPEC-AI-PRODUCT-001 §11.3 — L3 model eval. Manual only (never in CI): sends
// every fixture to the real provider through the same projection, prompt,
// schema and validator as production, bypassing HTTP, quota and the database.
//
//   AI_ENABLED=true OPENAI_API_KEY=… npm run ai:eval:product-copilot
//
// Reports are written to server/.ai-eval/ (gitignored). They contain model
// output for local review; never commit them or copy them into fixtures
// without manual de-identification (SPEC-AI-001 §10.3).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getLlmProvider, LlmError } from '../lib/ai/provider.js'
import { COPILOT_FIXTURES } from '../modules/catalog/contentCopilot/__fixtures__/fixtures.js'
import { MODEL_BINDING, PROMPT_VERSION, VALIDATOR_VERSION } from '../modules/catalog/contentCopilot/constants.js'
import { MODEL_OUTPUT_SCHEMA } from '../modules/catalog/contentCopilot/outputSchema.js'
import { buildProductContentAiContext } from '../modules/catalog/contentCopilot/projection.js'
import { SYSTEM_PROMPT } from '../modules/catalog/contentCopilot/prompt.js'
import { ModelOutputInvalidError, validateModelOutput } from '../modules/catalog/contentCopilot/validator.js'
import { config } from '../config/index.js'

type CaseResult = {
  id: string
  group: string
  outcome: 'ok' | 'structure_invalid' | `llm_${string}`
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  fieldStatus: Record<string, string>
  rejections: Record<string, number>
  leaks: string[]
  output?: unknown
}

export type EvalGateInput = {
  fixtures: number
  okCases: number
  adversarialLeaks: number
  p95LatencyMs: number
  p95GateMs: number
}

/**
 * §12 gates. Any failure makes the run fail: a run where calls errored or
 * output was structurally invalid proves nothing about leaks, so it must not
 * pass vacuously.
 */
export function evalGateFailures(input: EvalGateInput): string[] {
  const failures: string[] = []
  if (input.fixtures === 0) failures.push('no fixtures were evaluated')
  if (input.okCases < input.fixtures) {
    failures.push(`${input.fixtures - input.okCases}/${input.fixtures} cases failed (provider error, timeout or invalid structure)`)
  }
  if (input.adversarialLeaks > 0) failures.push(`${input.adversarialLeaks} forbidden strings leaked into suggestions`)
  if (input.p95LatencyMs > input.p95GateMs) failures.push(`p95 latency ${input.p95LatencyMs}ms exceeds ${input.p95GateMs}ms`)
  return failures
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

async function main() {
  if (!config.ai.enabled || !config.ai.openaiApiKey) {
    throw new Error('Set AI_ENABLED=true and OPENAI_API_KEY to run the L3 eval')
  }
  const provider = await getLlmProvider()
  const results: CaseResult[] = []

  for (const fixture of COPILOT_FIXTURES) {
    const context = buildProductContentAiContext(fixture.input)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs)
    const startedAt = Date.now()
    const rejections: Record<string, number> = {}
    const base = { id: fixture.id, group: fixture.group, fieldStatus: {}, rejections, leaks: [] as string[] }
    try {
      const response = await provider.generateStructured({
        model: MODEL_BINDING.model,
        reasoningEffort: MODEL_BINDING.reasoningEffort,
        schemaName: MODEL_BINDING.schemaName,
        system: SYSTEM_PROMPT,
        input: context,
        outputSchema: MODEL_OUTPUT_SCHEMA,
        maxOutputTokens: MODEL_BINDING.maxOutputTokens,
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt
      try {
        const validated = validateModelOutput({
          raw: response.output,
          context,
          readinessCodes: fixture.readinessCodes,
          upstreamRequested: fixture.input.useUpstreamDescription,
          onReject: kind => { rejections[kind] = (rejections[kind] ?? 0) + 1 },
        })
        const fieldStatus: Record<string, string> = {}
        const leaks: string[] = []
        for (const [field, suggestion] of Object.entries(validated.fields)) {
          fieldStatus[field] = suggestion?.status ?? 'missing'
          if (suggestion?.status !== 'suggested') continue
          const text = JSON.stringify(suggestion.value)
          for (const forbidden of fixture.forbiddenInSuggestions) if (text.includes(forbidden)) leaks.push(forbidden)
        }
        results.push({ ...base, outcome: 'ok', latencyMs, ...response.usage, fieldStatus, leaks, output: response.output })
      } catch (err) {
        if (!(err instanceof ModelOutputInvalidError)) throw err
        results.push({ ...base, outcome: 'structure_invalid', latencyMs, ...response.usage, output: response.output })
      }
    } catch (err) {
      const code = controller.signal.aborted ? 'timeout' : err instanceof LlmError ? err.code : 'error'
      results.push({ ...base, outcome: `llm_${code}`, latencyMs: Date.now() - startedAt, inputTokens: null, outputTokens: null })
    } finally {
      clearTimeout(timer)
    }
    process.stdout.write(`${fixture.id}: ${results[results.length - 1].outcome}\n`)
  }

  const ok = results.filter(result => result.outcome === 'ok')
  const latencies = results.map(result => result.latencyMs)
  const fieldStatuses = ok.flatMap(result => Object.values(result.fieldStatus))
  const summary = {
    promptVersion: PROMPT_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    model: MODEL_BINDING.model,
    fixtures: results.length,
    structurePassRate: ok.length / Math.max(results.length, 1),
    suggestedFieldRate: fieldStatuses.filter(status => status === 'suggested').length / Math.max(fieldStatuses.length, 1),
    rejectionsByKind: results.reduce<Record<string, number>>((acc, result) => {
      for (const [kind, count] of Object.entries(result.rejections)) acc[kind] = (acc[kind] ?? 0) + count
      return acc
    }, {}),
    // Hard gate (§12): must be 0.
    adversarialLeaks: results.reduce((sum, result) => sum + result.leaks.length, 0),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p95GateMs: Math.floor(config.ai.timeoutMs * 0.8),
    avgInputTokens: ok.reduce((sum, result) => sum + (result.inputTokens ?? 0), 0) / Math.max(ok.length, 1),
    avgOutputTokens: ok.reduce((sum, result) => sum + (result.outputTokens ?? 0), 0) / Math.max(ok.length, 1),
  }

  const dir = join(process.cwd(), '.ai-eval')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(join(dir, `product-copilot-${stamp}.json`), JSON.stringify({ summary, results }, null, 2))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  const failures = evalGateFailures({
    fixtures: results.length,
    okCases: ok.length,
    adversarialLeaks: summary.adversarialLeaks,
    p95LatencyMs: summary.p95LatencyMs,
    p95GateMs: summary.p95GateMs,
  })
  for (const failure of failures) process.stderr.write(`GATE FAILED: ${failure}\n`)
  if (failures.length > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
