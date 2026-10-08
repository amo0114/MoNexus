// SPEC-MERCHANT-AGENT-001 §6 — the decision loop. The model chooses the next
// step from its own observations; the server validates the decision, runs
// the read-only tool and enforces the hard budgets. The tool sequence is never
// precomputed here.

import { randomUUID } from 'node:crypto'
import { aiValidationRejectionsTotal } from '../../../lib/ai/metrics.js'
import { markAiSafe } from '../../../lib/ai/safe.js'
import { AiTaskBudgetError, type AiTask } from '../../../lib/ai/task.js'
import {
  MODEL_BINDING,
  PROMPT_VERSION as CONTENT_PROMPT_VERSION,
  VALIDATOR_VERSION as CONTENT_VALIDATOR_VERSION,
  type ContentField,
} from '../../catalog/contentCopilot/constants.js'
import { MODEL_OUTPUT_SCHEMA } from '../../catalog/contentCopilot/outputSchema.js'
import { prepareContentSuggestionContext } from '../../catalog/contentCopilot/service.js'
import { SYSTEM_PROMPT as CONTENT_SYSTEM_PROMPT } from '../../catalog/contentCopilot/prompt.js'
import { countIssues, suggestedFieldCount, validateModelOutput, type ValidatedSuggestion } from '../../catalog/contentCopilot/validator.js'
import type { WorkbenchAction } from '../workbench/rules.js'
import { AGENT_FEATURE, AGENT_LIMITS, DECISION_SCHEMA_NAME } from './constants.js'
import { PLANNING_SYSTEM_PROMPT } from './prompt.js'
import { AgentOutputInvalidError, DECISION_SCHEMA, parseDecision, ToolArgumentsError, type Decision } from './schema.js'
import { AgentRunState, boundObservation, executeTool, type CoverageNote, type EvidenceCard, type Observation } from './tools.js'

export type TurnInput = {
  message: string
  recentUserMessages: string[]
  publicSourceNotes: string | null
  selectedRef: string | null
}

export type TurnOutcome = 'answered' | 'clarification' | 'proposal' | 'limited'

export type TurnResult = {
  outcome: TurnOutcome
  stopReason: string
  blocks: Array<{ text: string; evidenceRefs: string[]; action: WorkbenchAction | null }>
  clarification: { question: string; candidateRefs: string[] } | null
  proposal: {
    proposalId: string
    productId: number
    basedOnContentVersion: number
    createdAt: string
    expiresAt: string
    promptVersion: string
    validatorVersion: string
    fields: ValidatedSuggestion['fields']
    issues: ValidatedSuggestion['issues']
  } | null
  evidence: EvidenceCard[]
  steps: Array<{ tool: string; status: string }>
  coverage: CoverageNote[]
}

