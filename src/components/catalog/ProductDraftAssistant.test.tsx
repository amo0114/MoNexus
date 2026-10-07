import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductDraftAssistant from './ProductDraftAssistant'
import * as api from '../../api/productDraftAssistant'
import { catalogGovernanceApi } from '../../api/catalogGovernance'
import { catalogApi } from '../../api/catalog'
import { uploadImage } from '../../api/uploads'
import { EMPTY_PRODUCT_DETAILS, type ProductTemplateDefinition } from '../../types/catalog'

vi.mock('../../api/productDraftAssistant', () => ({ getDraftAssistantAvailability: vi.fn(), requestProductDraftSuggestion: vi.fn() }))
vi.mock('../../api/uploads', () => ({ uploadImage: vi.fn() }))
const template: ProductTemplateDefinition = {
  key: 'fixed_content', version: 1, label: '固定数字内容',
  productSchema: { type: 'object', properties: { contentCategory: { type: 'string', title: '内容类型' } } },
  offerSchema: { type: 'object', properties: {} },
  ui: { productOrder: ['contentCategory'], offerOrder: [], widgets: { contentCategory: 'text' } },
  fulfillmentRules: [{ whenProductAttributes: {}, configurations: ['fixed_text', 'fixed_url'], requireStructuredDelivery: 'none', requireRequiredDateField: false }],
}
const response: api.ProductDraftSuggestionResponse = {
  generationId: 1, missingFields: [], rejectedFieldCount: 0, truncated: false,
  suggestion: { templateKey: 'fixed_content', categoryId: 1, name: '学习指南', description: '适合入门学习', introduction: '商品介绍\n帮助入门学习者理解连接基础与常见问题排查。', offerName: null,
    attributes: { contentCategory: '学习指引' }, offerAttributes: {}, details: EMPTY_PRODUCT_DETAILS },
}
const createDraft = vi.fn()
const onCreated = vi.fn()
const onActiveChange = vi.fn()
function mount(templates: ProductTemplateDefinition[] = [template]) {
  return render(<ProductDraftAssistant actor="admin" templates={templates}
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
  fireEvent.click(screen.getByRole('button', { name: /^交易设置/ }))
  fireEvent.change(screen.getByLabelText('售价（积分，由你填写）*'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('交付方式（由你确认）*'), { target: { value: 'fixed_text' } })
  fireEvent.change(screen.getByLabelText('有效期（由你确认）*'), { target: { value: 'none' } })
}
function review() { fireEvent.click(screen.getByRole('button', { name: '下一步：确认草稿' })) }
function editInfo() { fireEvent.click(screen.getByRole('button', { name: /^商品信息/ })) }
function confirm() { fireEvent.click(screen.getByLabelText('我已核对商品形态、分类、参数和交易设置，确认保存为草稿')) }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.mocked(api.getDraftAssistantAvailability).mockResolvedValue(true)
  vi.mocked(api.requestProductDraftSuggestion).mockImplementation(async () => structuredClone(response))
  createDraft.mockResolvedValue({ id: 7, status: 'draft', contentVersion: 1, offers: [], nextStep: 'availability' })
})

