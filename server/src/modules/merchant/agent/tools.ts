// SPEC-MERCHANT-AGENT-001 §5 — closed, read-only tool catalog. Each tool
// calls existing services scoped to the authenticated merchant and returns
// two projections: `observation` (AI-safe, sent to the model: refs, codes and
// bands only) and evidence cards (exact values for the merchant, never sent to
// the provider). Models only see opaque per-run refs, never database ids.

import { HttpError } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { CONTENT_FIELDS, type ContentField } from '../../catalog/contentCopilot/constants.js'
import type { ProductContentAiContext } from '../../catalog/contentCopilot/projection.js'
import { prepareContentSuggestionContext } from '../../catalog/contentCopilot/service.js'
import { inspectProductReadiness } from '../../catalog/publicationReadiness.js'
import type { AiSafe } from '../../../lib/ai/safe.js'
import type { WorkbenchItem } from '../workbench/dto.js'
import { readinessAction, type WorkbenchAction } from '../workbench/rules.js'
import type { WorkbenchRule } from '../workbench/schema.js'
import * as workbench from '../workbench/service.js'
import { AGENT_LIMITS } from './constants.js'
import { HELP_TEXT } from './help.js'
import type { ToolCall } from './schema.js'

type Target =
  | { kind: 'product'; productId: number }
  | { kind: 'item'; rule: Exclude<WorkbenchRule, 'draft_incomplete'>; targetId: number }
  | { kind: 'cursor'; beforeProductId: number }

export type EvidenceCard =
  | { ref: string; kind: 'workbench_item'; item: WorkbenchItem; actionRef: string }
  | { ref: string; kind: 'product'; productId: number; name: string; status: string }
  | { ref: string; kind: 'readiness'; productId: number; name: string; status: string; ready: boolean
      issues: Array<{ code: string; field: string; offerId: number | null; actionRef: string }> }
  | { ref: string; kind: 'content'; productId: number; name: string; filledFields: ContentField[]; emptyFields: ContentField[] }

export type CoverageNote = { group: string; status: string; matchedTotal: number | null; shown: number; truncated: boolean; hasMore?: boolean }

export type Observation = { tool: string; status: string; data?: unknown }

export type StoredContent = {
  productId: number
  context: AiSafe<ProductContentAiContext>
  readinessCodes: string[]
  contentVersion: number
  targetFields: ContentField[]
}

/** Per-run state: refs, evidence and what the model has been allowed to see. */
export class AgentRunState {
  private seq = { P: 0, I: 0, C: 0, A: 0 }
  private refByKey = new Map<string, string>()
  private targets = new Map<string, Target>()
  readonly evidence = new Map<string, EvidenceCard>()
  readonly actions = new Map<string, { action: WorkbenchAction; evidenceRef: string }>()
  readonly coverage: CoverageNote[] = []
  readonly contents = new Map<string, StoredContent>()
  draftBatches = 0

  constructor(readonly merchantId: number, readonly userId: number) {}

  ref(target: Target): string {
    const key = JSON.stringify(target)
    const known = this.refByKey.get(key)
    if (known) return known
    const prefix = target.kind === 'product' ? 'P' : target.kind === 'item' ? 'I' : 'C'
    const ref = `${prefix}${++this.seq[prefix]}`
    this.refByKey.set(key, ref)
    this.targets.set(ref, target)
    return ref
  }

  target<K extends Target['kind']>(ref: string | null, kind: K): Extract<Target, { kind: K }> | null {
    const target = ref == null ? undefined : this.targets.get(ref)
    return target?.kind === kind ? target as Extract<Target, { kind: K }> : null
  }

  action(action: WorkbenchAction, evidenceRef: string): string {
    const ref = `A${++this.seq.A}`
    this.actions.set(ref, { action, evidenceRef })
    return ref
  }

  /** Product refs the model may offer as clarification candidates. */
  isProductRef(ref: string): boolean {
    return this.targets.get(ref)?.kind === 'product'
  }
}

const clip = (text: string) => (text.length > AGENT_LIMITS.nameMax ? `${text.slice(0, AGENT_LIMITS.nameMax)}…` : text)

function itemBand(item: WorkbenchItem): string {
  if (item.evidence.kind === 'fulfillment') return item.evidence.band
  if (item.evidence.kind === 'draft') return 'incomplete'
  return item.evidence.available === 0 ? 'sold_out' : 'low'
}

function recordItem(state: AgentRunState, item: WorkbenchItem): string {
  const ref = item.rule === 'draft_incomplete'
    ? state.ref({ kind: 'product', productId: item.targetId })
    : state.ref({ kind: 'item', rule: item.rule, targetId: item.targetId })
  state.evidence.set(ref, { ref, kind: 'workbench_item', item, actionRef: state.action(item.action, ref) })
  return ref
}

