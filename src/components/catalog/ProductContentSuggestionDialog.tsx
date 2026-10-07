import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import type { ProductEditorActor } from '../../api/catalog'
import {
  CONTENT_SUGGESTION_FIELDS,
  reportContentSuggestionApplied,
  requestContentSuggestion,
  type ContentSuggestionFaqItem,
  type ContentSuggestionField,
  type ContentSuggestionIssue,
  type ContentSuggestionResponse,
  type FieldSuggestion,
} from '../../api/contentSuggestion'
import type { ProductDetails } from '../../types/catalog'
import { useIsMobileViewport } from '../../hooks/useMediaQuery'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'

// SPEC-AI-PRODUCT-001 §8 — suggestions are compared side by side, every field
// starts unchecked, and 「填入已选内容」 only fills the editor form. Saving,
// CAS and readiness stay with the editor's normal save flow.

export type ContentSuggestionPatch = {
  description?: string
  details?: Partial<ProductDetails>
}

interface Props {
  open: boolean
  actor: ProductEditorActor
  productId: number
  contentVersion: number
  canUseUpstream: boolean
  current: { description: string; details: ProductDetails }
  onApply: (patch: ContentSuggestionPatch) => void
  onClose: () => void
  onReload: () => void
  onUnavailable: () => void
}

const FIELD_LABELS: Record<ContentSuggestionField, string> = {
  description: '简介',
  highlights: '亮点',
  usageInstructions: '使用说明',
  purchaseNotes: '购买须知',
  afterSalesInstructions: '售后说明',
  faq: '常见问题',
}

const ISSUE_LABELS: Record<ContentSuggestionIssue['kind'], string> = {
  unsupported_fact: '缺少依据',
  risky_claim: '高风险表述',
  missing: '信息缺失',
  ambiguous: '表述含糊',
}

const MAX_NOTES = 2000

type Failure = { message: string; code: string | undefined }

function failureFor(err: unknown): Failure {
  const code = getApiErrorCode(err)
  switch (code) {
    case 'AI_QUOTA_EXCEEDED':
      return { code, message: '今日 AI 整理次数已用完，明天再试' }
    case 'PRODUCT_CONTENT_CHANGED':
      return { code, message: '商品内容已更新，请刷新后再试' }
    case 'AI_GENERATION_IN_PROGRESS':
      return { code, message: '上一次整理仍在进行中，请稍后' }
    case 'AI_PRODUCT_TEMPLATE_REQUIRED':
      return { code, message: getApiErrorMessage(err, '请先为商品选择商品形态') }
    case 'AI_CONTEXT_TOO_LARGE':
      return { code, message: getApiErrorMessage(err, '商品信息过多，暂不支持 AI 整理，请手动编辑') }
    default:
      return { code, message: 'AI 暂时不可用，你可以继续手动编辑' }
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } } | undefined)?.response?.status === 404
}

function currentValue(field: ContentSuggestionField, current: Props['current']) {
  if (field === 'description') return current.description
  return current.details[field]
}

function ValueView({ field, value }: { field: ContentSuggestionField; value: unknown }) {
  if (field === 'highlights') {
    const items = (value as string[] | null) ?? []
    if (items.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">（空）</p>
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-text)]">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    )
  }
  if (field === 'faq') {
    const items = (value as ContentSuggestionFaqItem[] | null) ?? []
    if (items.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">（空）</p>
    return (
      <dl className="space-y-2 text-sm text-[var(--color-text)]">
        {items.map((item, index) => (
          <div key={index}>
            <dt className="font-semibold">问：{item.question}</dt>
            <dd className="whitespace-pre-wrap break-words">答：{item.answer}</dd>
          </div>
        ))}
      </dl>
    )
  }
  const text = typeof value === 'string' ? value : ''
  if (text.trim() === '') return <p className="text-sm text-[var(--color-text-muted)]">（空）</p>
  return <p className="whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{text}</p>
}

function SuggestionStatus({ suggestion, issues }: { suggestion: FieldSuggestion; issues: ContentSuggestionIssue[] }) {
  if (suggestion.status === 'not_generated') {
    return <p className="text-sm text-[var(--color-text-muted)]">未生成</p>
  }
  if (suggestion.status === 'rejected') {
    return (
      <div className="space-y-1 text-sm text-[var(--color-danger-text)]">
        <p className="font-semibold">未通过校验，不可采纳</p>
        {issues.length > 0
          ? issues.map((issue, index) => <p key={index}>{issue.message}</p>)
          : <p>内容格式不符合要求</p>}
      </div>
    )
  }
  return null
}

