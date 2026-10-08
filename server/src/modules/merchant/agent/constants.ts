// SPEC-MERCHANT-AGENT-001 §6.3 / §9.1 — version-bound constants and hard run
// budgets. Changing the prompt, decision schema, tool catalog or observation
// shape requires bumping the matching version (SPEC-AI-001 §12).

export const AGENT_FEATURE = 'merchant_operations_agent' as const
export const AGENT_PROMPT_VERSION = 'merchant-agent@4'
export const AGENT_VALIDATOR_VERSION = 'merchant-agent-validator@3'
export const TOOL_CATALOG_VERSION = 'merchant-agent-tools@1'
export const BUDGET_VERSION = 'merchant-agent-budget@2'
export const DECISION_SCHEMA_NAME = 'merchant_agent_decision'

export const AGENT_LIMITS = {
  planningCalls: 4,
  toolCalls: 3,
  draftBatches: 2,
  runMs: 45_000,
  callMs: 15_000,
  reserveMs: 1_000,
  // L3 (deepseek-v4.1-flash, default reasoning): 1200 truncated long answers; see verification record.
  planningMaxOutputTokens: 1_600,
  contentMaxOutputTokens: 3_000,
  callInputChars: 40_000,
  runInputChars: 120_000,
  observationChars: 8_000,
  candidatesPerGroup: 10,
  findProductsMax: 10,
  nameMax: 80,
  maxBlocks: 5,
  blockTextMax: 300,
  questionMax: 300,
  proposalTtlMs: 10 * 60_000,
  messageMax: 1_000,
  recentMessages: 4,
  recentMessagesTotal: 3_000,
  sourceNotesMax: 2_000,
} as const

export const TOOL_NAMES = [
  'read_workbench',
  'find_products',
  'inspect_product',
  'read_item',
  'read_product_content',
  'read_help',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export const WORKBENCH_GROUPS = ['urgent', 'availability', 'drafts'] as const
export const PRODUCT_STATUS_FILTERS = ['draft', 'active', 'any'] as const
export const HELP_TOPICS = ['publication', 'availability', 'manual_fulfillment', 'content_boundaries'] as const
export type HelpTopic = (typeof HELP_TOPICS)[number]
