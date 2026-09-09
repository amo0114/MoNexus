import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { EMPTY_PRODUCT_DETAILS, type ProductDetails } from '../../types/catalog'

export type ProductDetailsMode = 'draft' | 'publish'

export type ProductDetailsFieldsProps = {
  value: ProductDetails
  onChange: (next: ProductDetails) => void
  disabled?: boolean
  /** publish: first publish requires non-empty purchaseNotes and afterSalesInstructions */
  mode?: ProductDetailsMode
}

const MAX_HIGHLIGHTS = 4
const MAX_HIGHLIGHT_LENGTH = 40
const MAX_USAGE_INSTRUCTIONS = 4000
const MAX_PURCHASE_NOTES = 2000
const MAX_AFTER_SALES = 2000
const MAX_FAQ = 8
const MAX_FAQ_QUESTION = 100
const MAX_FAQ_ANSWER = 1000

function completeDetails(next: ProductDetails): ProductDetails {
  return {
    highlights: Array.isArray(next.highlights)
      ? next.highlights.filter((item) => typeof item === 'string' && item.length > 0)
      : [],
    usageInstructions: typeof next.usageInstructions === 'string' ? next.usageInstructions : '',
    purchaseNotes: typeof next.purchaseNotes === 'string' ? next.purchaseNotes : '',
    afterSalesInstructions: typeof next.afterSalesInstructions === 'string' ? next.afterSalesInstructions : '',
    faq: Array.isArray(next.faq)
      ? next.faq.map((item) => ({
          question: typeof item?.question === 'string' ? item.question : '',
          answer: typeof item?.answer === 'string' ? item.answer : '',
        }))
      : [],
  }
}

