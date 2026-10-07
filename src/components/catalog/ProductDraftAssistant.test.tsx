import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductDraftAssistant from './ProductDraftAssistant'
import * as api from '../../api/productDraftAssistant'
import { EMPTY_PRODUCT_DETAILS, type ProductTemplateDefinition } from '../../types/catalog'

vi.mock('../../api/productDraftAssistant', () => ({ getDraftAssistantAvailability: vi.fn(), requestProductDraftSuggestion: vi.fn() }))
const template: ProductTemplateDefinition = {
  key: 'fixed_content', version: 1, label: '固定数字内容',
  productSchema: { type: 'object', properties: { contentCategory: { type: 'string', title: '内容类型' } } },
  offerSchema: { type: 'object', properties: {} },
  ui: { productOrder: ['contentCategory'], offerOrder: [], widgets: { contentCategory: 'text' } },
  fulfillmentRules: [{ whenProductAttributes: {}, configurations: ['fixed_text', 'fixed_url'], requireStructuredDelivery: 'none', requireRequiredDateField: false }],
}
const response: api.ProductDraftSuggestionResponse = {
  generationId: 1, missingFields: [], rejectedFieldCount: 0, truncated: false,
  suggestion: { templateKey: 'fixed_content', categoryId: 1, name: '学习指南', description: '适合入门学习', offerName: null,
    attributes: { contentCategory: '学习指引' }, offerAttributes: {}, details: EMPTY_PRODUCT_DETAILS },
}
const createDraft = vi.fn()
const onCreated = vi.fn()
const onActiveChange = vi.fn()
function mount() {
  return render(<ProductDraftAssistant actor="admin" templates={[template]}
    categories={[{ id: 1, code: 'learning', label: '学习资料', iconKey: null, sortOrder: 0 }]}
    createDraft={createDraft} onCreated={onCreated} onActiveChange={onActiveChange} />)
}
async function open() {
  fireEvent.click(await screen.findByRole('button', { name: '开始 AI 辅助创建' }))
  fireEvent.change(screen.getByLabelText('1. 描述你的商品'), { target: { value: '学习指南，适合入门学习，内容类型为学习指引' } })
}
async function generate() {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '生成预填内容' }))
  await screen.findByLabelText('商品名称 *')
}
function fillCommerce() {
  fireEvent.change(screen.getByLabelText('售价（积分，由你填写）*'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('交付方式（由你确认）*'), { target: { value: 'fixed_text' } })
  fireEvent.change(screen.getByLabelText('有效期（由你确认）*'), { target: { value: 'none' } })
}
function confirm() { fireEvent.click(screen.getByLabelText('我已核对商品形态、分类、参数和交易设置，确认保存为草稿')) }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getDraftAssistantAvailability).mockResolvedValue(true)
  vi.mocked(api.requestProductDraftSuggestion).mockImplementation(async () => structuredClone(response))
  createDraft.mockResolvedValue({ id: 7, status: 'draft', contentVersion: 1, offers: [], nextStep: 'availability' })
})

describe('AI assisted draft creation', () => {
  it('hides the entry when unavailable and never generates on mount', async () => {
    vi.mocked(api.getDraftAssistantAvailability).mockResolvedValue(false)
    mount()
    await waitFor(() => expect(api.getDraftAssistantAvailability).toHaveBeenCalledWith('admin'))
    expect(screen.queryByRole('button', { name: '开始 AI 辅助创建' })).not.toBeInTheDocument()
    expect(api.requestProductDraftSuggestion).not.toHaveBeenCalled()
  })

  it('pre-fills editable suggestions without creating and only saves confirmed settings', async () => {
    mount()
    await generate()
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('学习指南')
    expect(screen.getByLabelText('内容类型')).toHaveValue('学习指引')
    expect(createDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认并创建草稿' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('商品名称 *'), { target: { value: '修改后的学习指南' } })
    fillCommerce()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7))
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(createDraft.mock.calls[0][0]).toMatchObject({ editorVersion: 2, name: '修改后的学习指南', templateKey: 'fixed_content',
      visibility: 'members_only', purchaseForm: [], images: [],
      offers: [{ name: '默认规格', price: 100, validityDays: null, deliveryMode: 'instant_fixed', stockMode: 'limited', fixedContent: null, autoProvision: false }] })
    expect(api.requestProductDraftSuggestion).toHaveBeenCalledWith('admin', '学习指南，适合入门学习，内容类型为学习指引', expect.any(AbortSignal))
  })

  it('requires explicit price, delivery and validity instead of inventing defaults', async () => {
    mount()
    await generate()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请填写')
    fireEvent.change(screen.getByLabelText('售价（积分，由你填写）*'), { target: { value: 100 } })
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请选择交付方式')
    fireEvent.change(screen.getByLabelText('交付方式（由你确认）*'), { target: { value: 'fixed_text' } })
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请确认有效期')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('invalidates stale suggestions and requires consent before replacing edited proposals', async () => {
    mount()
    await generate()
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '修改介绍或重新生成' }))
    fireEvent.change(screen.getByLabelText('1. 描述你的商品'), { target: { value: '不同商品' } })
    expect(screen.getByRole('button', { name: '确认并创建草稿' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新生成（消耗一次）' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('重新生成会替换本次预填内容，我确认重新生成'))
    fireEvent.click(screen.getByRole('button', { name: '重新生成（消耗一次）' }))
    await waitFor(() => expect(api.requestProductDraftSuggestion).toHaveBeenCalledTimes(2))
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('aborts on manual mode and ignores late generation responses', async () => {
    let resolve!: (value: api.ProductDraftSuggestionResponse) => void
    vi.mocked(api.requestProductDraftSuggestion).mockReturnValue(new Promise(done => { resolve = done }))
    mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: '生成预填内容' }))
    fireEvent.click(screen.getByRole('button', { name: '切回手动填写' }))
    expect(vi.mocked(api.requestProductDraftSuggestion).mock.calls[0][2].aborted).toBe(true)
    await act(async () => { resolve(response) })
    fireEvent.click(screen.getByRole('button', { name: '开始 AI 辅助创建' }))
    expect(screen.queryByLabelText('商品名称 *')).not.toBeInTheDocument()
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('prevents duplicate submissions and preserves edits for a failed save retry', async () => {
    let reject!: (error: unknown) => void
    createDraft.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    mount()
    await generate()
    fillCommerce()
    confirm()
    const button = screen.getByRole('button', { name: '确认并创建草稿' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(createDraft).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('temporary failure')) })
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7))
    expect(createDraft).toHaveBeenCalledTimes(2)
  })

  it('keeps manual mode available after provider failure or exhausted quota', async () => {
    vi.mocked(api.requestProductDraftSuggestion).mockRejectedValue({ response: { data: { error: { code: 'AI_QUOTA_EXCEEDED', message: '今日次数已用完' } } } })
    mount()
    await open()
    fireEvent.click(screen.getByRole('button', { name: '生成预填内容' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('今日次数已用完')
    expect(screen.getByRole('button', { name: '生成预填内容' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '切回手动填写' }))
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })
})
