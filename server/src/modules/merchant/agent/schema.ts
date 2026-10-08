// SPEC-MERCHANT-AGENT-001 §6.1 / §8.1 — the turn request and the model's
// closed next-step decision. The decision root is a fixed object with
// nullable branches so strict JSON Schema works on all three protocols; the
// server then requires exactly the branch named by `kind`.

import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'
import { CONTENT_FIELDS, type ContentField } from '../../catalog/contentCopilot/constants.js'
import {
  AGENT_LIMITS,
  HELP_TOPICS,
  PRODUCT_STATUS_FILTERS,
  TOOL_NAMES,
  WORKBENCH_GROUPS,
  type HelpTopic,
  type ToolName,
} from './constants.js'

const id = z.number().int().positive().max(2_147_483_647)

export const turnSchema = z.object({
  requestId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(AGENT_LIMITS.messageMax),
  selectedResource: z.object({ type: z.enum(['product', 'offer', 'order']), id }).strict().nullable().optional(),
  recentUserMessages: z.array(z.string().trim().min(1).max(AGENT_LIMITS.messageMax))
    .max(AGENT_LIMITS.recentMessages)
    .refine(list => list.reduce((sum, text) => sum + text.length, 0) <= AGENT_LIMITS.recentMessagesTotal, '历史消息合计过长')
    .optional(),
  publicSourceNotes: z.string().trim().max(AGENT_LIMITS.sourceNotesMax).nullable().optional(),
}).strict()
export type TurnRequest = z.infer<typeof turnSchema>

const nullableString = { type: ['string', 'null'] }
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })

export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'tool', 'answer', 'clarify', 'prepareContent'],
  properties: {
    kind: { type: 'string', enum: ['tool', 'answer', 'clarify', 'prepare_content'] },
    tool: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'group', 'cursorRef', 'query', 'status', 'productRef', 'itemRef', 'targetFields', 'topic'],
      properties: {
        name: { type: 'string', enum: [...TOOL_NAMES] },
        group: { type: ['string', 'null'], enum: [...WORKBENCH_GROUPS, null] },
        cursorRef: nullableString,
        query: nullableString,
        status: { type: ['string', 'null'], enum: [...PRODUCT_STATUS_FILTERS, null] },
        productRef: nullableString,
        itemRef: nullableString,
        targetFields: nullable({ type: 'array', items: { type: 'string', enum: [...CONTENT_FIELDS] } }),
        topic: { type: ['string', 'null'], enum: [...HELP_TOPICS, null] },
      },
    }),
    answer: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['blocks'],
      properties: {
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'evidenceRefs', 'actionRef'],
            properties: {
              text: { type: 'string' },
              evidenceRefs: { type: 'array', items: { type: 'string' } },
              actionRef: nullableString,
            },
          },
        },
      },
    }),
    clarify: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['question', 'candidateRefs'],
      properties: {
        question: { type: 'string' },
        candidateRefs: { type: 'array', items: { type: 'string' } },
      },
    }),
    prepareContent: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['productRef', 'fields'],
      properties: {
        productRef: { type: 'string' },
        fields: { type: 'array', items: { type: 'string', enum: [...CONTENT_FIELDS] } },
      },
    }),
  },
} as const

export type ToolCall =
  | { name: 'read_workbench'; group: (typeof WORKBENCH_GROUPS)[number]; cursorRef: string | null }
  | { name: 'find_products'; query: string; status: (typeof PRODUCT_STATUS_FILTERS)[number] }
  | { name: 'inspect_product'; productRef: string }
  | { name: 'read_item'; itemRef: string }
  | { name: 'read_product_content'; productRef: string; targetFields: ContentField[] }
  | { name: 'read_help'; topic: HelpTopic }

export type Decision =
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'answer'; blocks: Array<{ text: string; evidenceRefs: string[]; actionRef: string | null }> }
  | { kind: 'clarify'; question: string; candidateRefs: string[] }
  | { kind: 'prepare_content'; productRef: string; fields: ContentField[] }

