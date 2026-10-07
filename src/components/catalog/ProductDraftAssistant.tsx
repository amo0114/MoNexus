import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { buildCreateProductV2Request, type CreateProductV2Request, type CreateProductV2Result, type ProductEditorActor } from '../../api/catalog'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { getDraftAssistantAvailability, requestProductDraftSuggestion, type ProductDraftSuggestion, type ProductDraftSuggestionResponse } from '../../api/productDraftAssistant'
import type { CategoryRegistryItem, FulfillmentConfiguration, ProductTemplateDefinition, TemplateAttributes, TemplateKey } from '../../types/catalog'
import ProductDetailsFields from './ProductDetailsFields'
import TemplateAttributeFields from './TemplateAttributeFields'

type Props = {
  actor: ProductEditorActor
  templates: ProductTemplateDefinition[]
  categories: CategoryRegistryItem[]
  createDraft: (payload: CreateProductV2Request) => Promise<CreateProductV2Result>
  onCreated: (id: number) => void
  onActiveChange: (active: boolean) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
}

const DELIVERY_CHOICES = {
  inventory: { label: '库存卡密或账号（稍后导入）', deliveryMode: 'instant_inventory', fixedContentType: 'text' },
  fixed_text: { label: '固定文本（稍后填写交付内容）', deliveryMode: 'instant_fixed', fixedContentType: 'text' },
  fixed_url: { label: '固定链接（稍后填写交付内容）', deliveryMode: 'instant_fixed', fixedContentType: 'url' },
  fixed_file: { label: '数字文件（稍后上传）', deliveryMode: 'instant_fixed', fixedContentType: 'file' },
  manual: { label: '人工处理', deliveryMode: 'manual_service', fixedContentType: 'text' },
} as const
type DeliveryChoice = keyof typeof DELIVERY_CHOICES

function deliveryChoices(template: ProductTemplateDefinition | null, attributes: TemplateAttributes): DeliveryChoice[] {
  if (!template) return []
  const rule = template.fulfillmentRules.find(item => Object.entries(item.whenProductAttributes).every(([key, value]) => attributes[key] === value))
  const allowed: FulfillmentConfiguration[] = rule?.configurations ?? template.fulfillmentRules.flatMap(item => item.configurations)
  return [...new Set(allowed)].filter((value): value is DeliveryChoice => Object.prototype.hasOwnProperty.call(DELIVERY_CHOICES, value))
}