export default function ProductContentSuggestionDialog({
  open,
  actor,
  productId,
  contentVersion,
  canUseUpstream,
  current,
  onApply,
  onClose,
  onReload,
  onUnavailable,
}: Props) {
  const isMobile = useIsMobileViewport()
  const guard = useRef(createLatestRequestGuard()).current
  const [targetFields, setTargetFields] = useState<ContentSuggestionField[]>([...CONTENT_SUGGESTION_FIELDS])
  const [sourceNotes, setSourceNotes] = useState('')
  const [useUpstream, setUseUpstream] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ContentSuggestionResponse | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [quotaExhausted, setQuotaExhausted] = useState(false)
  const [selected, setSelected] = useState<ContentSuggestionField[]>([])
  const [pane, setPane] = useState<'current' | 'suggestion'>('suggestion')

  useEffect(() => {
    if (open) return
    // Closing discards any in-flight result (§8.2-3).
    guard.invalidate()
    setLoading(false)
    setResult(null)
    setFailure(null)
    setSelected([])
    setPane('suggestion')
  }, [open, guard])

  const stale = result != null && result.basedOnContentVersion !== contentVersion

  function toggleTarget(field: ContentSuggestionField, checked: boolean) {
    setTargetFields(prev => checked
      ? CONTENT_SUGGESTION_FIELDS.filter(item => item === field || prev.includes(item))
      : prev.filter(item => item !== field))
  }

  async function handleGenerate() {
    if (loading || targetFields.length === 0) return
    const canCommit = guard.begin()
    setLoading(true)
    setFailure(null)
    setResult(null)
    setSelected([])
    try {
      const notes = sourceNotes.trim()
      const response = await requestContentSuggestion(actor, productId, {
        expectedContentVersion: contentVersion,
        targetFields,
        ...(notes ? { sourceNotes: notes } : {}),
        ...(canUseUpstream && useUpstream ? { useUpstreamDescription: true } : {}),
      })
      if (!canCommit()) return
      setResult(response)
    } catch (err) {
      if (!canCommit()) return
      if (isNotFound(err)) {
        onUnavailable()
        onClose()
        return
      }
      const next = failureFor(err)
      if (next.code === 'AI_QUOTA_EXCEEDED') setQuotaExhausted(true)
      setFailure(next)
    } finally {
      if (canCommit()) setLoading(false)
    }
  }

  function handleApply() {
    if (!result || stale || selected.length === 0) return
    const patch: ContentSuggestionPatch = {}
    const details: Partial<ProductDetails> = {}
    for (const field of selected) {
      const suggestion = result.fields[field]
      if (suggestion?.status !== 'suggested') continue
      if (field === 'description') patch.description = suggestion.value as string
      else if (field === 'highlights') details.highlights = suggestion.value as string[]
      else if (field === 'faq') details.faq = suggestion.value as ContentSuggestionFaqItem[]
      else details[field] = suggestion.value as string
    }
    if (Object.keys(details).length > 0) patch.details = details
    onApply(patch)
    void reportContentSuggestionApplied(actor, productId, result.generationId, selected.length).catch(() => {})
    onClose()
  }

  const warnings = result?.issues.filter(issue => issue.kind === 'unsupported_fact' || issue.kind === 'risky_claim') ?? []
  const notices = result?.issues.filter(issue => issue.kind === 'missing' || issue.kind === 'ambiguous') ?? []

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto" data-testid="content-suggestion-dialog">
        <DialogTitle>AI 整理说明</DialogTitle>
        <DialogDescription>
          AI 只基于已配置的商品信息整理说明文字，不会修改价格、库存、规格或交付配置。建议需要你逐项核对后才会填入编辑区，填入后仍需手动保存。
        </DialogDescription>

        <div className="mt-4 space-y-4 text-sm">
          <fieldset className="space-y-2" disabled={loading}>
            <legend className="mb-1 font-semibold text-[var(--color-text)]">整理哪些字段</legend>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {CONTENT_SUGGESTION_FIELDS.map(field => (
                <label key={field} className="flex min-h-11 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={targetFields.includes(field)}
                    onChange={event => toggleTarget(field, event.target.checked)}
                    data-testid={`content-suggestion-target-${field}`}
                  />
                  {FIELD_LABELS[field]}
                </label>
              ))}
            </div>
            <label className="block">
              <span className="mb-1 block font-semibold text-[var(--color-text)]">补充说明（可选）</span>
              <textarea
                className="input min-h-20 w-full"
                value={sourceNotes}
                maxLength={MAX_NOTES}
                placeholder="可补充使用步骤等说明；请勿填写账号、密码、卡密等敏感信息"
                onChange={event => setSourceNotes(event.target.value)}
                data-testid="content-suggestion-notes"
              />
            </label>
            {canUseUpstream && (
              <label className="flex min-h-11 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={useUpstream}
                  onChange={event => setUseUpstream(event.target.checked)}
                  data-testid="content-suggestion-use-upstream"
                />
                参考上游介绍（上游中的数字与承诺不会被当作事实）
              </label>
            )}
          </fieldset>

          <div className="flex justify-end">
            <button
              type="button"
              className="btn-secondary min-h-11 px-4"
              disabled={loading || quotaExhausted || targetFields.length === 0}
              onClick={() => void handleGenerate()}
              data-testid="content-suggestion-generate"
            >
              {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {loading ? '正在整理…' : result || failure ? '重新整理（消耗一次）' : '开始整理'}
            </button>
          </div>

          {failure && (
            <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3" data-testid="content-suggestion-error">
              <p className="text-[var(--color-text)]">{failure.message}</p>
              {failure.code === 'PRODUCT_CONTENT_CHANGED' && (
                <button type="button" className="btn-secondary min-h-11 px-4" onClick={onReload} data-testid="content-suggestion-reload">
                  刷新商品内容
                </button>
              )}
            </div>
          )}

          {result && (
            <div className="space-y-4" data-testid="content-suggestion-result">
              {stale && (
                <p className="rounded-lg border border-[var(--color-border)] p-3 text-[var(--color-text)]" data-testid="content-suggestion-stale">
                  商品内容已变化，这些建议已失效，请重新整理。
                </p>
              )}
              {warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-[var(--color-danger-text)]" data-testid="content-suggestion-warnings">
                  {warnings.map((issue, index) => (
                    <li key={index}>【{ISSUE_LABELS[issue.kind]}】{issue.message}</li>
                  ))}
                </ul>
              )}
              {notices.length > 0 && (
                <ul className="space-y-1 rounded-lg border border-[var(--color-border)] p-3 text-[var(--color-text-muted)]" data-testid="content-suggestion-notices">
                  {notices.map((issue, index) => (
                    <li key={index}>【{ISSUE_LABELS[issue.kind]}】{issue.message}</li>
                  ))}
                </ul>
              )}
              {Object.values(result.fields).every(field => field?.status !== 'suggested') && (
                <p className="text-[var(--color-text-muted)]" data-testid="content-suggestion-none">
                  没有可直接采纳的建议，请参考提示手动完善。
                </p>
              )}

              {isMobile && (
                <div role="tablist" aria-label="内容对比" className="grid grid-cols-2 gap-2">
                  {(['current', 'suggestion'] as const).map(value => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={pane === value}
                      className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${
                        pane === value
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]'
                          : 'border-[var(--color-border)] text-[var(--color-text)]'
                      }`}
                      onClick={() => setPane(value)}
                      data-testid={`content-suggestion-tab-${value}`}
                    >
                      {value === 'current' ? '当前内容' : 'AI 建议'}
                    </button>
                  ))}
                </div>
              )}

              {CONTENT_SUGGESTION_FIELDS.filter(field => result.fields[field]).map(field => {
                const suggestion = result.fields[field] as FieldSuggestion
                const fieldIssues = result.issues.filter(issue => issue.field === field && issue.origin === 'validator')
                const selectable = suggestion.status === 'suggested' && !stale
                return (
                  <section
                    key={field}
                    className="rounded-lg border border-[var(--color-border)] p-3"
                    data-testid={`content-suggestion-field-${field}`}
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-bold text-[var(--color-text)]">{FIELD_LABELS[field]}</h3>
                      {suggestion.status === 'suggested' && (
                        <label className="flex min-h-11 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={!selectable}
                            checked={selected.includes(field)}
                            onChange={event => setSelected(prev => event.target.checked
                              ? [...prev, field]
                              : prev.filter(item => item !== field))}
                            data-testid={`content-suggestion-select-${field}`}
                          />
                          采纳此项
                        </label>
                      )}
                    </div>
                    <div className={isMobile ? '' : 'grid grid-cols-2 gap-3'}>
                      {(!isMobile || pane === 'current') && (
                        <div>
                          <h4 className="mb-1 text-xs font-semibold text-[var(--color-text-muted)]">当前内容</h4>
                          <ValueView field={field} value={currentValue(field, current)} />
                        </div>
                      )}
                      {(!isMobile || pane === 'suggestion') && (
                        <div>
                          <h4 className="mb-1 text-xs font-semibold text-[var(--color-text-muted)]">AI 建议，请核对后采纳</h4>
                          {suggestion.status === 'suggested'
                            ? <ValueView field={field} value={suggestion.value} />
                            : <SuggestionStatus suggestion={suggestion} issues={fieldIssues} />}
                          {suggestion.rejectedItemCount > 0 && suggestion.status === 'suggested' && (
                            <p className="mt-1 text-xs text-[var(--color-text-muted)]">已过滤 {suggestion.rejectedItemCount} 条</p>
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                )
              })}

              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary min-h-11 px-4" onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary min-h-11 px-4"
                  disabled={stale || selected.length === 0}
                  onClick={handleApply}
                  data-testid="content-suggestion-apply"
                >
                  填入已选内容
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