function itemObservation(state: AgentRunState, item: WorkbenchItem) {
  const ref = recordItem(state, item)
  const evidence = item.evidence
  return {
    ref,
    rule: item.rule,
    band: itemBand(item),
    productName: clip(evidence.productName),
    ...(evidence.kind === 'inventory' || evidence.kind === 'capacity' ? { offerName: clip(evidence.offerName) } : {}),
    ...(evidence.kind === 'draft' ? { issueCodes: [...new Set(evidence.issues.map(issue => issue.code))] } : {}),
    actionRef: (state.evidence.get(ref) as { actionRef: string }).actionRef,
  }
}

function groupObservation(state: AgentRunState, name: string, group: { items: WorkbenchItem[]; matchedTotal: number | null; truncated: boolean; status: string }) {
  const shown = group.items.slice(0, AGENT_LIMITS.candidatesPerGroup)
  state.coverage.push({ group: name, status: group.status, matchedTotal: group.matchedTotal, shown: group.items.length, truncated: group.truncated })
  return {
    status: group.status,
    total: group.matchedTotal,
    candidates: shown.map(item => itemObservation(state, item)),
    // Candidates are a sample for planning, never the full list.
    candidatesTruncated: group.items.length > shown.length || group.truncated,
  }
}

async function readWorkbench(state: AgentRunState, call: Extract<ToolCall, { name: 'read_workbench' }>): Promise<Observation> {
  if (call.group === 'urgent') {
    const urgent = await workbench.getUrgent(state.merchantId)
    return { tool: call.name, status: 'ok', data: {
      urgentTotal: urgent.urgentTotal,
      fulfillment: groupObservation(state, 'fulfillment', urgent.fulfillment),
      soldOut: groupObservation(state, 'sold_out', urgent.soldOut),
    } }
  }
  if (call.group === 'availability') {
    const group = await workbench.getAvailability(state.merchantId)
    return { tool: call.name, status: 'ok', data: groupObservation(state, 'availability', group) }
  }
  const cursor = state.target(call.cursorRef, 'cursor')
  if (call.cursorRef != null && !cursor) return { tool: call.name, status: 'invalid_reference' }
  if (state.draftBatches >= AGENT_LIMITS.draftBatches) return { tool: call.name, status: 'budget_exhausted' }
  state.draftBatches += 1
  const batch = await workbench.getDrafts(state.merchantId, cursor?.beforeProductId)
  const matches = batch.results.flatMap(result => (result.state === 'match' ? [result.item] : []))
  const shown = matches.slice(0, AGENT_LIMITS.candidatesPerGroup)
  state.coverage.push({ group: 'drafts', status: batch.failedProductIds.length ? 'partial' : 'complete', matchedTotal: matches.length,
    shown: matches.length, truncated: false, hasMore: batch.hasMore })
  return { tool: call.name, status: 'ok', data: {
    scanned: batch.scannedCount,
    checked: batch.checkedCount,
    failed: batch.failedProductIds.length,
    incompleteInBatch: matches.length,
    candidates: shown.map(item => itemObservation(state, item)),
    hasMore: batch.hasMore,
    cursorRef: batch.hasMore && batch.nextBeforeProductId != null && state.draftBatches < AGENT_LIMITS.draftBatches
      ? state.ref({ kind: 'cursor', beforeProductId: batch.nextBeforeProductId })
      : null,
  } }
}

async function findProducts(state: AgentRunState, call: Extract<ToolCall, { name: 'find_products' }>): Promise<Observation> {
  const id = /^#?(\d{1,10})$/.exec(call.query)?.[1]
  const rows = await prisma.product.findMany({
    where: {
      merchantId: state.merchantId,
      archivedAt: null,
      ...(call.status === 'any' ? {} : { status: call.status }),
      OR: [{ name: { contains: call.query, mode: 'insensitive' } }, ...(id && Number(id) <= 2_147_483_647 ? [{ id: Number(id) }] : [])],
    },
    orderBy: { id: 'desc' },
    take: AGENT_LIMITS.findProductsMax + 1,
    select: { id: true, name: true, status: true },
  })
  const shown = rows.slice(0, AGENT_LIMITS.findProductsMax)
  return { tool: call.name, status: 'ok', data: {
    products: shown.map(row => {
      const ref = state.ref({ kind: 'product', productId: row.id })
      if (!state.evidence.has(ref)) state.evidence.set(ref, { ref, kind: 'product', productId: row.id, name: row.name, status: row.status })
      return { ref, name: clip(row.name), status: row.status }
    }),
    more: rows.length > shown.length,
  } }
}

async function ownedProduct(state: AgentRunState, productId: number) {
  return prisma.product.findFirst({
    where: { id: productId, merchantId: state.merchantId },
    select: { id: true, name: true, status: true, archivedAt: true },
  })
}