export default function ProductDetailsFields({
  value,
  onChange,
  disabled = false,
  mode = 'draft',
}: ProductDetailsFieldsProps) {
  const idPrefix = useId()
  const details = completeDetails({ ...EMPTY_PRODUCT_DETAILS, ...value })
  const [highlightBlanks, setHighlightBlanks] = useState<string[]>([])
  const publish = mode === 'publish'
  const purchaseRequired = publish && details.purchaseNotes.trim() === ''
  const afterSalesRequired = publish && details.afterSalesInstructions.trim() === ''
  const canAddHighlight = !disabled && details.highlights.length + highlightBlanks.length < MAX_HIGHLIGHTS
  const canAddFaq = !disabled && details.faq.length < MAX_FAQ

  function patch(partial: Partial<ProductDetails>) {
    onChange(completeDetails({ ...details, ...partial }))
  }

  const usageId = `${idPrefix}-usage`
  const purchaseId = `${idPrefix}-purchase`
  const afterSalesId = `${idPrefix}-after-sales`

  return (
    <div className="space-y-4" data-testid="product-details-fields" data-mode={mode}>
      <div data-testid="product-details-highlights">
        <p className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">亮点</p>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">最多 {MAX_HIGHLIGHTS} 项，每项不超过 {MAX_HIGHLIGHT_LENGTH} 字。</p>
        <div className="space-y-2">
          {details.highlights.map((item, index) => (
            <div key={`highlight-${index}`} className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1 min-h-[44px]"
                value={item}
                maxLength={MAX_HIGHLIGHT_LENGTH}
                disabled={disabled}
                aria-label={`亮点 ${index + 1}`}
                data-testid={`product-details-highlight-${index}`}
                onChange={(event) => {
                  const next = details.highlights.slice()
                  next[index] = event.target.value
                  patch({ highlights: next.filter((row) => row.length > 0) })
                }}
              />
              <button
                type="button"
                className="min-h-[44px] min-w-[44px] p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer disabled:opacity-50"
                disabled={disabled}
                aria-label={`删除亮点 ${index + 1}`}
                data-testid={`product-details-highlight-remove-${index}`}
                onClick={() => patch({ highlights: details.highlights.filter((_, itemIndex) => itemIndex !== index) })}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {highlightBlanks.map((blank, index) => (
            <div key={`highlight-blank-${index}`} className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1 min-h-[44px]"
                value={blank}
                maxLength={MAX_HIGHLIGHT_LENGTH}
                disabled={disabled}
                aria-label={`亮点新项 ${index + 1}`}
                data-testid={`product-details-highlight-blank-${index}`}
                onChange={(event) => {
                  const text = event.target.value
                  if (text.length > 0) {
                    patch({ highlights: [...details.highlights, text] })
                    setHighlightBlanks((current) => current.filter((_, blankIndex) => blankIndex !== index))
                    return
                  }
                  setHighlightBlanks((current) => current.map((row, blankIndex) => (blankIndex === index ? text : row)))
                }}
              />
              <button
                type="button"
                className="min-h-[44px] min-w-[44px] p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer disabled:opacity-50"
                disabled={disabled}
                aria-label={`删除亮点新项 ${index + 1}`}
                onClick={() => setHighlightBlanks((current) => current.filter((_, blankIndex) => blankIndex !== index))}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary min-h-[44px] px-3"
            disabled={!canAddHighlight}
            data-testid="product-details-highlight-add"
            onClick={() => setHighlightBlanks((current) => [...current, ''])}
          >
            <Plus className="w-4 h-4" /> 添加亮点
          </button>
        </div>
      </div>

      <div>
        <label htmlFor={usageId} className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">
          使用说明
        </label>
        <textarea
          id={usageId}
          className="input min-h-[88px] resize-y"
          value={details.usageInstructions}
          maxLength={MAX_USAGE_INSTRUCTIONS}
          disabled={disabled}
          data-testid="product-details-usageInstructions"
          onChange={(event) => patch({ usageInstructions: event.target.value })}
        />
      </div>

      <div>
        <label htmlFor={purchaseId} className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">
          购买须知
          {publish ? <span className="text-[var(--color-danger)]"> *</span> : null}
        </label>
        <textarea
          id={purchaseId}
          className="input min-h-[88px] resize-y"
          value={details.purchaseNotes}
          maxLength={MAX_PURCHASE_NOTES}
          disabled={disabled}
          aria-required={publish || undefined}
          data-testid="product-details-purchaseNotes"
          onChange={(event) => patch({ purchaseNotes: event.target.value })}
        />
        {purchaseRequired ? (
          <p className="text-xs text-[var(--color-danger)] mt-1" data-testid="product-details-purchaseNotes-required-hint">
            首次发布必填
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={afterSalesId} className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">
          售后说明
          {publish ? <span className="text-[var(--color-danger)]"> *</span> : null}
        </label>
        <textarea
          id={afterSalesId}
          className="input min-h-[88px] resize-y"
          value={details.afterSalesInstructions}
          maxLength={MAX_AFTER_SALES}
          disabled={disabled}
          aria-required={publish || undefined}
          data-testid="product-details-afterSalesInstructions"
          onChange={(event) => patch({ afterSalesInstructions: event.target.value })}
        />
        {afterSalesRequired ? (
          <p className="text-xs text-[var(--color-danger)] mt-1" data-testid="product-details-afterSalesInstructions-required-hint">
            首次发布必填
          </p>
        ) : null}
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          售后处理以订单及平台规则为准。商家说明不能覆盖平台既有退款与争议规则。
        </p>
      </div>

      <div data-testid="product-details-faq">
        <p className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">常见问题</p>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">最多 {MAX_FAQ} 项。</p>
        <div className="space-y-3">
          {details.faq.map((item, index) => (
            <div
              key={`faq-${index}`}
              className="rounded-lg border border-[var(--color-border)] p-4 space-y-3"
              data-testid={`product-details-faq-${index}`}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <input
                    type="text"
                    className="input min-h-[44px]"
                    value={item.question}
                    maxLength={MAX_FAQ_QUESTION}
                    disabled={disabled}
                    placeholder="问题"
                    aria-label={`FAQ 问题 ${index + 1}`}
                    data-testid={`product-details-faq-question-${index}`}
                    onChange={(event) => {
                      const next = details.faq.map((entry, faqIndex) =>
                        faqIndex === index ? { ...entry, question: event.target.value } : entry,
                      )
                      patch({ faq: next })
                    }}
                  />
                  <textarea
                    className="input min-h-[88px] resize-y"
                    value={item.answer}
                    maxLength={MAX_FAQ_ANSWER}
                    disabled={disabled}
                    placeholder="回答"
                    aria-label={`FAQ 回答 ${index + 1}`}
                    data-testid={`product-details-faq-answer-${index}`}
                    onChange={(event) => {
                      const next = details.faq.map((entry, faqIndex) =>
                        faqIndex === index ? { ...entry, answer: event.target.value } : entry,
                      )
                      patch({ faq: next })
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="min-h-[44px] min-w-[44px] p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer disabled:opacity-50"
                  disabled={disabled}
                  aria-label={`删除 FAQ ${index + 1}`}
                  data-testid={`product-details-faq-remove-${index}`}
                  onClick={() => patch({ faq: details.faq.filter((_, faqIndex) => faqIndex !== index) })}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary min-h-[44px] px-3"
            disabled={!canAddFaq}
            data-testid="product-details-faq-add"
            onClick={() => patch({ faq: [...details.faq, { question: '', answer: '' }] })}
          >
            <Plus className="w-4 h-4" /> 添加问题
          </button>
        </div>
      </div>
    </div>
  )
}
