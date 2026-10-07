import { Check, Package } from 'lucide-react'
import type { ProductDraftSuggestion } from '../../api/productDraftAssistant'
import type { ProductTemplateDefinition } from '../../types/catalog'
import { attributeLabel, displayAttribute } from './productDraftReview'

type Props = {
  proposal: ProductDraftSuggestion
  template: ProductTemplateDefinition | null
  category?: string
  price: string
  delivery: string
  validity: string
  expanded?: boolean
}

export default function ProductDraftPreview({ proposal, template, category, price, delivery, validity, expanded = false }: Props) {
  const content = <div className="flex flex-col gap-4 text-sm">
    {(['attributes', 'offerAttributes'] as const).map(target => Object.keys(proposal[target]).length > 0 && <div key={target}>
      <h4 className="mb-2 font-semibold">{target === 'attributes' ? '商品参数' : '规格参数'}</h4>
      <dl className="flex flex-col gap-2">
        {Object.entries(proposal[target]).map(([key, value]) => <div key={key} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="text-[var(--color-text-muted)]">{attributeLabel(template, target === 'attributes' ? 'product' : 'offer', key)}</dt>
          <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{displayAttribute(template, key, value)}</dd>
        </div>)}
      </dl>
    </div>)}
    {([
      ['使用说明', proposal.details.usageInstructions], ['购买须知', proposal.details.purchaseNotes], ['售后说明', proposal.details.afterSalesInstructions],
    ] as const).map(([label, value]) => <div key={label}><h4 className="mb-1 font-semibold">{label}</h4>
      <p className="whitespace-pre-wrap break-words text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{value || '待补充'}</p></div>)}
    {proposal.details.faq.map((item, index) => <div key={index} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      <h4 className="font-semibold">{item.question}</h4><p className="mt-1 text-[var(--color-text-muted)]">{item.answer}</p>
    </div>)}
  </div>
  return <aside aria-label="商品草稿预览" className="min-w-0 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-muted)]">
      <span className="font-semibold">商品预览</span><span>草稿 · 尚未发布</span>
    </div>
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[var(--color-background)] text-[var(--color-primary)]"><Package className="size-6" aria-hidden="true" /></div>
        <div className="min-w-0"><p className="text-xs text-[var(--color-text-muted)]">{category ?? '分类待选择'} · {template?.label ?? '形态待选择'}</p>
          <h3 className="mt-1 break-words text-lg font-bold [overflow-wrap:anywhere]">{proposal.name || '为你的商品起个名字'}</h3></div>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{proposal.description || '商品简介待补充'}</p>
      {proposal.details.highlights.length > 0 && <ul className="flex flex-col gap-2 text-sm">{proposal.details.highlights.map((item, index) => <li key={index} className="flex items-start gap-2">
        <Check className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" /><span className="break-words [overflow-wrap:anywhere]">{item}</span>
      </li>)}</ul>}
      <div className="rounded-xl bg-[var(--color-background)] p-4">
        <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{proposal.offerName || '默认规格'}</p>
        <p className="mt-2 text-2xl font-bold text-[var(--color-primary)]">{price || '售价待填写'}{price && <span className="ml-1 text-xs font-normal">积分</span>}</p>
        <dl className="mt-4 flex flex-col gap-2 text-xs">
          <div className="flex justify-between gap-3"><dt className="shrink-0 text-[var(--color-text-muted)]">交付方式</dt><dd className="text-right">{delivery || '待确认'}</dd></div>
          <div className="flex justify-between gap-3"><dt className="shrink-0 text-[var(--color-text-muted)]">有效期</dt><dd>{validity || '待确认'}</dd></div>
        </dl>
      </div>
      {expanded ? content : <details><summary className="min-h-8 cursor-pointer text-sm font-semibold">参数与详细说明</summary><div className="mt-3">{content}</div></details>}
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">封面与交付内容可在保存草稿后补充。</p>
    </div>
  </aside>
}