async function inspectProduct(state: AgentRunState, call: Extract<ToolCall, { name: 'inspect_product' }>): Promise<Observation> {
  const target = state.target(call.productRef, 'product')
  if (!target) return { tool: call.name, status: 'invalid_reference' }
  const product = await ownedProduct(state, target.productId)
  if (!product) return { tool: call.name, status: 'not_found' }
  if (product.archivedAt) return { tool: call.name, status: 'archived' }
  const { readiness, availabilityOfferIds } = await inspectProductReadiness(product.id)
  const ref = call.productRef
  const issues = readiness.details.map(detail => ({
    code: detail.code, field: detail.field, offerId: detail.offerId,
    actionRef: state.action(readinessAction(product.id, detail, availabilityOfferIds), ref),
  }))
  state.evidence.set(ref, { ref, kind: 'readiness', productId: product.id, name: product.name, status: product.status, ready: readiness.ready, issues })
  return { tool: call.name, status: 'ok', data: {
    productRef: ref,
    productStatus: product.status,
    ready: readiness.ready,
    issues: issues.map(issue => ({ code: issue.code, field: issue.field, actionRef: issue.actionRef })),
  } }
}

async function readItem(state: AgentRunState, call: Extract<ToolCall, { name: 'read_item' }>): Promise<Observation> {
  const target = state.target(call.itemRef, 'item')
  if (!target) return { tool: call.name, status: 'invalid_reference' }
  const result = await workbench.getItem(state.merchantId, target.rule, target.targetId)
  if (result.state !== 'match') return { tool: call.name, status: 'ok', data: { itemRef: call.itemRef, state: result.state } }
  return { tool: call.name, status: 'ok', data: { itemRef: call.itemRef, state: 'match', item: itemObservation(state, result.item) } }
}

function contentFieldState(context: ProductContentAiContext) {
  const { description, details } = context.untrusted.currentContent
  const filled: Record<ContentField, boolean> = {
    description: Boolean(description?.trim()),
    highlights: details.highlights.length > 0,
    usageInstructions: Boolean(details.usageInstructions.trim()),
    purchaseNotes: Boolean(details.purchaseNotes.trim()),
    afterSalesInstructions: Boolean(details.afterSalesInstructions.trim()),
    faq: details.faq.length > 0,
  }
  return {
    filledFields: CONTENT_FIELDS.filter(field => filled[field]),
    emptyFields: CONTENT_FIELDS.filter(field => !filled[field]),
  }
}

const CONTENT_UNAVAILABLE: Record<string, string> = {
  AI_PRODUCT_TEMPLATE_REQUIRED: 'template_required',
  PRODUCT_ARCHIVED: 'archived',
  AI_CONTEXT_TOO_LARGE: 'too_large',
}

async function readProductContent(
  state: AgentRunState,
  call: Extract<ToolCall, { name: 'read_product_content' }>,
  sourceNotes: string | null,
): Promise<Observation> {
  const target = state.target(call.productRef, 'product')
  if (!target) return { tool: call.name, status: 'invalid_reference' }
  let prepared
  try {
    prepared = await prepareContentSuggestionContext(
      { kind: 'merchant', merchantId: state.merchantId, userId: state.userId },
      target.productId,
      { targetFields: call.targetFields, sourceNotes: sourceNotes ?? undefined },
    )
  } catch (error) {
    if (error instanceof HttpError && CONTENT_UNAVAILABLE[error.code]) return { tool: call.name, status: CONTENT_UNAVAILABLE[error.code] }
    throw error
  }
  const product = await ownedProduct(state, target.productId)
  const fields = contentFieldState(prepared.context)
  state.contents.set(call.productRef, { productId: target.productId, context: prepared.context, readinessCodes: prepared.readinessCodes,
    contentVersion: prepared.contentVersion, targetFields: call.targetFields })
  state.evidence.set(call.productRef, { ref: call.productRef, kind: 'content', productId: target.productId, name: product?.name ?? '', ...fields })
  return { tool: call.name, status: 'ok', data: { productRef: call.productRef, targetFields: call.targetFields, ...fields } }
}

/** A failing tool is reported to the model as unavailable; the run continues within budget. */
export async function executeTool(state: AgentRunState, call: ToolCall, sourceNotes: string | null): Promise<Observation> {
  try {
    return await runTool(state, call, sourceNotes)
  } catch (error) {
    return { tool: call.name, status: error instanceof HttpError && error.status === 404 ? 'not_found' : 'unavailable' }
  }
}

function runTool(state: AgentRunState, call: ToolCall, sourceNotes: string | null): Promise<Observation> {
  switch (call.name) {
    case 'read_workbench': return readWorkbench(state, call)
    case 'find_products': return findProducts(state, call)
    case 'inspect_product': return inspectProduct(state, call)
    case 'read_item': return readItem(state, call)
    case 'read_product_content': return readProductContent(state, call, sourceNotes)
    case 'read_help': return Promise.resolve({ tool: call.name, status: 'ok', data: { topic: call.topic, text: HELP_TEXT[call.topic] } })
  }
}

/** An observation over the per-tool budget is replaced by a status, never silently cut. */
export function boundObservation(observation: Observation): Observation {
  if (JSON.stringify(observation).length <= AGENT_LIMITS.observationChars) return observation
  return { tool: observation.tool, status: 'too_large' }
}
