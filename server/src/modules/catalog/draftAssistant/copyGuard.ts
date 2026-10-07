import { detectHardFacts, hasForbiddenMarkup } from '../contentCopilot/normalizers.js'
import type { GroundedDraftCopy } from './schema.js'

/** Original text is evidence for a human-reviewed suggestion, never a verified fact. */
export function isDraftSourceExcerpt(value: string, source: string): boolean {
  let index = source.indexOf(value)
  while (index >= 0) {
    const before = source.slice(0, index)
    const after = source.slice(index + value.length)
    const cutsStart = /^[\d.]/.test(value) && /[\d.+-]$/.test(before)
    const cutsEnd = /\d$/.test(value) && /^[\d.%]/.test(after)
    if (!cutsStart && !cutsEnd) return true
    index = source.indexOf(value, index + 1)
  }
  return false
}

function sentences(value: string): string[] {
  return value.normalize('NFKC').split(/[。！？!?；;\r\n]+/u).map(sentence => sentence.trim()).filter(Boolean)
}

// Supplement the content Copilot detectors for prose: counts such as 单份/两轮,
// file formats and service/policy promises need the whole original sentence.
// This closed detector cannot prove arbitrary semantic entailment.
const PROTECTED_COPY = /\d|(?:[零〇一二两三四五六七八九十百千万半几数]|若干|单|双)\s*(?:份|轮|版|页|套|项|个|次)|\b(?:PDF|DOCX?|XLSX?|PPTX?|WORD|ZIP|RAR|PSD|AI|ATS)\b|免费|赠送|包改|改到满意|确保|必定|必然|保过|包过|交付|交稿|发货|工作日|修改|返工|代写|重写|润色|翻译|校对|面试辅导|职业规划|求职辅导|保密|加密|删除|售后/iu
const EDITORIAL_COPY = /原文|文案|schema|提示词|未说明|未提及|待确认|本次生成|忽略.*(?:规则|指令)/iu
const FRAGMENTS = /[^。！？!?；;\r\n]+(?:[。！？!?；;\r\n]+|$)/gu
const clauses = (sentence: string) => sentence.split(/[,，]/u).map(part => part.trim()).filter(Boolean).sort().join('\u0000')

export function hasForbiddenDraftCopy(value: string): boolean {
  const normalized = value.normalize('NFKC')
  return hasForbiddenMarkup(normalized) || detectHardFacts(normalized).some(item => ['H2', 'H4', 'H7'].includes(item.cls))
}

export function validateGroundedDraftCopy(copy: GroundedDraftCopy | null, source: string): string | null {
  if (!copy || !copy.text.trim()) return null
  if (hasForbiddenDraftCopy(copy.text) || copy.sourceQuotes.length === 0) return null
  if (copy.sourceQuotes.some(quote => quote.trim().length < 2 || !/[\p{L}\p{N}]/u.test(quote) || !isDraftSourceExcerpt(quote, source))) return null
  const sourceFragments = source.match(FRAGMENTS) ?? []
  const originals = new Set(sentences(source))
  const quotes = copy.sourceQuotes.map(quote => quote.normalize('NFKC'))
  const fragments = copy.text.match(FRAGMENTS) ?? []
  let changed = false
  const accepted = fragments.flatMap(fragment => {
    const sentence = sentences(fragment)[0]
    if (!sentence || EDITORIAL_COPY.test(sentence)) { changed = true; return [] }
    if (PROTECTED_COPY.test(sentence) || /不(?:包括|包含|提供|涉及|延伸)/u.test(sentence) || detectHardFacts(sentence).length > 0) {
      // Matching isolated values or a broad quote cannot authorize a rewritten
      // hard fact, dropped negation, different service or different package.
      if (!originals.has(sentence) || !quotes.some(quote => quote.includes(sentence))) {
        // A verbatim fragment can omit a qualifier (or even a negation).
        // Restore its uniquely quoted COMPLETE source sentence, never infer it.
        const matches = sourceFragments.filter(original => {
          const full = sentences(original)[0]
          return full && (full.includes(sentence) || clauses(full) === clauses(sentence)) && quotes.some(quote => quote.includes(full))
            && !hasForbiddenDraftCopy(original) && !EDITORIAL_COPY.test(original)
        })
        changed = true
        return matches.length === 1 ? [matches[0].trim()] : []
      }
    }
    return [fragment]
  })
  // One unsupported sentence must not erase the independent, useful prose.
  // Only accepted model sentences or complete, uniquely quoted source sentences remain.
  return (changed ? accepted.join('') : copy.text).trim() || null
}
