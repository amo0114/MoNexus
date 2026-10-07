// SPEC-AI-PRODUCT-001 §7 — deterministic judge of model output. Three layers
// (CP-07): declared claims must resolve to facts, claims are judged by
// semantic normalisation (not substring matching against the input), and an
// independent detector rejects hard facts the model did not declare.

import type { IssueCounts } from '../../../lib/ai/generation.js'
import { productDescriptionSchema } from '../../products/schema.js'
import { productDetailsSchema } from '../templates/productDetails.js'
import type { ProductDetails } from '../templates/types.js'
import {
  GENERATION_LIMITS,
  MAX_CLAIMS_PER_UNIT,
  MAX_ISSUE_TEXT,
  MAX_MODEL_ISSUES,
  MAX_SPAN_LENGTH,
  type ContentField,
} from './constants.js'
import { DELIVERY_PHRASES, ESTIMATE_TERMS, PERIOD_MONTHS } from './lexicon.js'
import {
  detectHardFacts,
  extractTuples,
  findDurations,
  findPromiseTerms,
  findUnboundedTerms,
  hasForbiddenMarkup,
  normalizeSpace,
  regionPlatformIds,
  type CoverClass,
  type HardFactMention,
} from './normalizers.js'
import { isModelOutput, type Claim, type ModelOutput } from './outputSchema.js'
import type { DeclaredAttr, ProductAiFacts, ProductContentAiContext, Validity } from './projection.js'

export type IssueKind = 'missing' | 'ambiguous' | 'risky_claim' | 'unsupported_fact'

export type Issue = {
  kind: IssueKind
  origin: 'model' | 'validator'
  field: ContentField | 'attributes' | null
  message: string
  evidence: string | null
}

export type FaqItem = { question: string; answer: string }

export type FieldSuggestion =
  | { status: 'suggested'; value: string | string[] | FaqItem[]; rejectedItemCount: number }
  | { status: 'rejected'; value: null; rejectedItemCount: number }
  | { status: 'not_generated'; value: null; rejectedItemCount: 0 }

export type ValidatedSuggestion = {
  fields: Partial<Record<ContentField, FieldSuggestion>>
  issues: Issue[]
}

export class ModelOutputInvalidError extends Error {
  constructor() {
    super('model output failed structural validation')
  }
}

type RejectionReason = { kind: IssueKind | 'format'; message: string; evidence: string | null }

const TEXT_LIMITS: Record<'description' | 'usageInstructions' | 'purchaseNotes' | 'afterSalesInstructions', number> = {
  description: GENERATION_LIMITS.descriptionMax,
  usageInstructions: GENERATION_LIMITS.usageInstructionsMax,
  purchaseNotes: GENERATION_LIMITS.purchaseNotesMax,
  afterSalesInstructions: GENERATION_LIMITS.afterSalesInstructionsMax,
}