export async function runAgentTurn(
  task: AiTask,
  state: AgentRunState,
  input: TurnInput,
  assertAllowed: () => Promise<void>,
): Promise<{ value: TurnResult; stopReason: string }> {
  const observations: Observation[] = []
  const steps: TurnResult['steps'] = []
  const seenCalls = new Set<string>()
  let toolCalls = 0
  let runInputChars = 0

  const finish = async (outcome: TurnOutcome, stopReason: string, extra: Partial<TurnResult> = {}) => {
    // Permissions and the switch are checked again before anything is returned.
    await assertAllowed()
    return {
      stopReason,
      value: {
        outcome, stopReason, blocks: [], clarification: null, proposal: null,
        evidence: [...state.evidence.values()], steps, coverage: state.coverage, ...extra,
      },
    }
  }

  for (let step = 0; step < AGENT_LIMITS.planningCalls; step++) {
    await assertAllowed()
    const modelInput = markAiSafe({
      request: {
        message: input.message,
        recentUserMessages: input.recentUserMessages,
        selectedRef: input.selectedRef,
      },
      observations: [...observations],
      remaining: { toolCalls: AGENT_LIMITS.toolCalls - toolCalls, decisions: AGENT_LIMITS.planningCalls - step },
    })
    const inputChars = PLANNING_SYSTEM_PROMPT.length + JSON.stringify(modelInput).length
    if (inputChars > AGENT_LIMITS.callInputChars || runInputChars + inputChars > AGENT_LIMITS.runInputChars) {
      return finish('limited', 'context_limit')
    }
    runInputChars += inputChars

    let decision: Decision
    try {
      decision = parseDecision(await task.generate({
        schemaName: DECISION_SCHEMA_NAME,
        system: PLANNING_SYSTEM_PROMPT,
        input: modelInput,
        outputSchema: DECISION_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: AGENT_LIMITS.planningMaxOutputTokens,
      }))
    } catch (error) {
      if (error instanceof AiTaskBudgetError) return finish('limited', 'timeout')
      if (error instanceof ToolArgumentsError) {
        // Uses a decision step but no tool call; the model may correct itself within budget.
        observations.push({ tool: error.tool, status: 'invalid_arguments' })
        continue
      }
      throw error
    }

    if (decision.kind === 'tool') {
      if (toolCalls >= AGENT_LIMITS.toolCalls) return finish('limited', 'budget')
      const key = JSON.stringify(decision.call)
      if (seenCalls.has(key)) return finish('limited', 'no_progress')
      seenCalls.add(key)
      await assertAllowed()
      toolCalls += 1
      task.countToolCall()
      const observation = boundObservation(await executeTool(state, decision.call, input.publicSourceNotes))
      steps.push({ tool: observation.tool, status: observation.status })
      observations.push(observation)
      continue
    }

    if (decision.kind === 'answer') {
      const blocks = decision.blocks.map(block => {
        if (block.evidenceRefs.some(ref => !state.evidence.has(ref))) throw new AgentOutputInvalidError('unknown evidenceRef')
        let action: WorkbenchAction | null = null
        if (block.actionRef != null) {
          const entry = state.actions.get(block.actionRef)
          if (!entry || !block.evidenceRefs.includes(entry.evidenceRef)) throw new AgentOutputInvalidError('unknown actionRef')
          action = entry.action
        }
        return { text: block.text, evidenceRefs: block.evidenceRefs, action }
      })
      return finish('answered', 'answer', { blocks })
    }

    if (decision.kind === 'clarify') {
      if (decision.candidateRefs.some(ref => !state.isProductRef(ref) || !state.evidence.has(ref))) {
        throw new AgentOutputInvalidError('unknown candidateRef')
      }
      return finish('clarification', 'clarification', { clarification: { question: decision.question, candidateRefs: decision.candidateRefs } })
    }

    const stored = state.contents.get(decision.productRef)
    if (!stored || decision.fields.some(field => !stored.targetFields.includes(field))) {
      observations.push({ tool: 'prepare_content', status: 'requires_read_product_content' })
      continue
    }
    return prepareContent(task, state, input, stored, decision.fields, finish)
  }
  return finish('limited', 'budget')
}

async function prepareContent(
  task: AiTask,
  state: AgentRunState,
  input: TurnInput,
  stored: NonNullable<ReturnType<AgentRunState['contents']['get']>>,
  fields: ContentField[],
  finish: (outcome: TurnOutcome, stopReason: string, extra?: Partial<TurnResult>) => Promise<{ value: TurnResult; stopReason: string }>,
) {
  // Only the product's own content context and public notes reach the copy prompt;
  // no planning history, other products or orders.
  let prepared
  try {
    prepared = fields.length === stored.targetFields.length
      ? stored
      : await prepareContentSuggestionContext(
        { kind: 'merchant', merchantId: state.merchantId, userId: state.userId },
        stored.productId,
        { targetFields: fields, sourceNotes: input.publicSourceNotes ?? undefined, expectedContentVersion: stored.contentVersion },
      )
  } catch {
    return finish('limited', 'content_changed')
  }

  let raw: unknown
  try {
    raw = await task.generate({
      schemaName: MODEL_BINDING.schemaName,
      system: CONTENT_SYSTEM_PROMPT,
      input: prepared.context,
      outputSchema: MODEL_OUTPUT_SCHEMA,
      maxOutputTokens: AGENT_LIMITS.contentMaxOutputTokens,
    })
  } catch (error) {
    if (error instanceof AiTaskBudgetError) return finish('limited', 'timeout')
    throw error
  }
  const validated = validateModelOutput({
    raw,
    context: prepared.context,
    readinessCodes: prepared.readinessCodes,
    upstreamRequested: false,
    onReject: kind => aiValidationRejectionsTotal.inc({ feature: AGENT_FEATURE, kind }),
  })
  task.setContentCounts(countIssues(validated.issues), suggestedFieldCount(validated.fields))
  const createdAt = new Date()
  return finish('proposal', 'proposal', {
    proposal: {
      proposalId: randomUUID(),
      productId: stored.productId,
      basedOnContentVersion: prepared.contentVersion,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + AGENT_LIMITS.proposalTtlMs).toISOString(),
      promptVersion: CONTENT_PROMPT_VERSION,
      validatorVersion: CONTENT_VALIDATOR_VERSION,
      fields: validated.fields,
      issues: validated.issues,
    },
  })
}
