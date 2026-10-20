// SPEC-AI-001 §9–§11 — AI feature registry, flags, per-actor quota keys,
// effective reasoning mode and input hashing. Model calls, the quota slot,
// timeout, AiGeneration metadata and metrics live in the run container
// (task.ts). Prompts, inputs and outputs are never persisted or logged (AI-R20).

import { createHmac } from 'node:crypto'
import { config } from '../../config/index.js'
import { HttpError, notFound } from '../httpError.js'
import { prisma } from '../prisma.js'
import type { AiSafe } from './safe.js'
import { runAiTask } from './task.js'

import { isAiFeatureEnabled, type AiActorRole, type AiFeature, type IssueCounts } from './featurePolicy.js'
export * from './featurePolicy.js'

const INPUT_HASH_DOMAIN = 'monexus:ai-input-hash:v1\0'
// SPEC-AI-001 AI-R21a: computed once per agent run, before the quota slot is claimed.
const AGENT_RUN_INPUT_HASH_DOMAIN = 'monexus:ai-agent-run-input:v1\0'

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** AI-R21: domain-separated HMAC so this message space never overlaps other jwtSecret HMACs. */
export function computeAiInputHash(input: unknown): string {
  return domainHmac(INPUT_HASH_DOMAIN, input)
}

/** AI-R21a: fingerprint of an agent run's whitelisted initial input, in its own domain. */
export function computeAiAgentRunInputHash(runInput: unknown): string {
  return domainHmac(AGENT_RUN_INPUT_HASH_DOMAIN, runInput)
}

function domainHmac(domain: string, input: unknown): string {
  return createHmac('sha256', config.jwtSecret)
    .update(domain + canonicalJson(input))
    .digest('hex')
}

export interface RunAiGenerationArgs<T> {
  feature: AiFeature
  actor: { userId: number; role: AiActorRole }
  target: { type: 'product' | 'product_draft'; id: number }
  promptVersion: string
  validatorVersion: string
  reasoningEffort: 'none'
  schemaName: string
  system: string
  input: AiSafe<unknown>
  outputSchema: Record<string, unknown>
  maxOutputTokens: number
  parse: (raw: unknown) => { value: T; issueCounts: IssueCounts; suggestedFieldCount: number }
}

/** Single-call consumer of the run container (SPEC-AI-001 §11.1); behaviour unchanged. */
export async function runAiGeneration<T>(args: RunAiGenerationArgs<T>): Promise<{ generationId: number; value: T }> {
  return runAiTask<T>({
    feature: args.feature,
    actor: args.actor,
    target: args.target,
    promptVersion: args.promptVersion,
    validatorVersion: args.validatorVersion,
    inputHash: computeAiInputHash(args.input),
    deadlineMs: config.ai.timeoutMs,
    run: async task => {
      const raw = await task.generate({
        schemaName: args.schemaName,
        system: args.system,
        input: args.input,
        outputSchema: args.outputSchema,
        maxOutputTokens: args.maxOutputTokens,
      })
      const parsed = args.parse(raw)
      task.setContentCounts(parsed.issueCounts, parsed.suggestedFieldCount)
      return { value: parsed.value }
    },
  })
}

/**
 * Best-effort client telemetry (SPEC-AI-PRODUCT-001 §9.2 / CP-12): only
 * product metrics, never used for permissions, state or publishing.
 */
export async function recordAiGenerationApplied(args: {
  feature: AiFeature
  generationId: number
  actorUserId: number
  target: { type: 'product'; id: number }
  appliedFieldCount: number
}): Promise<void> {
  if (!await isAiFeatureEnabled(args.feature)) throw notFound()
  const row = await prisma.aiGeneration.findFirst({
    where: {
      id: args.generationId,
      feature: args.feature,
      actorUserId: args.actorUserId,
      targetType: args.target.type,
      targetId: args.target.id,
      status: 'succeeded',
    },
    select: { id: true, suggestedFieldCount: true },
  })
  if (!row) throw notFound()
  if (args.appliedFieldCount > (row.suggestedFieldCount ?? 0)) {
    throw new HttpError(400, 'BAD_REQUEST', '采纳字段数超出本次建议数')
  }
  await prisma.aiGeneration.update({
    where: { id: row.id },
    data: { acceptedFieldCount: args.appliedFieldCount },
  })
}