describe('AI assisted draft creation', () => {
  async function fillCategory() {
    fireEvent.change(screen.getByTestId('category-form-label'), { target: { value: '简历服务' } })
    fireEvent.change(screen.getByTestId('category-form-code'), { target: { value: 'resume-service' } })
    vi.mocked(uploadImage).mockResolvedValue({ key: 'category-cover', url: '/uploads/category-cover' })
    fireEvent.change(screen.getByLabelText('默认封面 *'), { target: { files: [new File(['image'], 'cover.png', { type: 'image/png' })] } })
    await screen.findByAltText('分类默认封面预览')
  }

  it('creates and selects an admin category in place, preserving generated copy and commerce through save', async () => {
    const create = vi.spyOn(catalogGovernanceApi, 'createCategory').mockResolvedValue({ id: 9, code: 'resume-service', label: '简历服务', sortOrder: 0, iconKey: null } as never)
    mount()
    await generate()
    fillCommerce()
    editInfo()
    fireEvent.change(screen.getByLabelText('商品名称 *'), { target: { value: '我修改的名称' } })
    fireEvent.click(screen.getByRole('button', { name: '没有合适的分类？新建分类' }))
    await fillCategory()
    fireEvent.click(screen.getByRole('button', { name: '创建分类', exact: true }))
    await waitFor(() => expect(screen.getByLabelText('商品分类（AI 建议，请核对）*')).toHaveValue('9'))
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('我修改的名称')
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    expect(screen.getByLabelText('详细商品介绍')).toHaveValue(response.suggestion.introduction)
    expect(create).toHaveBeenCalledExactlyOnceWith({ code: 'resume-service', label: '简历服务', sortOrder: 0, iconKey: undefined, description: undefined, defaultCover: { kind: 'upload', objectKey: 'category-cover' } })
    expect(api.requestProductDraftSuggestion).toHaveBeenCalledOnce()
    review()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 9, name: '我修改的名称' })))
  })

  it('preserves category and product fields after a duplicate category error, and blocks duplicate writes', async () => {
    let reject!: (reason: unknown) => void
    const create = vi.spyOn(catalogGovernanceApi, 'createCategory').mockReturnValue(new Promise((_, fail) => { reject = fail }))
    mount()
    await generate()
    editInfo()
    fireEvent.click(screen.getByRole('button', { name: '没有合适的分类？新建分类' }))
    await fillCategory()
    const submit = screen.getByRole('button', { name: '创建分类', exact: true })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(create).toHaveBeenCalledOnce()
    await act(async () => reject({ response: { data: { error: { code: 'CONFLICT', message: '分类名称已存在' } } } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('分类名称已存在')
    expect(screen.getByTestId('category-form-label')).toHaveValue('简历服务')
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('学习指南')
    expect(screen.getByLabelText('商品分类（AI 建议，请核对）*')).toHaveValue('1')
  })

  it('lets an empty category directory generate content, then supplies the missing category in place', async () => {
    vi.mocked(api.requestProductDraftSuggestion).mockResolvedValueOnce({ ...response, suggestion: { ...response.suggestion, categoryId: null } })
    const refresh = vi.spyOn(catalogApi, 'listActiveCategories').mockResolvedValue([{ id: 9, code: 'resume', label: '简历服务', iconKey: null, sortOrder: 0 }])
    render(<ProductDraftAssistant actor="admin" templates={[template]} categories={[]} createDraft={createDraft} onCreated={onCreated} onActiveChange={onActiveChange} />)
    await generate()
    expect(screen.getByRole('button', { name: '没有合适的分类？新建分类' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '刷新分类' }))
    await screen.findByRole('option', { name: '简历服务' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('学习指南')
  })

  it('offers merchants an application, never a direct category write or unapproved selection', async () => {
    const create = vi.spyOn(catalogGovernanceApi, 'createCategory')
    const apply = vi.spyOn(catalogGovernanceApi, 'createApplication').mockResolvedValue({ id: 11, status: 'pending' } as never)
    render(<ProductDraftAssistant actor="merchant" templates={[template]} categories={[]} createDraft={createDraft} onCreated={onCreated} onActiveChange={onActiveChange} />)
    await generate()
    editInfo()
    expect(screen.queryByRole('button', { name: '没有合适的分类？新建分类' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '没有合适的分类？申请新分类' }))
    fireEvent.change(screen.getByLabelText('分类名称 *'), { target: { value: '简历服务' } })
    fireEvent.change(screen.getByLabelText('分类描述（至少 20 字）*'), { target: { value: '用于展示整理客户提供的简历文字与版式的人工服务商品' } })
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }))
    await screen.findByText(/申请已提交，等待平台审核/)
    expect(create).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledExactlyOnceWith({ proposedLabel: '简历服务', description: '用于展示整理客户提供的简历文字与版式的人工服务商品', exampleProducts: '学习指南' })
    expect(screen.queryByRole('option', { name: '简历服务' })).not.toBeInTheDocument()
    expect(createDraft).not.toHaveBeenCalled()
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('学习指南')
  })

  it('guides missing template facts to their editor without treating them as draft blockers', async () => {
    vi.mocked(api.requestProductDraftSuggestion).mockResolvedValueOnce({ ...response, suggestion: { ...response.suggestion, attributes: {} } })
    mount([{ ...template, productSchema: { ...template.productSchema, required: ['contentCategory'] } }])
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '发布前还需补充参数：内容类型' }))
    const field = screen.getByLabelText('内容类型 *')
    expect(field).toBeVisible()
    fireEvent.change(field, { target: { value: '学习指引' } })
    expect(screen.queryByRole('button', { name: /发布前还需补充参数/ })).not.toBeInTheDocument()
    fillCommerce()
    review()
    expect(screen.getByRole('complementary')).toHaveTextContent('学习指引')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('offers examples without a model call and previews unknown commercial facts honestly', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '开始 AI 辅助创建' }))
    fireEvent.click(screen.getByRole('button', { name: '试试数字文件' }))
    expect((screen.getByLabelText('1. 描述你的商品') as HTMLTextAreaElement).value).toContain('PDF')
    expect(api.requestProductDraftSuggestion).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '试试数字文件' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '生成预填内容' }))
    const preview = await screen.findByRole('complementary', { name: '商品草稿预览' })
    expect(preview).toHaveTextContent('售价待填写')
    expect(preview).not.toHaveTextContent('无固定有效期')
    expect(screen.getByText('还需确认 3 项')).toBeInTheDocument()
    fillCommerce()
    expect(preview).toHaveTextContent('100积分')
    expect(preview).toHaveTextContent('无固定有效期')
    expect(screen.getByText('可以进入草稿确认')).toBeInTheDocument()
  })

  it('preserves edits when navigating back and requires a fresh review', async () => {
    mount()
    await generate()
    fillCommerce()
    review()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '返回调整' }))
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    fireEvent.change(screen.getByLabelText('售价（积分，由你填写）*'), { target: { value: 200 } })
    review()
    expect(screen.getByRole('button', { name: '确认并创建草稿' })).toBeDisabled()
    expect(screen.getByRole('complementary')).toHaveTextContent('200积分')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('can discard failed follow-up input without losing current work', async () => {
    mount()
    await generate()
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    fireEvent.change(screen.getByLabelText('补充或修改公开商品介绍'), { target: { value: '这次修改无法完成' } })
    vi.mocked(api.requestProductDraftSuggestion).mockRejectedValueOnce(new Error('unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '整理并对比修改（消耗一次）' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '下一步：确认草稿' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消本次介绍修改' }))
    review()
    expect(screen.getByRole('complementary')).toHaveTextContent('100积分')
    expect(screen.getByRole('complementary')).toHaveTextContent('学习指南')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('requires resolving even a no-change follow-up before creation', async () => {
    mount()
    await generate()
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    fireEvent.click(screen.getByRole('button', { name: '整理并对比修改（消耗一次）' }))
    await screen.findByText('这次没有新的字段变化')
    expect(screen.getByRole('button', { name: '下一步：确认草稿' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '确认继续' }))
    expect(screen.getByRole('button', { name: '下一步：确认草稿' })).toBeEnabled()
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('keeps pending changes and manual fields intact when the user rejects the candidate', async () => {
    mount()
    await generate()
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    fireEvent.change(screen.getByLabelText('补充或修改公开商品介绍'), { target: { value: '新的介绍' } })
    vi.mocked(api.requestProductDraftSuggestion).mockResolvedValueOnce({ ...response, suggestion: { ...response.suggestion, name: null } })
    fireEvent.click(screen.getByRole('button', { name: '整理并对比修改（消耗一次）' }))
    await screen.findByRole('region', { name: '核对本次修改' })
    fireEvent.click(screen.getByRole('button', { name: '保留当前内容' }))
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('学习指南')
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    expect(screen.getByLabelText('补充或修改公开商品介绍')).toHaveValue('学习指南，适合入门学习，内容类型为学习指引')
  })

  it('adopts a new template and its parameters together and rechecks incompatible delivery', async () => {
    const service: ProductTemplateDefinition = { ...template, key: 'manual_service', label: '人工服务',
      productSchema: { type: 'object', properties: { serviceScope: { type: 'string', title: '服务内容' } } },
      ui: { productOrder: ['serviceScope'], offerOrder: [], widgets: { serviceScope: 'text' } },
      fulfillmentRules: [{ whenProductAttributes: {}, configurations: ['manual'], requireStructuredDelivery: 'none', requireRequiredDateField: false }] }
    mount([template, service])
    await generate()
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    vi.mocked(api.requestProductDraftSuggestion).mockResolvedValueOnce({ ...response, suggestion: { ...response.suggestion, templateKey: 'manual_service', attributes: { serviceScope: '排版服务' } } })
    fireEvent.click(screen.getByRole('button', { name: '整理并对比修改（消耗一次）' }))
    await screen.findByRole('region', { name: '核对本次修改' })
    fireEvent.click(screen.getByLabelText('采纳：商品形态与所属参数（一起更换）'))
    fireEvent.click(screen.getByRole('button', { name: '采纳所选 1 项修改' }))
    expect(screen.getByLabelText('商品形态（AI 建议，请核对）*')).toHaveValue('manual_service')
    expect(screen.getByLabelText('服务内容')).toHaveValue('排版服务')
    expect(screen.queryByLabelText('内容类型')).not.toBeInTheDocument()
    expect(screen.getByLabelText('交付方式（由你确认）*')).toHaveValue('')
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    review()
    expect(screen.getByRole('alert')).toHaveTextContent('请选择交付方式')
  })

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
    expect(screen.queryByRole('button', { name: '确认并创建草稿' })).not.toBeInTheDocument()
    editInfo()
    fireEvent.change(screen.getByLabelText('商品名称 *'), { target: { value: '修改后的学习指南' } })
    fillCommerce()
    review()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7))
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(createDraft.mock.calls[0][0]).toMatchObject({ editorVersion: 2, name: '修改后的学习指南', templateKey: 'fixed_content',
      richDescription: '<p>商品介绍<br>帮助入门学习者理解连接基础与常见问题排查。</p>',
      visibility: 'members_only', purchaseForm: [], images: [],
      offers: [{ name: '默认规格', price: 100, validityDays: null, deliveryMode: 'instant_fixed', stockMode: 'limited', fixedContent: null, autoProvision: false }] })
    expect(api.requestProductDraftSuggestion).toHaveBeenCalledWith('admin', '学习指南，适合入门学习，内容类型为学习指引', expect.any(AbortSignal))
  })

  it('shows and edits detailed copy separately, then saves the same reviewed text', async () => {
    mount()
    await generate()
    expect(screen.getByRole('region', { name: '详细商品介绍预览' })).toHaveTextContent('帮助入门学习者')
    fireEvent.click(screen.getByRole('button', { name: /^详细说明/ }))
    const input = screen.getByLabelText('详细商品介绍')
    expect(input).toBeVisible()
    fireEvent.change(input, { target: { value: '内容与服务\n整理简历文字与版式。' } })
    expect(screen.getByRole('region', { name: '详细商品介绍预览' })).toHaveTextContent('整理简历文字与版式')
    fillCommerce()
    review()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
      description: '适合入门学习', richDescription: '<p>内容与服务<br>整理简历文字与版式。</p>',
    })))
  })

  it('requires explicit price, delivery and validity instead of inventing defaults', async () => {
    mount()
    await generate()
    review()
    expect(screen.getByRole('alert')).toHaveTextContent('请填写')
    fireEvent.change(screen.getByLabelText('售价（积分，由你填写）*'), { target: { value: 100 } })
    review()
    expect(screen.getByRole('alert')).toHaveTextContent('请选择交付方式')
    fireEvent.change(screen.getByLabelText('交付方式（由你确认）*'), { target: { value: 'fixed_text' } })
    review()
    expect(screen.getByRole('alert')).toHaveTextContent('请确认有效期')
    expect(createDraft).not.toHaveBeenCalled()
  })

  it('compares follow-up fields without overwriting manual edits or commerce', async () => {
    mount()
    await generate()
    editInfo()
    fireEvent.change(screen.getByLabelText('商品名称 *'), { target: { value: '我的人工名称' } })
    fillCommerce()
    fireEvent.click(screen.getByRole('button', { name: '补充介绍，让 AI 再整理' }))
    fireEvent.change(screen.getByLabelText('补充或修改公开商品介绍'), { target: { value: '补充公开信息' } })
    expect(screen.getByRole('button', { name: '下一步：确认草稿' })).toBeDisabled()
    vi.mocked(api.requestProductDraftSuggestion).mockResolvedValue({ ...response, suggestion: { ...response.suggestion, name: '新名称', description: '更完整的介绍' } })
    fireEvent.click(screen.getByRole('button', { name: '整理并对比修改（消耗一次）' }))
    const diff = await screen.findByRole('region', { name: '核对本次修改' })
    expect(within(diff).getByLabelText('采纳：商品名称')).not.toBeChecked()
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('我的人工名称')
    expect(screen.getByLabelText('商品名称 *')).toBeDisabled()
    fireEvent.click(within(diff).getByLabelText('采纳：商品简介'))
    fireEvent.click(screen.getByRole('button', { name: '采纳所选 1 项修改' }))
    expect(screen.getByLabelText('商品名称 *')).toHaveValue('我的人工名称')
    expect(screen.getByLabelText('商品简介')).toHaveValue('更完整的介绍')
    expect(screen.getByLabelText('售价（积分，由你填写）*')).toHaveValue(100)
    expect(screen.getByLabelText('交付方式（由你确认）*')).toHaveValue('fixed_text')
    expect(screen.getByLabelText('有效期（由你确认）*')).toHaveValue('none')
    expect(api.requestProductDraftSuggestion).toHaveBeenLastCalledWith('admin', '补充公开信息', expect.any(AbortSignal))
    review()
    confirm()
    fireEvent.click(screen.getByRole('button', { name: '确认并创建草稿' }))
    await waitFor(() => expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({ name: '我的人工名称', description: '更完整的介绍' })))
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
    review()
    confirm()
    const button = screen.getByRole('button', { name: '确认并创建草稿' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(createDraft).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('temporary failure')) })
    expect(screen.getByRole('complementary', { name: '商品草稿预览' })).toHaveTextContent('100')
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