const READINESS_MISSING: Record<string, { field: ContentField | 'attributes'; message: string }> = {
  PURCHASE_NOTES_REQUIRED: { field: 'purchaseNotes', message: '发布前需要填写购买须知' },
  AFTER_SALES_REQUIRED: { field: 'afterSalesInstructions', message: '发布前需要填写售后说明' },
  TEMPLATE_FIELDS_REQUIRED: { field: 'attributes', message: '模板必填参数未补齐，请自行补充（AI 不会补写参数）' },
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

// ---------------------------------------------------------------------------
// factRef resolution

type ResolvedFact =
  | { type: 'validity'; value: Validity; offerIndex: number | null }
  | { type: 'xboardPeriod'; value: string; offerIndex: number | null }
  | { type: 'deliveryMethod'; value: string; offerIndex: number | null }
  | { type: 'flag'; name: 'autoProvision' | 'externalProvisioning'; value: boolean; offerIndex: number }
  | { type: 'declared'; value: DeclaredAttr; offerIndex: number | null }

function resolveFactRef(facts: ProductAiFacts, ref: string | null): ResolvedFact | null {
  if (!ref) return null
  let match = /^offers\[(\d+)\]\.(validity|xboardPeriod|deliveryMethod|autoProvision|externalProvisioning)$/.exec(ref)
  if (match) {
    const index = Number(match[1])
    const offer = facts.offers[index]
    if (!offer) return null
    switch (match[2]) {
      case 'validity':
        return { type: 'validity', value: offer.validity, offerIndex: index }
      case 'xboardPeriod':
        return offer.xboardPeriod ? { type: 'xboardPeriod', value: offer.xboardPeriod, offerIndex: index } : null
      case 'deliveryMethod':
        return { type: 'deliveryMethod', value: offer.deliveryMethod, offerIndex: index }
      case 'autoProvision':
        return { type: 'flag', name: 'autoProvision', value: offer.autoProvision, offerIndex: index }
      default:
        return { type: 'flag', name: 'externalProvisioning', value: offer.externalProvisioning, offerIndex: index }
    }
  }
  match = /^offers\[(\d+)\]\.attributes\.([A-Za-z][A-Za-z0-9_]*)$/.exec(ref)
  if (match) {
    const index = Number(match[1])
    const attr = facts.offers[index]?.attributes[match[2]]
    return attr && attr.value != null ? { type: 'declared', value: attr, offerIndex: index } : null
  }
  match = /^common\.(validity|deliveryMethod)$/.exec(ref)
  if (match) {
    if (match[1] === 'validity') {
      return facts.common.validity ? { type: 'validity', value: facts.common.validity, offerIndex: null } : null
    }
    return facts.common.deliveryMethod
      ? { type: 'deliveryMethod', value: facts.common.deliveryMethod, offerIndex: null }
      : null
  }
  match = /^xboard\.periods\[(\d+)\]$/.exec(ref)
  if (match) {
    const period = facts.xboard?.periods[Number(match[1])]
    return period ? { type: 'xboardPeriod', value: period, offerIndex: null } : null
  }
  match = /^productAttributes\.([A-Za-z][A-Za-z0-9_]*)$/.exec(ref)
  if (match) {
    const attr = facts.productAttributes[match[1]]
    return attr && attr.value != null ? { type: 'declared', value: attr, offerIndex: null } : null
  }
  return null
}

function declaredText(attr: DeclaredAttr): string | null {
  if (attr.kind === 'text') return attr.value
  if (attr.kind === 'list') return attr.value ? attr.value.join('、') : null
  return null
}

// ---------------------------------------------------------------------------
// claim judgement (§7.3)

function unsupported(span: string, why = '在商品配置中找不到依据'): RejectionReason {
  return { kind: 'unsupported_fact', message: `「${span}」${why}，已拒绝该条建议`, evidence: span }
}

function risky(span: string): RejectionReason {
  return { kind: 'risky_claim', message: `「${span}」属于退款或保障类承诺，V1 不允许 AI 生成，已拒绝该条建议`, evidence: span }
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some(phrase => text.includes(phrase))
}

function judgeDuration(span: string, fact: ResolvedFact): RejectionReason | null {
  const durations = findDurations(span).filter(item => item.expr.kind !== 'minutes')
  if (durations.length !== 1) return unsupported(span, '不是可核对的时长表达')
  const expr = durations[0].expr
  if (fact.type === 'validity') {
    if (fact.value.kind !== 'days') return unsupported(span, '没有可写入文案的有效期天数')
    if (expr.kind !== 'days') return unsupported(span, '有效期是按天配置的，只能写成天数')
    return expr.days === fact.value.days ? null : unsupported(span, '与配置的有效期天数不一致')
  }
  if (fact.type === 'xboardPeriod') {
    const months = PERIOD_MONTHS[fact.value]
    if (months == null) return unsupported(span, '该套餐周期不是时长')
    if (expr.kind !== 'months') return unsupported(span, '套餐周期只能写成月 / 年')
    return expr.months === months ? null : unsupported(span, '与套餐周期不一致')
  }
  return unsupported(span)
}

function judgeTuples(span: string, fact: ResolvedFact): RejectionReason | null {
  if (fact.type !== 'declared') return unsupported(span)
  const text = declaredText(fact.value)
  if (!text) return unsupported(span)
  const spanTuples = extractTuples(span)
  if (spanTuples.length === 0) return unsupported(span, '不是可核对的数量表达')
  const factTuples = extractTuples(text)
  const ok = spanTuples.every(tuple => factTuples.some(item => item.unit === tuple.unit && item.value === tuple.value))
  return ok ? null : unsupported(span, '与商家填写的参数不一致')
}

function judgeRegionPlatform(span: string, fact: ResolvedFact): RejectionReason | null {
  if (fact.type !== 'declared') return unsupported(span)
  const text = declaredText(fact.value)
  if (!text) return unsupported(span)
  const spanIds = regionPlatformIds(span)
  if (spanIds.size === 0) return unsupported(span, '无法识别的地区或平台')
  const factIds = regionPlatformIds(text)
  return [...spanIds].every(id => factIds.has(id)) ? null : unsupported(span, '与商家填写的地区或平台不一致')
}

function judgeDeliveryMethod(span: string, fact: ResolvedFact): RejectionReason | null {
  const saysInstant = containsAny(span, DELIVERY_PHRASES.instant)
  const saysManual = containsAny(span, DELIVERY_PHRASES.manual)
  const saysAutoOpen = containsAny(span, DELIVERY_PHRASES.autoOpen)
  if (fact.type === 'deliveryMethod') {
    const instant = fact.value !== 'manual_service'
    if (saysAutoOpen) return unsupported(span, '自动开通需要引用自动开通配置')
    if (instant && saysInstant && !saysManual) return null
    if (!instant && saysManual && !saysInstant) return null
    return unsupported(span, '与配置的交付方式不一致')
  }
  if (fact.type === 'flag') {
    return fact.value && saysAutoOpen && !saysInstant && !saysManual
      ? null
      : unsupported(span, '与自动开通配置不一致')
  }
  return unsupported(span)
}

function judgeDeliveryTiming(span: string, fact: ResolvedFact): RejectionReason | null {
  if (fact.type !== 'deliveryMethod' || fact.value === 'manual_service') {
    return unsupported(span, '只有自动交付的规格可以描述交付时效')
  }
  if (extractTuples(span).length > 0) return unsupported(span, '没有可核对的时效数值')
  return null
}

function judgeServiceDuration(span: string, fact: ResolvedFact): RejectionReason | null {
  if (fact.type !== 'declared' || fact.value.kind !== 'integer' || fact.value.unit !== 'minute' || fact.value.value == null) {
    return unsupported(span)
  }
  const durations = findDurations(span).filter(item => item.expr.kind === 'minutes')
  if (durations.length !== 1) return unsupported(span, '不是可核对的服务时长')
  const minutes = (durations[0].expr as { minutes: number }).minutes
  return minutes === fact.value.value ? null : unsupported(span, '与预计服务时长不一致')
}

/** Mentions a verified claim of each kind may cover (§7.4): nothing outside its own kind. */
const CLAIM_COVERS: Record<Claim['kind'], CoverClass[]> = {
  duration: ['duration'],
  quantity: ['duration', 'quantity'],
  region: ['regionPlatform'],
  platform: ['regionPlatform'],
  delivery_method: ['timing'],
  delivery_timing: ['timing'],
  service_duration: ['duration'],
  price: [],
  stock: [],
  refund: [],
  guarantee: [],
}

const SENTENCE_BREAKS = ['。', '！', '？', '!', '?', '；', ';', '\n']

function sentenceAt(text: string, start: number, end: number): string {
  const before = text.slice(0, start)
  const startCut = Math.max(...SENTENCE_BREAKS.map(mark => before.lastIndexOf(mark)))
  const after = text.slice(end)
  const ends = SENTENCE_BREAKS.map(mark => after.indexOf(mark)).filter(index => index >= 0)
  const endCut = ends.length > 0 ? end + Math.min(...ends) : text.length
  return text.slice(startCut + 1, endCut)
}

/** Judges the claim's value against its fact, independent of where the span occurs. */
function judgeClaimValue(claim: Claim, span: string, facts: ProductAiFacts): { reason: RejectionReason } | { fact: ResolvedFact } {
  if (claim.kind === 'price' || claim.kind === 'stock') return { reason: unsupported(span, '是价格或库存类数值') }
  if (claim.kind === 'refund' || claim.kind === 'guarantee') return { reason: risky(span) }

  const fact = resolveFactRef(facts, claim.factRef)
  if (!fact) return { reason: unsupported(span) }

  let reason: RejectionReason | null
  switch (claim.kind) {
    case 'duration':
      reason = judgeDuration(span, fact)
      break
    case 'quantity':
      reason = judgeTuples(span, fact)
      break
    case 'region':
    case 'platform':
      reason = judgeRegionPlatform(span, fact)
      break
    case 'delivery_method':
      reason = judgeDeliveryMethod(span, fact)
      break
    case 'delivery_timing':
      reason = judgeDeliveryTiming(span, fact)
      break
    case 'service_duration':
      reason = judgeServiceDuration(span, fact)
      break
  }
  return reason ? { reason } : { fact }
}

/**
 * Sentence-level rules are checked at every occurrence of the span (§7.3):
 * an offer-specific fact only covers occurrences whose sentence names that
 * offer, so one claim cannot vouch for the same words in another offer's
 * sentence.
 */
function occurrenceReason(claim: Claim, fact: ResolvedFact, sentence: string, span: string, facts: ProductAiFacts): RejectionReason | null {
  if (fact.offerIndex != null && facts.offers.length > 1) {
    const offerName = normalizeSpace(facts.offers[fact.offerIndex].name)
    if (!sentence.includes(offerName)) {
      return { kind: 'ambiguous', message: `「${span}」未指明对应的规格，已拒绝该条建议`, evidence: span }
    }
  }
  if (claim.kind === 'service_duration' && !containsAny(sentence, ESTIMATE_TERMS)) {
    return unsupported(span, '服务时长必须表述为预计时长')
  }
  return null
}

// ---------------------------------------------------------------------------
// unit validation (§7.1–§7.4)

function occurrences(text: string, span: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (!span) return out
  let from = 0
  for (;;) {
    const index = text.indexOf(span, from)
    if (index < 0) return out
    out.push([index, index + span.length])
    from = index + 1
  }
}

type VerifiedRange = { start: number; end: number; covers: CoverClass[] }

function covered(mention: HardFactMention, ranges: VerifiedRange[]): boolean {
  return mention.cover != null && ranges.some(range =>
    mention.start >= range.start && mention.end <= range.end && range.covers.includes(mention.cover as CoverClass))
}

function validateUnit(texts: string[], claims: Claim[], facts: ProductAiFacts): RejectionReason | null {
  // Normalise each part but keep the question/answer boundary as a sentence break.
  const unitText = texts.map(normalizeSpace).join('\n')
  if (texts.some(hasForbiddenMarkup)) {
    return { kind: 'format', message: '包含链接、联系方式或标记，已拒绝该条建议', evidence: null }
  }
  if (claims.length > MAX_CLAIMS_PER_UNIT || claims.some(claim => claim.span.length > MAX_SPAN_LENGTH)) {
    return { kind: 'format', message: '事实声明超出上限，已拒绝该条建议', evidence: null }
  }

  const verified: VerifiedRange[] = []
  for (const claim of claims) {
    const span = normalizeSpace(claim.span)
    const ranges = occurrences(unitText, span)
    if (ranges.length === 0) {
      return { kind: 'format', message: '事实声明与文本不一致，已拒绝该条建议', evidence: null }
    }
    const judged = judgeClaimValue(claim, span, facts)
    if ('reason' in judged) return judged.reason
    let firstFailure: RejectionReason | null = null
    for (const [start, end] of ranges) {
      const reason = occurrenceReason(claim, judged.fact, sentenceAt(unitText, start, end), span, facts)
      if (reason) {
        firstFailure ??= reason
      } else {
        verified.push({ start, end, covers: CLAIM_COVERS[claim.kind] })
      }
    }
    // No occurrence passed: report why. Occurrences that failed while others
    // passed stay uncovered and are rejected by the detector below.
    if (!verified.some(range => ranges.some(([start, end]) => range.start === start && range.end === end))) {
      return firstFailure
    }
  }

  for (const mention of detectHardFacts(unitText)) {
    if (mention.cls === 'H2') {
      return { kind: 'risky_claim', message: `「${mention.text}」属于无上限或永久类表述，已拒绝该条建议`, evidence: mention.text }
    }
    if (mention.cls === 'H4') return risky(mention.text)
    if (!covered(mention, verified)) return unsupported(mention.text)
  }
  return null
}

// ---------------------------------------------------------------------------
// assembly

function rejectionIssue(field: ContentField, reason: RejectionReason): Issue | null {
  if (reason.kind === 'format') return null
  return { kind: reason.kind, origin: 'validator', field, message: reason.message, evidence: reason.evidence }
}

export type RejectionCounter = (kind: IssueKind | 'format') => void

function validateTextField(
  field: 'description' | 'usageInstructions' | 'purchaseNotes' | 'afterSalesInstructions',
  unit: ModelOutput['description'],
  facts: ProductAiFacts,
  issues: Issue[],
  onReject: RejectionCounter,
): FieldSuggestion {
  if (unit == null) return { status: 'not_generated', value: null, rejectedItemCount: 0 }
  const text = unit.text.trim()
  if (text === '') return { status: 'not_generated', value: null, rejectedItemCount: 0 }
  let reason: RejectionReason | null = null
  if (text.length > TEXT_LIMITS[field]) {
    reason = { kind: 'format', message: '超出长度上限', evidence: null }
  } else if (field === 'description' && !productDescriptionSchema.safeParse(text).success) {
    reason = { kind: 'format', message: '不符合简介格式', evidence: null }
  } else {
    reason = validateUnit([text], unit.claims, facts)
  }
  if (reason) {
    onReject(reason.kind)
    const issue = rejectionIssue(field, reason)
    if (issue) issues.push(issue)
    return { status: 'rejected', value: null, rejectedItemCount: 1 }
  }
  return { status: 'suggested', value: text, rejectedItemCount: 0 }
}

function validateListField<TItem>(
  field: 'highlights' | 'faq',
  items: TItem[] | null,
  maxItems: number,
  check: (item: TItem) => { value: string | FaqItem | null; reason: RejectionReason | null },
  issues: Issue[],
  onReject: RejectionCounter,
): FieldSuggestion {
  if (items == null || items.length === 0) return { status: 'not_generated', value: null, rejectedItemCount: 0 }
  const accepted: Array<string | FaqItem> = []
  let rejected = 0
  items.forEach((item, index) => {
    if (index >= maxItems) {
      rejected += 1
      onReject('format')
      return
    }
    const result = check(item)
    if (result.reason || result.value == null) {
      rejected += 1
      const reason = result.reason ?? { kind: 'format' as const, message: '内容为空', evidence: null }
      onReject(reason.kind)
      const issue = rejectionIssue(field, reason)
      if (issue) issues.push(issue)
      return
    }
    accepted.push(result.value)
  })
  if (accepted.length === 0) return { status: 'rejected', value: null, rejectedItemCount: rejected }
  return { status: 'suggested', value: accepted as string[] | FaqItem[], rejectedItemCount: rejected }
}

function modelIssues(output: ModelOutput): Issue[] {
  return output.issues.slice(0, MAX_MODEL_ISSUES).map(issue => ({
    kind: issue.kind,
    origin: 'model' as const,
    field: issue.field,
    message: clip(issue.message.trim(), MAX_ISSUE_TEXT),
    evidence: issue.evidence == null ? null : clip(issue.evidence.trim(), MAX_ISSUE_TEXT),
  }))
}

function missingIssues(context: ProductContentAiContext, readinessCodes: string[], upstreamRequested: boolean): Issue[] {
  const issues: Issue[] = []
  for (const code of readinessCodes) {
    const missing = READINESS_MISSING[code]
    if (missing && !issues.some(issue => issue.message === missing.message)) {
      issues.push({ kind: 'missing', origin: 'validator', field: missing.field, message: missing.message, evidence: null })
    }
  }
  const facts = context.facts
  const unknown = new Set<string>()
  for (const attr of Object.values(facts.productAttributes)) if (attr.value == null) unknown.add(attr.title)
  for (const offer of facts.offers) {
    for (const attr of Object.values(offer.attributes)) if (attr.value == null) unknown.add(attr.title)
  }
  if (unknown.size > 0) {
    issues.push({
      kind: 'missing',
      origin: 'validator',
      field: 'attributes',
      message: clip(`以下信息未提供：${[...unknown].join('、')}，说明中不会提及`, MAX_ISSUE_TEXT),
      evidence: null,
    })
  }
  if (upstreamRequested && context.untrusted.upstreamDescriptionText == null) {
    issues.push({
      kind: 'missing',
      origin: 'validator',
      field: null,
      message: '尚未检查上游介绍，可先使用「检查上游介绍」',
      evidence: null,
    })
  }
  return issues
}

function inputRiskIssues(context: ProductContentAiContext): Issue[] {
  const content = context.untrusted.currentContent
  const sources = [
    content.description,
    ...content.details.highlights,
    content.details.usageInstructions,
    content.details.purchaseNotes,
    content.details.afterSalesInstructions,
    ...content.details.faq.flatMap(item => [item.question, item.answer]),
    context.untrusted.sourceNotes,
    context.untrusted.upstreamDescriptionText,
  ].filter((text): text is string => typeof text === 'string' && text !== '')
  const joined = sources.join('\n')
  const issues: Issue[] = []
  const unbounded = findUnboundedTerms(joined)[0]
  if (unbounded) {
    issues.push({
      kind: 'risky_claim',
      origin: 'validator',
      field: null,
      message: `现有内容或补充说明中含有「${unbounded.text}」等无上限或永久类表述，建议核实后修改`,
      evidence: unbounded.text,
    })
  }
  const promise = findPromiseTerms(joined)[0]
  if (promise) {
    issues.push({
      kind: 'risky_claim',
      origin: 'validator',
      field: null,
      message: `现有内容或补充说明中含有「${promise.text}」等承诺类表述，建议核实后修改`,
      evidence: promise.text,
    })
  }
  return issues
}

export function countIssues(issues: Issue[]): IssueCounts {
  const counts: IssueCounts = { missing: 0, ambiguous: 0, risky_claim: 0, unsupported_fact: 0 }
  for (const issue of issues) counts[issue.kind] += 1
  return counts
}

export function validateModelOutput(args: {
  raw: unknown
  context: ProductContentAiContext
  readinessCodes: string[]
  upstreamRequested: boolean
  onReject?: RejectionCounter
}): ValidatedSuggestion {
  if (!isModelOutput(args.raw)) throw new ModelOutputInvalidError()
  const output = args.raw
  const facts = args.context.facts
  const onReject: RejectionCounter = args.onReject ?? (() => {})
  const targets = new Set(args.context.targetFields)
  const issues: Issue[] = []
  const fields: Partial<Record<ContentField, FieldSuggestion>> = {}

  for (const field of ['description', 'usageInstructions', 'purchaseNotes', 'afterSalesInstructions'] as const) {
    if (targets.has(field)) fields[field] = validateTextField(field, output[field], facts, issues, onReject)
  }
  if (targets.has('highlights')) {
    fields.highlights = validateListField(
      'highlights',
      output.highlights,
      GENERATION_LIMITS.highlightsMaxItems,
      unit => {
        const text = unit.text.trim()
        if (text === '') return { value: null, reason: null }
        if (text.length > GENERATION_LIMITS.highlightMax) {
          return { value: null, reason: { kind: 'format', message: '超出长度上限', evidence: null } }
        }
        return { value: text, reason: validateUnit([text], unit.claims, facts) }
      },
      issues,
      onReject,
    )
  }
  if (targets.has('faq')) {
    fields.faq = validateListField(
      'faq',
      output.faq,
      GENERATION_LIMITS.faqMaxItems,
      unit => {
        const question = unit.question.trim()
        const answer = unit.answer.trim()
        if (question === '' || answer === '') return { value: null, reason: null }
        if (question.length > GENERATION_LIMITS.faqQuestionMax || answer.length > GENERATION_LIMITS.faqAnswerMax) {
          return { value: null, reason: { kind: 'format', message: '超出长度上限', evidence: null } }
        }
        return { value: { question, answer }, reason: validateUnit([question, answer], unit.claims, facts) }
      },
      issues,
      onReject,
    )
  }

  assertDetailsShape(fields, args.context.untrusted.currentContent.details)

  return {
    fields,
    issues: [
      ...missingIssues(args.context, args.readinessCodes, args.upstreamRequested),
      ...inputRiskIssues(args.context),
      ...issues,
      ...modelIssues(output),
    ],
  }
}

/** §7.1-3: the suggested values, merged over current details, must pass the product schema. */
function assertDetailsShape(fields: Partial<Record<ContentField, FieldSuggestion>>, current: ProductDetails) {
  const value = <T>(field: ContentField, fallback: T): T => {
    const suggestion = fields[field]
    return suggestion?.status === 'suggested' ? (suggestion.value as T) : fallback
  }
  const merged: ProductDetails = {
    highlights: value('highlights', current.highlights),
    usageInstructions: value('usageInstructions', current.usageInstructions),
    purchaseNotes: value('purchaseNotes', current.purchaseNotes),
    afterSalesInstructions: value('afterSalesInstructions', current.afterSalesInstructions),
    faq: value('faq', current.faq),
  }
  if (!productDetailsSchema.safeParse(merged).success) {
    // Per-unit limits are stricter than the product schema, so this is a
    // programming error; fail closed instead of offering an unsaveable draft.
    throw new ModelOutputInvalidError()
  }
}

export function suggestedFieldCount(fields: Partial<Record<ContentField, FieldSuggestion>>): number {
  return Object.values(fields).filter(field => field?.status === 'suggested').length
}