/** Structurally or semantically unusable model output (→ AI_OUTPUT_INVALID). */
export class AgentOutputInvalidError extends Error {
  constructor(reason: string) { super(`agent output invalid: ${reason}`) }
}

const validateShape = new Ajv2020({ strict: false }).compile(DECISION_SCHEMA)

type RawTool = {
  name: ToolName; group: string | null; cursorRef: string | null; query: string | null; status: string | null
  productRef: string | null; itemRef: string | null; targetFields: ContentField[] | null; topic: string | null
}
type RawDecision = {
  kind: Decision['kind']
  tool: RawTool | null
  answer: { blocks: Array<{ text: string; evidenceRefs: string[]; actionRef: string | null }> } | null
  clarify: { question: string; candidateRefs: string[] } | null
  prepareContent: { productRef: string; fields: ContentField[] } | null
}

function required<T>(value: T | null, what: string): T {
  if (value == null) throw new AgentOutputInvalidError(`missing ${what}`)
  return value
}

function toolCall(tool: RawTool): ToolCall {
  switch (tool.name) {
    case 'read_workbench':
      return { name: tool.name, group: required(tool.group, 'group') as (typeof WORKBENCH_GROUPS)[number], cursorRef: tool.cursorRef }
    case 'find_products': {
      const query = required(tool.query, 'query').trim()
      if (query.length < 1 || query.length > 80) throw new AgentOutputInvalidError('query length')
      return { name: tool.name, query, status: (tool.status ?? 'any') as (typeof PRODUCT_STATUS_FILTERS)[number] }
    }
    case 'inspect_product':
      return { name: tool.name, productRef: required(tool.productRef, 'productRef') }
    case 'read_item':
      return { name: tool.name, itemRef: required(tool.itemRef, 'itemRef') }
    case 'read_product_content': {
      const targetFields = tool.targetFields ?? [...CONTENT_FIELDS]
      if (targetFields.length === 0 || new Set(targetFields).size !== targetFields.length) throw new AgentOutputInvalidError('targetFields')
      return { name: tool.name, productRef: required(tool.productRef, 'productRef'), targetFields }
    }
    case 'read_help':
      return { name: tool.name, topic: required(tool.topic, 'topic') as HelpTopic }
  }
}

export function parseDecision(raw: unknown): Decision {
  if (!validateShape(raw)) throw new AgentOutputInvalidError('schema')
  const decision = raw as RawDecision
  switch (decision.kind) {
    case 'tool':
      return { kind: 'tool', call: toolCall(required(decision.tool, 'tool')) }
    case 'answer': {
      const blocks = required(decision.answer, 'answer').blocks
      if (blocks.length < 1 || blocks.length > AGENT_LIMITS.maxBlocks) throw new AgentOutputInvalidError('block count')
      for (const block of blocks) {
        const text = block.text.trim()
        if (text.length < 1 || text.length > AGENT_LIMITS.blockTextMax) throw new AgentOutputInvalidError('block text')
      }
      return { kind: 'answer', blocks: blocks.map(block => ({ ...block, text: block.text.trim() })) }
    }
    case 'clarify': {
      const clarify = required(decision.clarify, 'clarify')
      const question = clarify.question.trim()
      if (question.length < 1 || question.length > AGENT_LIMITS.questionMax) throw new AgentOutputInvalidError('question')
      return { kind: 'clarify', question, candidateRefs: clarify.candidateRefs }
    }
    case 'prepare_content': {
      const prepare = required(decision.prepareContent, 'prepareContent')
      if (prepare.fields.length === 0 || new Set(prepare.fields).size !== prepare.fields.length) throw new AgentOutputInvalidError('fields')
      return { kind: 'prepare_content', productRef: prepare.productRef, fields: prepare.fields }
    }
  }
}