/** Two-step creation. Suggestions stay editable until the ordinary create request. */
export default function ProductDraftAssistant({ actor, templates, categories, createDraft, onCreated, onActiveChange, onBusyChange, disabled = false }: Props) {
  const id = useId()
  const [available, setAvailable] = useState(false)
  const [active, setActive] = useState(false)
  const [source, setSource] = useState('')
  const [sourceExpanded, setSourceExpanded] = useState(true)
  const [result, setResult] = useState<ProductDraftSuggestionResponse | null>(null)
  const [proposal, setProposal] = useState<ProductDraftSuggestion | null>(null)
  const [price, setPrice] = useState('')
  const [validityMode, setValidityMode] = useState<'' | 'days' | 'none'>('')
  const [days, setDays] = useState('')
  const [delivery, setDelivery] = useState<DeliveryChoice | ''>('')
  const [confirmed, setConfirmed] = useState(false)
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'create' | null>(null)
  const [failure, setFailure] = useState('')
  const [quotaExhausted, setQuotaExhausted] = useState(false)
  const lock = useRef(false)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const proposalSource = useRef('')

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    getDraftAssistantAvailability(actor).then(value => { if (!cancelled) setAvailable(value) }).catch(() => {})
    return () => { cancelled = true; mounted.current = false; request.current?.abort() }
  }, [actor])
  useEffect(() => { onBusyChange?.(busy !== null) }, [busy, onBusyChange])

  const template = useMemo(() => templates.find(item => item.key === proposal?.templateKey) ?? null, [templates, proposal?.templateKey])
  const choices = deliveryChoices(template, proposal?.attributes ?? {})
  const stale = proposal !== null && proposalSource.current !== source.trim()
  const missingFields = useMemo(() => {
    if (!proposal) return []
    const missing: string[] = []
    if (!template) missing.push('商品形态')
    if (!categories.some(item => item.id === proposal.categoryId)) missing.push('商品分类')
    if (!proposal.name?.trim()) missing.push('商品名称')
    if (template) {
      for (const [schema, values] of [[template.productSchema, proposal.attributes], [template.offerSchema, proposal.offerAttributes]] as const) {
        const properties = schema.properties as Record<string, { title?: string }>
        for (const key of (schema.required ?? []) as string[]) {
          const value = values[key]
          if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) missing.push(properties[key]?.title ?? key)
        }
      }
    }
    return missing
  }, [template, proposal, categories])

  function changeActive(next: boolean) {
    if (busy === 'create') return
    request.current?.abort()
    request.current = null
    lock.current = false
    setBusy(null)
    setActive(next)
    onActiveChange(next)
  }

  async function generate() {
    if (lock.current || !source.trim() || quotaExhausted || (proposal && !replaceConfirmed)) return
    lock.current = true
    const controller = new AbortController()
    request.current = controller
    setBusy('generate')
    setFailure('')
    const submitted = source.trim()
    try {
      const next = await requestProductDraftSuggestion(actor, submitted, controller.signal)
      if (!mounted.current || request.current !== controller || controller.signal.aborted) return
      proposalSource.current = submitted
      setResult(next)
      setProposal(next.suggestion)
      setSourceExpanded(false)
      setConfirmed(false)
      setReplaceConfirmed(false)
      setDelivery('')
    } catch (err) {
      if (!mounted.current || request.current !== controller || controller.signal.aborted) return
      setFailure(getApiErrorMessage(err, 'AI 暂时不可用，可以稍后重试或切回手动填写'))
      if (getApiErrorCode(err) === 'AI_QUOTA_EXCEEDED') setQuotaExhausted(true)
    } finally {
      if (mounted.current && request.current === controller) {
        lock.current = false
        setBusy(null)
      }
    }
  }

  function patch(changes: Partial<ProductDraftSuggestion>) {
    setProposal(current => current ? { ...current, ...changes } : current)
    setConfirmed(false)
  }

  async function saveDraft() {
    if (lock.current || !proposal || stale) return
    if (!confirmed) { setFailure('请先核对并确认预填内容'); return }
    if (!template || !proposal.name?.trim() || !categories.some(item => item.id === proposal.categoryId)) {
      setFailure('请补充商品名称、形态和分类'); return
    }
    const numericPrice = Number(price)
    if (!Number.isInteger(numericPrice) || numericPrice < 1 || numericPrice > 2_000_000_000) {
      setFailure('请填写大于 0 且不超过 20 亿的整数积分售价'); return
    }
    if (!delivery || !choices.includes(delivery)) { setFailure('请选择交付方式'); return }
    const validityDays = validityMode === 'days' ? Number(days) : null
    if (!validityMode || (validityDays !== null && (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650))) {
      setFailure('请确认有效期：填写 1–3650 天，或选择无固定有效期'); return
    }
    const selectedDelivery = DELIVERY_CHOICES[delivery]
    const payload = buildCreateProductV2Request({
      templateKey: template.key, name: proposal.name.trim(), categoryId: proposal.categoryId!,
      description: proposal.description ?? '', richDescription: null,
      images: [], imageKeys: {}, visibility: 'members_only',
      attributes: proposal.attributes, details: proposal.details,
      offers: [{
        name: proposal.offerName?.trim() || '默认规格', price: numericPrice, originalPrice: null,
        attributes: proposal.offerAttributes, deliveryMode: selectedDelivery.deliveryMode,
        fixedContentType: selectedDelivery.fixedContentType, stockMode: 'limited', validityDays,
        fixedContent: '', autoProvision: false,
      }],
    })
    lock.current = true
    setBusy('create')
    setFailure('')
    let created: CreateProductV2Result
    try {
      created = await createDraft(payload)
    } catch (err) {
      if (mounted.current) {
        lock.current = false
        setBusy(null)
        setFailure(getApiErrorMessage(err, '创建草稿失败，请检查填写内容后重试'))
      }
      return
    }
    if (mounted.current) onCreated(created.id)
  }

  if (!available && !active) return null
  return (
    <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5" aria-label="AI 辅助新建商品">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold"><Sparkles className="h-4 w-4 text-[var(--color-primary)]" />AI 帮我建商品</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">描述要卖什么，预填名称、形态、分类和参数，核对后保存草稿。</p>
        </div>
        <button type="button" className="btn-secondary min-h-11" disabled={disabled || busy === 'create'} onClick={() => changeActive(!active)}>
          {active ? '切回手动填写' : '开始 AI 辅助创建'}
        </button>
      </div>
      {active && <div className="mt-5 space-y-5">
        {proposal && !sourceExpanded && <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">商品介绍已整理，请核对下方内容。</span>
          <button type="button" className="btn-secondary min-h-11" disabled={busy !== null} onClick={() => setSourceExpanded(true)}>修改介绍或重新生成</button>
        </div>}
        <div className="space-y-4" hidden={proposal !== null && !sourceExpanded}>
        <div>
          <label htmlFor={`${id}-source`} className="mb-2 block text-sm font-semibold">1. 描述你的商品</label>
          <textarea id={`${id}-source`} className="input min-h-32" maxLength={4000} value={source} disabled={busy !== null}
            placeholder="例如：网络入门学习指南，内容类型是学习指引，适合入门学习，包含连接基础说明和常见问题排查步骤。标准版包含完整文字指引。"
            onChange={event => { setSource(event.target.value); setConfirmed(false) }} />
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">只填写可公开的介绍，请勿填写账号、密码、卡密或实际交付内容。与 AI 说明整理共用每日额度，每次生成消耗一次。</p>
        </div>
        {proposal && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={replaceConfirmed} disabled={busy !== null} onChange={event => setReplaceConfirmed(event.target.checked)} />
          重新生成会替换本次预填内容，我确认重新生成
        </label>}
        <button type="button" className="btn-primary min-h-11" disabled={busy !== null || !source.trim() || quotaExhausted || (proposal !== null && !replaceConfirmed) || templates.length === 0 || categories.length === 0}
          onClick={() => void generate()}>
          {busy === 'generate' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {busy === 'generate' ? '正在整理商品信息…' : proposal ? '重新生成（消耗一次）' : '生成预填内容'}
        </button>
        </div>
        {failure && (!proposal || sourceExpanded) && <p role="alert" className="text-sm text-[var(--color-danger)]">{failure}</p>}
        {proposal && <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
          <div>
            <h3 className="font-semibold">2. 核对并补充</h3>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">以下是从介绍中提取的候选内容，请确认含义和参数归属。未识别的信息留空，仍可手动修改。</p>
            {missingFields.length > 0 && <p className="mt-2 text-sm">尚待补充：{missingFields.join('、')}。参数可保存草稿后继续完善。</p>}
            {result && result.rejectedFieldCount > 0 && <p className="mt-2 text-sm">部分内容缺少原文依据或不符合字段要求，已留空。</p>}
            {result?.truncated && <p className="mt-2 text-sm">本次只参考了部分介绍，请核对是否有遗漏。</p>}
            {stale && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">介绍已修改，请重新生成后再创建。</p>}
          </div>
          <div>
            <label htmlFor={`${id}-name`} className="mb-1 block text-sm font-semibold">商品名称 *</label>
            <input id={`${id}-name`} className="input" maxLength={120} value={proposal.name ?? ''} disabled={busy !== null} onChange={event => patch({ name: event.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-template`} className="mb-1 block text-sm font-semibold">商品形态（AI 建议，请核对）*</label>
              <select id={`${id}-template`} className="input" value={proposal.templateKey ?? ''} disabled={busy !== null} onChange={event => {
                patch({ templateKey: event.target.value as TemplateKey || null, attributes: {}, offerAttributes: {} }); setDelivery('')
              }}>
                <option value="">请选择商品形态</option>
                {templates.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-category`} className="mb-1 block text-sm font-semibold">商品分类（AI 建议，请核对）*</label>
              <select id={`${id}-category`} className="input" value={proposal.categoryId ?? ''} disabled={busy !== null} onChange={event => patch({ categoryId: event.target.value ? Number(event.target.value) : null })}>
                <option value="">请选择商品分类</option>
                {categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-description`} className="mb-1 block text-sm font-semibold">商品简介</label>
            <textarea id={`${id}-description`} className="input min-h-20" maxLength={2000} value={proposal.description ?? ''} disabled={busy !== null} onChange={event => patch({ description: event.target.value })} />
          </div>
          {template && <TemplateAttributeFields template={template} target="product" value={proposal.attributes} onChange={attributes => { patch({ attributes }); setDelivery('') }} disabled={busy !== null} mode="draft" />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-offer`} className="mb-1 block text-sm font-semibold">主规格名称</label>
              <input id={`${id}-offer`} className="input" maxLength={50} placeholder="默认规格" value={proposal.offerName ?? ''} disabled={busy !== null} onChange={event => patch({ offerName: event.target.value })} />
            </div>
            <div>
              <label htmlFor={`${id}-price`} className="mb-1 block text-sm font-semibold">售价（积分，由你填写）*</label>
              <input id={`${id}-price`} type="number" min={1} max={2_000_000_000} step={1} className="input" value={price} disabled={busy !== null} onChange={event => { setPrice(event.target.value); setConfirmed(false) }} />
            </div>
          </div>
          {template && <TemplateAttributeFields template={template} target="offer" value={proposal.offerAttributes} onChange={offerAttributes => patch({ offerAttributes })} disabled={busy !== null} mode="draft" />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-delivery`} className="mb-1 block text-sm font-semibold">交付方式（由你确认）*</label>
              <select id={`${id}-delivery`} className="input" value={choices.includes(delivery as DeliveryChoice) ? delivery : ''} disabled={busy !== null} onChange={event => { setDelivery(event.target.value as DeliveryChoice); setConfirmed(false) }}>
                <option value="">请选择交付方式</option>
                {choices.map(value => <option key={value} value={value}>{DELIVERY_CHOICES[value].label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-validity`} className="mb-1 block text-sm font-semibold">有效期（由你确认）*</label>
              <select id={`${id}-validity`} className="input" value={validityMode} disabled={busy !== null} onChange={event => { setValidityMode(event.target.value as typeof validityMode); setConfirmed(false) }}>
                <option value="">请选择有效期</option><option value="days">有固定天数</option><option value="none">无固定有效期</option>
              </select>
              {validityMode === 'days' && <input aria-label="有效天数" type="number" min={1} max={3650} step={1} className="input mt-2" value={days} disabled={busy !== null} onChange={event => { setDays(event.target.value); setConfirmed(false) }} />}
            </div>
          </div>
          <details className="rounded-lg border border-[var(--color-border)] p-3">
            <summary className="cursor-pointer text-sm font-semibold">查看和编辑亮点、使用说明与购买须知</summary>
            <div className="mt-4"><ProductDetailsFields value={proposal.details} onChange={details => patch({ details })} disabled={busy !== null} mode="draft" /></div>
          </details>
          <p className="text-xs text-[var(--color-text-muted)]">将创建一个主规格，默认仅登录可浏览、可售量为 0。图片、更多规格、交付内容和库存可在草稿中继续补充，通过发布检查后才能上架。</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed} disabled={busy !== null || stale} onChange={event => setConfirmed(event.target.checked)} />
            我已核对商品形态、分类、参数和交易设置，确认保存为草稿
          </label>
          {failure && !sourceExpanded && <p role="alert" className="text-sm text-[var(--color-danger)]">{failure}</p>}
          <button type="button" className="btn-primary min-h-11" disabled={busy !== null || stale || !confirmed} onClick={() => void saveDraft()}>
            {busy === 'create' ? '正在创建草稿…' : '确认并创建草稿'}
          </button>
        </div>}
      </div>}
    </section>
  )
}
