import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, FileText, Loader2, Package, Sparkles } from 'lucide-react'
import { buildCreateProductV2Request, type CreateProductV2Request, type CreateProductV2Result, type ProductEditorActor } from '../../api/catalog'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { getDraftAssistantAvailability, requestProductDraftSuggestion, type ProductDraftSuggestion, type ProductDraftSuggestionResponse } from '../../api/productDraftAssistant'
import type { CategoryRegistryItem, FulfillmentConfiguration, ProductTemplateDefinition, TemplateAttributes, TemplateKey } from '../../types/catalog'
import ProductDetailsFields from './ProductDetailsFields'
import TemplateAttributeFields from './TemplateAttributeFields'
import ProductDraftPreview from './ProductDraftPreview'
import ProductDraftDiff from './ProductDraftDiff'
import { draftIntroductionHtml, getDraftChanges } from './productDraftReview'

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

type EditorGroup = 'info' | 'commerce' | 'details'

const EXAMPLES = [
  { label: '学习资料', text: '网络入门学习指南，内容类型是学习指引，适合入门学习，包含连接基础说明和常见问题排查步骤。标准版包含完整文字指引。' },
  { label: '数字文件', text: '旅行手账模板，PDF 格式，适用于个人旅行规划，包含行程记录与行李清单。标准版提供中文版本。' },
  { label: '人工服务', text: '简历排版服务，服务内容为整理客户提供的简历文字和版式。适用于求职准备，基础版包含单份简历排版。' },
]

