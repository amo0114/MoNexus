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
import { ESTIMATE_TERMS, PERIOD_MONTHS } from './lexicon.js'
import {
  detectHardFacts,
  extractTuples,
  findDeliveryPhrases,
  findDurations,
  findPromiseTerms,
  findQuantities,
  findRegionPlatformMentions,
  findTimingTerms,
  findUnboundedTerms,
  hasForbiddenMarkup,
  isPriceTuple,
  normalizeSpace,
  regionPlatformIds,
  type CoverClass,
  type DeliveryPhraseKind,
  type DurationExpr,
  type HardFactMention,
  type QuantityTuple,
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

type CoveredMention = { start: number; end: number; cover: CoverClass }
type Judgement = { reason: RejectionReason } | { covers: CoveredMention[] }

const reject = (reason: RejectionReason): Judgement => ({ reason })

/**
 * Every hard-fact mention inside a claim span is verified individually; the
 * claim covers only the mentions that matched its fact (§7.3 / §7.4). A wide
 * span therefore cannot vouch for a second duration, a price, a region or a
 * timing word it happens to contain — those stay uncovered and the detector
 * rejects the unit.
 */
function verifiedOrUnsupported(span: string, covers: CoveredMention[], why: string): Judgement {
  return covers.length > 0 ? { covers } : reject(unsupported(span, why))
}

function judgeDuration(span: string, fact: ResolvedFact): Judgement {
  const durations = findDurations(span)
  if (durations.length === 0) return reject(unsupported(span, '不是可核对的时长表达'))
  let matches: (expr: DurationExpr) => boolean
  if (fact.type === 'validity') {
    if (fact.value.kind !== 'days') return reject(unsupported(span, '没有可写入文案的有效期天数'))
    const days = fact.value.days
    // Days facts only support day/week wording (CP-08).
    matches = expr => expr.kind === 'days' && expr.days === days
  } else if (fact.type === 'xboardPeriod') {
    const months = PERIOD_MONTHS[fact.value]
    if (months == null) return reject(unsupported(span, '该套餐周期不是时长'))
    // Period facts only support calendar wording (CP-08).
    matches = expr => expr.kind === 'months' && expr.months === months
  } else {
    return reject(unsupported(span))
  }
  const covers = durations.filter(item => matches(item.expr)).map(item => ({ start: item.start, end: item.end, cover: 'duration' as const }))
  return verifiedOrUnsupported(span, covers, '与配置的有效期或套餐周期不一致')
}

function judgeTuples(span: string, fact: ResolvedFact): Judgement {
  if (fact.type !== 'declared') return reject(unsupported(span))
  const text = declaredText(fact.value)
  if (!text) return reject(unsupported(span))
  const factTuples = extractTuples(text)
  const known = (tuple: QuantityTuple) => factTuples.some(item => item.unit === tuple.unit && item.value === tuple.value)
  const covers: CoveredMention[] = [
    ...findQuantities(span).filter(item => !isPriceTuple(item.tuple) && known(item.tuple)).map(item => ({ start: item.start, end: item.end, cover: 'quantity' as const })),
    ...findDurations(span).filter(item => known(durationTuple(item.expr))).map(item => ({ start: item.start, end: item.end, cover: 'duration' as const })),
  ]
  return verifiedOrUnsupported(span, covers, '与商家填写的参数不一致')
}

function durationTuple(expr: DurationExpr): QuantityTuple {
  if (expr.kind === 'days') return { value: expr.days, unit: 'day' }
  if (expr.kind === 'months') return { value: expr.months, unit: 'month' }
  return { value: expr.minutes, unit: 'minute' }
}

function judgeRegionPlatform(span: string, fact: ResolvedFact): Judgement {
  if (fact.type !== 'declared') return reject(unsupported(span))
  const text = declaredText(fact.value)
  if (!text) return reject(unsupported(span))
  const factIds = regionPlatformIds(text)
  const covers = findRegionPlatformMentions(span)
    .filter(item => factIds.has(item.id))
    .map(item => ({ start: item.start, end: item.end, cover: 'regionPlatform' as const }))
  return verifiedOrUnsupported(span, covers, '与商家填写的地区或平台不一致')
}

function isInstantFact(fact: ResolvedFact): boolean {
  return fact.type === 'deliveryMethod' && fact.value !== 'manual_service'
}

function judgeDeliveryMethod(span: string, fact: ResolvedFact): Judgement {
  let expected: DeliveryPhraseKind
  if (fact.type === 'deliveryMethod') {
    expected = fact.value === 'manual_service' ? 'manual' : 'instant'
  } else if (fact.type === 'flag' && fact.value) {
    expected = 'autoOpen'
  } else {
    return reject(unsupported(span, '与交付配置不一致'))
  }
  const phrases = findDeliveryPhrases(span)
  if (phrases.length === 0 || phrases.some(item => item.phrase !== expected)) {
    return reject(unsupported(span, '与配置的交付方式不一致'))
  }
  // Timing words are only true for instant delivery; for manual or
  // auto-provisioned offers they stay uncovered (「人工处理，秒到」).
  const timing = isInstantFact(fact) ? findTimingTerms(span) : []
  return {
    covers: [
      ...phrases.map(item => ({ start: item.start, end: item.end, cover: 'delivery' as const })),
      ...timing.map(item => ({ start: item.start, end: item.end, cover: 'timing' as const })),
    ],
  }
}

function judgeDeliveryTiming(span: string, fact: ResolvedFact): Judgement {
  if (!isInstantFact(fact)) return reject(unsupported(span, '只有自动交付的规格可以描述交付时效'))
  if (extractTuples(span).length > 0) return reject(unsupported(span, '没有可核对的时效数值'))
  const phrases = findDeliveryPhrases(span)
  if (phrases.some(item => item.phrase !== 'instant')) return reject(unsupported(span, '与配置的交付方式不一致'))
  const covers: CoveredMention[] = [
    ...findTimingTerms(span).map(item => ({ start: item.start, end: item.end, cover: 'timing' as const })),
    ...phrases.map(item => ({ start: item.start, end: item.end, cover: 'delivery' as const })),
  ]
  return verifiedOrUnsupported(span, covers, '不是可核对的时效表达')
}

function judgeServiceDuration(span: string, fact: ResolvedFact): Judgement {
  if (fact.type !== 'declared' || fact.value.kind !== 'integer' || fact.value.unit !== 'minute' || fact.value.value == null) {
    return reject(unsupported(span))
  }
  const minutes = fact.value.value
  const covers = findDurations(span)
    .filter(item => item.expr.kind === 'minutes' && item.expr.minutes === minutes)
    .map(item => ({ start: item.start, end: item.end, cover: 'duration' as const }))
  return verifiedOrUnsupported(span, covers, '与预计服务时长不一致')
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
function judgeClaimValue(claim: Claim, span: string, facts: ProductAiFacts): { reason: RejectionReason } | { fact: ResolvedFact; covers: CoveredMention[] } {
  if (claim.kind === 'price' || claim.kind === 'stock') return { reason: unsupported(span, '是价格或库存类数值') }
  if (claim.kind === 'refund' || claim.kind === 'guarantee') return { reason: risky(span) }

  const fact = resolveFactRef(facts, claim.factRef)
  if (!fact) return { reason: unsupported(span) }

  let judgement: Judgement
  switch (claim.kind) {
    case 'duration':
      judgement = judgeDuration(span, fact)
      break
    case 'quantity':
      judgement = judgeTuples(span, fact)
      break
    case 'region':
    case 'platform':
      judgement = judgeRegionPlatform(span, fact)
      break
    case 'delivery_method':
      judgement = judgeDeliveryMethod(span, fact)
      break
    case 'delivery_timing':
      judgement = judgeDeliveryTiming(span, fact)
      break
    case 'service_duration':
      judgement = judgeServiceDuration(span, fact)
      break
  }
  return 'reason' in judgement ? judgement : { fact, covers: judgement.covers }
}

/**
 * Sentence-level rules (§7.2-3), checked for every verified mention in the
 * sentence that mention actually sits in — never the span as a whole, so one
 * sentence's offer name or 「预计」 cannot vouch for another sentence.
 */
function mentionSentenceReason(claim: Claim, fact: ResolvedFact, sentence: string, label: string, facts: ProductAiFacts): RejectionReason | null {
  if (fact.offerIndex != null && facts.offers.length > 1) {
    const offerName = normalizeSpace(facts.offers[fact.offerIndex].name)
    if (!sentence.includes(offerName)) {
      return { kind: 'ambiguous', message: `「${label}」未指明对应的规格，已拒绝该条建议`, evidence: label }
    }
  }
  if (claim.kind === 'service_duration' && !containsAny(sentence, ESTIMATE_TERMS)) {
    return unsupported(label, '服务时长必须表述为预计时长')
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

function covered(mention: HardFactMention, covers: CoveredMention[]): boolean {
  return mention.cover != null && covers.some(item =>
    item.cover === mention.cover && mention.start >= item.start && mention.end <= item.end)
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

  const covers: CoveredMention[] = []
  const failed: Array<CoveredMention & { reason: RejectionReason }> = []
  for (const claim of claims) {
    const span = normalizeSpace(claim.span)
    const ranges = occurrences(unitText, span)
    if (ranges.length === 0) {
      return { kind: 'format', message: '事实声明与文本不一致，已拒绝该条建议', evidence: null }
    }
    const judged = judgeClaimValue(claim, span, facts)
    if ('reason' in judged) return judged.reason
    for (const [offset] of ranges) {
      for (const item of judged.covers) {
        const mention = { start: item.start + offset, end: item.end + offset, cover: item.cover }
        const label = unitText.slice(mention.start, mention.end)
        const reason = mentionSentenceReason(claim, judged.fact, sentenceAt(unitText, mention.start, mention.end), label, facts)
        if (reason) failed.push({ ...mention, reason })
        else covers.push(mention)
      }
    }
  }
  // A mention that failed its sentence rule is only acceptable when another
  // claim verified the same words there; otherwise the unit is rejected,
  // whether or not the detector would recognise those words.
  for (const item of failed) {
    const vouched = covers.some(cover => cover.cover === item.cover && cover.start <= item.start && item.end <= cover.end)
    if (!vouched) return item.reason
  }

  for (const mention of detectHardFacts(unitText)) {
    if (mention.cls === 'H2') {
      return { kind: 'risky_claim', message: `「${mention.text}」属于无上限或永久类表述，已拒绝该条建议`, evidence: mention.text }
    }
    if (mention.cls === 'H4') return risky(mention.text)
    if (mention.cls === 'H7') return unsupported(mention.text, '是价格类数值，V1 不允许写入说明')
    if (!covered(mention, covers)) return unsupported(mention.text)
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