/** Proposals, edits and follow-up comparisons remain local until a human saves. */
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
  const [pending, setPending] = useState<ProductDraftSuggestionResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stage, setStage] = useState<'edit' | 'review'>('edit')
  const [group, setGroup] = useState<EditorGroup>('commerce')
  const heading = useRef<HTMLHeadingElement>(null)
  const [busy, setBusy] = useState<'generate' | 'create' | null>(null)
  const [failure, setFailure] = useState('')
  const errorMessage = useRef<HTMLParagraphElement>(null)
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
  useEffect(() => { if (failure) errorMessage.current?.focus() }, [failure])

  const template = useMemo(() => templates.find(item => item.key === proposal?.templateKey) ?? null, [templates, proposal?.templateKey])
  const choices = deliveryChoices(template, proposal?.attributes ?? {})
  const stale = proposal !== null && proposalSource.current !== source.trim()
  const changes = useMemo(() => proposal && pending ? getDraftChanges(proposal, pending.suggestion, templates, categories) : [], [proposal, pending, templates, categories])
  const numericPrice = Number(price)
  const validPrice = Number.isInteger(numericPrice) && numericPrice >= 1 && numericPrice <= 2_000_000_000
  const validDays = Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650
  const validValidity = validityMode === 'none' || (validityMode === 'days' && validDays)
  const validDelivery = delivery !== '' && choices.includes(delivery)
  const basicMissing = [!proposal?.name?.trim() && '商品名称', !template && '商品形态', !categories.some(item => item.id === proposal?.categoryId) && '商品分类'].filter(Boolean) as string[]
  const commerceMissing = [!validPrice && '售价', !validDelivery && '交付方式', !validValidity && '有效期'].filter(Boolean) as string[]
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
    if (lock.current || !source.trim() || quotaExhausted || pending) return
    lock.current = true
    const controller = new AbortController()
    request.current = controller
    setBusy('generate')
    setFailure('')
    const submitted = source.trim()
    try {
      const next = await requestProductDraftSuggestion(actor, submitted, controller.signal)
      if (!mounted.current || request.current !== controller || controller.signal.aborted) return
      if (proposal) {
        setPending(next)
        setSelected(new Set())
      } else {
        proposalSource.current = submitted
        setResult(next)
        setProposal(next.suggestion)
        setGroup(next.suggestion.name && next.suggestion.templateKey && next.suggestion.categoryId ? 'commerce' : 'info')
      }
      setSourceExpanded(false)
      setConfirmed(false)
      setStage('edit')
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
    setFailure('')
  }

  function discardFollowUp() {
    setSource(proposalSource.current)
    setPending(null)
    setSourceExpanded(false)
    setFailure('')
    setConfirmed(false)
  }

  function applyFollowUp() {
    if (!proposal || !pending) return
    const next = changes.filter(item => selected.has(item.key)).reduce((value, item) => item.apply(value), proposal)
    const nextTemplate = templates.find(item => item.key === next.templateKey) ?? null
    if (delivery && !deliveryChoices(nextTemplate, next.attributes).includes(delivery)) setDelivery('')
    setProposal(next)
    setResult(pending)
    proposalSource.current = source.trim()
    setPending(null)
    setSourceExpanded(false)
    setConfirmed(false)
    setFailure('')
  }

  function openGroup(next: EditorGroup) {
    setGroup(next)
    requestAnimationFrame(() => document.getElementById(`${id}-${next}`)?.focus())
  }

  function validateSettings(): string | null {
    if (basicMissing.length) { setGroup('info'); return '请补充商品名称、形态和分类' }
    setGroup('commerce')
    if (!validPrice) return '请填写大于 0 且不超过 20 亿的整数积分售价'
    if (!validDelivery) return '请选择交付方式'
    if (!validValidity) return '请确认有效期：填写 1–3650 天，或选择无固定有效期'
    return null
  }

  function review() {
    if (busy || stale || pending) return
    const error = validateSettings()
    setFailure(error ?? '')
    if (!error) { setStage('review'); setSourceExpanded(false); setConfirmed(false); requestAnimationFrame(() => heading.current?.focus()) }
  }

  async function saveDraft() {
    if (lock.current || !proposal || stale || pending || stage !== 'review') return
    if (!confirmed) { setFailure('请先核对并确认预填内容'); return }
    const error = validateSettings()
    if (error || !template || !delivery || !proposal.name) { setFailure(error ?? '请检查商品信息'); setStage('edit'); return }
    const validityDays = validityMode === 'days' ? Number(days) : null
    const selectedDelivery = DELIVERY_CHOICES[delivery]
    const payload = buildCreateProductV2Request({
      templateKey: template.key, name: proposal.name.trim(), categoryId: proposal.categoryId!,
      description: proposal.description ?? '', richDescription: draftIntroductionHtml(proposal.introduction),
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
  const blocked = busy !== null || pending !== null
  const currentStep = !proposal ? 0 : stage === 'edit' ? 1 : 2
  const preview = proposal && <ProductDraftPreview proposal={proposal} template={template}
    category={categories.find(item => item.id === proposal.categoryId)?.label}
    price={validPrice ? numericPrice.toLocaleString() : ''}
    delivery={validDelivery ? DELIVERY_CHOICES[delivery as DeliveryChoice].label : ''}
    validity={validValidity ? validityMode === 'none' ? '无固定有效期' : `${Number(days)} 天` : ''}
    expanded={stage === 'review'} />
  const groupTitle = (key: EditorGroup, title: string, summary: string) => <button type="button"
    id={`${id}-${key}`} aria-expanded={group === key} aria-controls={`${id}-${key}-fields`}
    className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left" disabled={blocked} onClick={() => setGroup(key)}>
    <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{title}</span><span className="mt-1 block break-words text-xs text-[var(--color-text-muted)] [overflow-wrap:anywhere]">{summary}</span></span>
    <ChevronDown className={`size-4 shrink-0 ${group === key ? 'rotate-180' : ''}`} aria-hidden="true" />
  </button>
  return (
    <section className={`mb-4 rounded-2xl border border-[var(--color-border)] ${active ? 'bg-[var(--color-background)]' : 'bg-[var(--color-surface)]'}`} aria-label="AI 辅助新建商品">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)] text-white"><Sparkles className="size-5" aria-hidden="true" /></span>
          <div><h2 className="font-bold">AI 帮我建商品</h2><p className="mt-1 text-xs text-[var(--color-text-muted)]">你介绍商品，AI 整理信息，确认满意后再保存。</p></div>
        </div>
        <button type="button" className="btn-secondary min-h-11" disabled={disabled || busy === 'create'} onClick={() => changeActive(!active)}>
          {active ? '切回手动填写' : '开始 AI 辅助创建'}
        </button>
      </div>
      {active && <div className="flex flex-col gap-5 px-4 pb-5 sm:px-5">
        <ol aria-label="创建进度" className="grid grid-cols-3 gap-2 border-t border-[var(--color-border)] pt-4">
          {['描述商品', '预览与补充', '确认草稿'].map((label, index) => <li key={label} aria-current={currentStep === index ? 'step' : undefined}
            className={`flex items-center gap-2 text-xs ${currentStep === index ? 'font-bold text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'}`}>
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${currentStep >= index ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)]'}`}>
              {currentStep > index ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}</span>{label}
          </li>)}
        </ol>
        {!proposal && <div className="pt-2"><h3 className="text-xl font-bold sm:text-2xl">从一句介绍开始</h3>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">卖什么、适合谁、包含哪些内容？把已有介绍粘贴过来，也可以从下面的例子开始。</p>
          {!source && <div className="mt-4 flex flex-wrap gap-2">{EXAMPLES.map(item => <button key={item.label} type="button" className="btn-secondary min-h-11 text-sm" disabled={blocked} onClick={() => setSource(item.text)}><FileText className="size-4" aria-hidden="true" />试试{item.label}</button>)}</div>}
        </div>}
        {proposal && stage === 'edit' && !pending && !sourceExpanded && <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 ref={heading} tabIndex={-1} className="font-bold outline-none">先看看商品，再补充关键设置</h3><p className="mt-1 text-xs text-[var(--color-text-muted)]">AI 已整理参数并扩写文案，请核对服务范围与表达，所有字段都可以修改。</p></div>
          <button type="button" className="btn-secondary min-h-11 text-sm" disabled={busy !== null} onClick={() => setSourceExpanded(true)}>补充介绍，让 AI 再整理</button>
        </div>}
        {(!proposal || sourceExpanded) && !pending && <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-center justify-between gap-2"><label htmlFor={`${id}-source`} className="text-sm font-semibold">{proposal ? '补充或修改公开商品介绍' : '1. 描述你的商品'}</label><span className="text-xs tabular-nums text-[var(--color-text-muted)]">{source.length}/4000</span></div>
          {proposal && <p className="text-xs text-[var(--color-text-muted)]">补充事实后再整理，结果会先逐项对比。当前商品内容和交易设置会保留到你确认采纳。</p>}
          <textarea id={`${id}-source`} className="input min-h-36 resize-y" maxLength={4000} value={source} disabled={busy !== null}
            placeholder="例如：我想卖一份网络入门学习指南，适合刚接触网络的用户，包含连接基础说明和常见问题排查步骤。"
            onChange={event => { setSource(event.target.value); setConfirmed(false) }} />
          <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">只填写可公开的介绍，请勿填写账号、密码、卡密或实际交付内容。与 AI 说明整理共用每日额度，每次整理消耗一次。</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary min-h-11" disabled={busy !== null || !source.trim() || quotaExhausted || templates.length === 0 || categories.length === 0} onClick={() => void generate()}>
              {busy === 'generate' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
              {busy === 'generate' ? '正在整理商品信息…' : proposal ? '整理并对比修改（消耗一次）' : '生成预填内容'}
            </button>
            {proposal && <button type="button" className="btn-secondary min-h-11" disabled={busy !== null} onClick={discardFollowUp}>取消本次介绍修改</button>}
          </div>
          {busy === 'generate' && <p role="status" className="text-sm text-[var(--color-text-muted)]">正在根据介绍整理商品信息，完成后会展示供你核对。</p>}
        </div>}
        {failure && <p ref={errorMessage} tabIndex={-1} role="alert" className="text-sm text-[var(--color-danger)] outline-none">{failure}</p>}
        {pending && <ProductDraftDiff changes={changes} selected={selected} onSelect={(key, checked) => setSelected(current => {
          const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next
        })} onApply={applyFollowUp} onDiscard={discardFollowUp} />}
        {proposal && <>
          {(pending ?? result)?.rejectedFieldCount ? <p className="text-xs text-[var(--color-text-muted)]">部分内容已过滤或恢复为完整原句，请核对生成结果是否符合实际。</p> : null}
          {(pending ?? result)?.truncated && <p className="text-xs text-[var(--color-text-muted)]">本次只参考了部分介绍，请核对是否有遗漏。</p>}
          {stale && !pending && <p className="text-sm text-[var(--color-text-muted)]">介绍已修改，请整理并核对差异，或取消本次介绍修改后继续。</p>}
          {stage === 'edit' ? <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <h4 className="flex items-center gap-2 text-sm font-bold">{basicMissing.length + commerceMissing.length ? <><span className="text-[var(--color-primary)]">还需确认 {basicMissing.length + commerceMissing.length} 项</span><span className="text-xs font-normal text-[var(--color-text-muted)]">即可保存草稿</span></> : <><Check className="size-4 text-[var(--color-primary)]" aria-hidden="true" />可以进入草稿确认</>}</h4>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {[...basicMissing.map(label => ({ label, group: 'info' as const })), ...commerceMissing.map(label => ({ label, group: 'commerce' as const }))].map(item => <button key={item.label} type="button" className="min-h-9 text-sm text-[var(--color-primary)] underline underline-offset-4" disabled={blocked} onClick={() => openGroup(item.group)}>{item.label}</button>)}
                </div>
                <button type="button" className="min-h-9 text-sm text-[var(--color-primary)] underline underline-offset-4 lg:hidden" onClick={() => document.getElementById(`${id}-preview`)?.focus()}>查看商品预览 ↓</button>
                {missingFields.filter(item => !basicMissing.includes(item)).length > 0 && <button type="button" className="mt-1 text-left text-xs leading-relaxed text-[var(--color-text-muted)] underline underline-offset-4" disabled={blocked} onClick={() => openGroup('info')}>
                  发布前还需补充参数：{missingFields.filter(item => !basicMissing.includes(item)).join('、')}</button>}
              </div>
              <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div>
                  {groupTitle('info', '商品信息', basicMissing.length ? `待补充：${basicMissing.join('、')}` : `${proposal.name} · 可修改形态、分类和参数`)}
                  <div id={`${id}-info-fields`} hidden={group !== 'info'} className="space-y-4 px-4 pb-4">
                    <div><label htmlFor={`${id}-name`} className="mb-1 block text-sm font-semibold">商品名称 *</label>
                      <input id={`${id}-name`} className="input" maxLength={120} value={proposal.name ?? ''} disabled={blocked} onChange={event => patch({ name: event.target.value })} /></div>
                    <div><label htmlFor={`${id}-template`} className="mb-1 block text-sm font-semibold">商品形态（AI 建议，请核对）*</label>
                      <select id={`${id}-template`} className="input" value={proposal.templateKey ?? ''} disabled={blocked} onChange={event => {
                        patch({ templateKey: event.target.value as TemplateKey || null, attributes: {}, offerAttributes: {} }); setDelivery('')
                      }}><option value="">请选择商品形态</option>{templates.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
                    <div><label htmlFor={`${id}-category`} className="mb-1 block text-sm font-semibold">商品分类（AI 建议，请核对）*</label>
                      <select id={`${id}-category`} className="input" value={proposal.categoryId ?? ''} disabled={blocked} onChange={event => patch({ categoryId: event.target.value ? Number(event.target.value) : null })}>
                        <option value="">请选择商品分类</option>{categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
                    <div><label htmlFor={`${id}-description`} className="mb-1 block text-sm font-semibold">商品简介</label>
                      <textarea id={`${id}-description`} className="input min-h-24" maxLength={2000} value={proposal.description ?? ''} disabled={blocked} onChange={event => patch({ description: event.target.value })} />
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">短简介用于概括商品，完整介绍在「详细说明」中查看和修改。</p></div>
                    {template && <TemplateAttributeFields key={`${template.key}-product`} template={template} target="product" value={proposal.attributes} onChange={attributes => {
                      patch({ attributes }); if (delivery && !deliveryChoices(template, attributes).includes(delivery)) setDelivery('')
                    }} disabled={blocked} mode="draft" />}
                    <div><label htmlFor={`${id}-offer`} className="mb-1 block text-sm font-semibold">主规格名称</label>
                      <input id={`${id}-offer`} className="input" maxLength={50} placeholder="默认规格" value={proposal.offerName ?? ''} disabled={blocked} onChange={event => patch({ offerName: event.target.value })} /></div>
                    {template && <TemplateAttributeFields key={`${template.key}-offer`} template={template} target="offer" value={proposal.offerAttributes} onChange={offerAttributes => patch({ offerAttributes })} disabled={blocked} mode="draft" />}
                  </div>
                </div>
                <div>
                  {groupTitle('commerce', '交易设置', commerceMissing.length ? '确认卖多少钱、如何交付、有效多久' : `${numericPrice.toLocaleString()} 积分 · 交付与有效期已选择`)}
                  <div id={`${id}-commerce-fields`} hidden={group !== 'commerce'} className="space-y-4 px-4 pb-4">
                    <div><label htmlFor={`${id}-price`} className="mb-1 block text-sm font-semibold">售价（积分，由你填写）*</label>
                      <input id={`${id}-price`} type="number" min={1} max={2_000_000_000} step={1} className="input" placeholder="这件商品卖多少积分？" value={price} disabled={blocked} onChange={event => { setPrice(event.target.value); setConfirmed(false); setFailure('') }} /></div>
                    <div><label htmlFor={`${id}-delivery`} className="mb-1 block text-sm font-semibold">交付方式（由你确认）*</label>
                      <select id={`${id}-delivery`} className="input" value={validDelivery ? delivery : ''} disabled={blocked} onChange={event => { setDelivery(event.target.value as DeliveryChoice); setConfirmed(false); setFailure('') }}>
                        <option value="">顾客购买后，如何拿到商品？</option>{choices.map(value => <option key={value} value={value}>{DELIVERY_CHOICES[value].label}</option>)}</select>
                      {!template && <p className="mt-1 text-xs text-[var(--color-text-muted)]">先选择商品形态，就能选择对应的交付方式。</p>}</div>
                    <div><label htmlFor={`${id}-validity`} className="mb-1 block text-sm font-semibold">有效期（由你确认）*</label>
                      <select id={`${id}-validity`} className="input" value={validityMode} disabled={blocked} onChange={event => { setValidityMode(event.target.value as typeof validityMode); setConfirmed(false); setFailure('') }}>
                        <option value="">购买后有使用期限吗？</option><option value="days">有固定天数</option><option value="none">无固定有效期</option></select>
                      {validityMode === 'days' && <input aria-label="有效天数" type="number" min={1} max={3650} step={1} placeholder="1–3650 天" className="input mt-2" value={days} disabled={blocked} onChange={event => { setDays(event.target.value); setConfirmed(false); setFailure('') }} />}</div>
                    <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">这里先确认交付方式，实际交付内容、文件或卡密在草稿中配置。</p>
                  </div>
                </div>
                <div>
                  {groupTitle('details', '详细说明', proposal.introduction ? `已生成详细商品介绍 · ${proposal.introduction.length} 字，可编辑` : '详细商品介绍、亮点、使用说明与购买须知')}
                  <div id={`${id}-details-fields`} hidden={group !== 'details'} className="space-y-4 px-4 pb-4">
                    <div><label htmlFor={`${id}-introduction`} className="mb-1 block text-sm font-semibold">详细商品介绍</label>
                      <textarea id={`${id}-introduction`} className="input min-h-72" maxLength={6000} value={proposal.introduction ?? ''} disabled={blocked} onChange={event => patch({ introduction: event.target.value })} />
                      <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">保存后会进入商品详情页的介绍区。想让文案更具体，可以补充服务范围、交付成果和适用场景，再让 AI 整理。</p></div>
                    <ProductDetailsFields value={proposal.details} onChange={details => patch({ details })} disabled={blocked} mode="draft" />
                  </div>
                </div>
              </div>
              <button type="button" className="btn-primary min-h-11 w-full" disabled={blocked || stale} onClick={review}>下一步：确认草稿<ArrowRight className="size-4" aria-hidden="true" /></button>
            </div>
            <div id={`${id}-preview`} tabIndex={-1} className="min-w-0 outline-none lg:sticky lg:top-0">{preview}
              <button type="button" className="btn-secondary mt-3 min-h-11 w-full lg:hidden" disabled={blocked} onClick={() => openGroup(group)}>返回补充信息 ↑</button>
            </div>
          </div> : <div className="flex flex-col gap-4">
            <h3 ref={heading} tabIndex={-1} className="text-lg font-bold outline-none">确认后，这就是你的商品草稿</h3>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              {preview}
              <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                <h4 className="flex items-center gap-2 font-semibold"><Package className="size-4" aria-hidden="true" />保存后继续完善</h4>
                <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-[var(--color-text-muted)]"><li>上传商品封面，按需添加更多规格</li><li>配置实际交付内容或导入库存</li><li>补齐购买须知、售后与必填参数</li><li>通过发布检查后上架</li></ul>
                <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">本次创建一个主规格，默认仅登录可浏览、可售量为 0。保存草稿不会自动上架。</p>
                <label className="flex items-start gap-2 text-sm leading-relaxed"><input type="checkbox" className="mt-1" checked={confirmed} disabled={busy !== null || stale || pending !== null} onChange={event => setConfirmed(event.target.checked)} />我已核对商品形态、分类、参数和交易设置，确认保存为草稿</label>
                <button type="button" className="btn-primary min-h-11" disabled={busy !== null || stale || pending !== null || !confirmed} onClick={() => void saveDraft()}>{busy === 'create' ? '正在创建草稿…' : '确认并创建草稿'}</button>
                <button type="button" className="btn-secondary min-h-11" disabled={busy !== null} onClick={() => { setStage('edit'); setConfirmed(false); setFailure(''); requestAnimationFrame(() => heading.current?.focus()) }}>返回调整</button>
              </div>
            </div>
          </div>}
        </>}
      </div>}
    </section>
  )
}
