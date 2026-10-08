import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentSuggestionResponse } from '../../api/contentSuggestion'
import { EMPTY_PRODUCT_DETAILS } from '../../types/catalog'
import ProductContentSuggestionDialog from './ProductContentSuggestionDialog'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  report: vi.fn(),
}))

vi.mock('../../api/contentSuggestion', async () => {
  const actual = await vi.importActual<typeof import('../../api/contentSuggestion')>('../../api/contentSuggestion')
  return {
    ...actual,
    requestContentSuggestion: mocks.request,
    reportContentSuggestionApplied: mocks.report,
  }
})

const response: ContentSuggestionResponse = {
  generationId: 9,
  basedOnContentVersion: 3,
  promptVersion: 'product-content@1',
  validatorVersion: 'product-content-validator@1',
  fields: {
    description: { status: 'suggested', value: '<b>AI 简介</b>', rejectedItemCount: 0 },
    highlights: { status: 'suggested', value: ['亮点一'], rejectedItemCount: 2 },
    purchaseNotes: { status: 'rejected', value: null, rejectedItemCount: 1 },
    faq: { status: 'not_generated', value: null, rejectedItemCount: 0 },
  },
  issues: [
    { kind: 'unsupported_fact', origin: 'validator', field: 'purchaseNotes', message: '「30 天」在商品配置中找不到依据', evidence: '30 天' },
    { kind: 'missing', origin: 'validator', field: 'attributes', message: '以下信息未提供：额度说明', evidence: null },
  ],
}

function renderDialog(overrides: Partial<Parameters<typeof ProductContentSuggestionDialog>[0]> = {}) {
  const props = {
    open: true,
    actor: 'merchant' as const,
    productId: 5,
    contentVersion: 3,
    canUseUpstream: false,
    current: { description: '旧简介', details: { ...EMPTY_PRODUCT_DETAILS, highlights: ['旧亮点'] } },
    onApply: vi.fn(),
    onClose: vi.fn(),
    onReload: vi.fn(),
    onUnavailable: vi.fn(),
    ...overrides,
  }
  const view = render(<ProductContentSuggestionDialog {...props} />)
  return { ...view, props }
}

async function generate() {
  fireEvent.click(screen.getByTestId('content-suggestion-generate'))
  await screen.findByTestId('content-suggestion-result')
}

describe('ProductContentSuggestionDialog (SPEC-AI-PRODUCT-001 §8)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.report.mockReset()
    mocks.report.mockResolvedValue(undefined)
  })

  it('sends the editor contentVersion and selected fields, without upstream for merchants', async () => {
    mocks.request.mockResolvedValue(response)
    renderDialog()
    fireEvent.click(screen.getByTestId('content-suggestion-target-faq'))
    fireEvent.change(screen.getByTestId('content-suggestion-notes'), { target: { value: '  先登录  ' } })
    expect(screen.queryByTestId('content-suggestion-use-upstream')).toBeNull()
    await generate()
    expect(mocks.request).toHaveBeenCalledWith('merchant', 5, {
      expectedContentVersion: 3,
      targetFields: ['description', 'highlights', 'usageInstructions', 'purchaseNotes', 'afterSalesInstructions'],
      sourceNotes: '先登录',
    })
  })

  it('offers the upstream option only when allowed', async () => {
    mocks.request.mockResolvedValue(response)
    renderDialog({ actor: 'admin', canUseUpstream: true })
    fireEvent.click(screen.getByTestId('content-suggestion-use-upstream'))
    await generate()
    expect(mocks.request.mock.calls[0][2]).toMatchObject({ useUpstreamDescription: true })
  })

  it('starts unchecked, blocks rejected fields and renders AI text as plain text', async () => {
    mocks.request.mockResolvedValue(response)
    renderDialog()
    await generate()
    expect(screen.getByTestId('content-suggestion-select-description')).not.toBeChecked()
    expect(screen.queryByTestId('content-suggestion-select-purchaseNotes')).toBeNull()
    expect(screen.getByTestId('content-suggestion-field-purchaseNotes')).toHaveTextContent('「30 天」在商品配置中找不到依据')
    expect(screen.getByTestId('content-suggestion-field-faq')).toHaveTextContent('未生成')
    expect(screen.getByTestId('content-suggestion-field-highlights')).toHaveTextContent('已过滤 2 条')
    expect(screen.getByText('<b>AI 简介</b>')).toBeInTheDocument()
    expect(screen.getByTestId('content-suggestion-apply')).toBeDisabled()
  })

  it('fills only the checked fields into the form and reports the count without saving', async () => {
    mocks.request.mockResolvedValue(response)
    const { props } = renderDialog()
    await generate()
    fireEvent.click(screen.getByTestId('content-suggestion-select-highlights'))
    fireEvent.click(screen.getByTestId('content-suggestion-apply'))
    expect(props.onApply).toHaveBeenCalledWith({ details: { highlights: ['亮点一'] } })
    expect(mocks.report).toHaveBeenCalledWith('merchant', 5, 9, 1)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('invalidates suggestions when the editor content version changes', async () => {
    mocks.request.mockResolvedValue(response)
    const { rerender, props } = renderDialog()
    await generate()
    fireEvent.click(screen.getByTestId('content-suggestion-select-description'))
    rerender(<ProductContentSuggestionDialog {...props} contentVersion={4} />)
    expect(screen.getByTestId('content-suggestion-stale')).toBeInTheDocument()
    expect(screen.getByTestId('content-suggestion-apply')).toBeDisabled()
  })

  it.each([
    ['AI_QUOTA_EXCEEDED', 429, '今日 AI 整理次数已用完'],
    ['AI_GENERATION_IN_PROGRESS', 409, '上一次整理仍在进行中'],
    ['AI_TIMEOUT', 504, 'AI 暂时不可用，你可以继续手动编辑'],
  ])('maps %s to its failure copy', async (code, status, copy) => {
    mocks.request.mockRejectedValue({ response: { status, data: { error: { code, message: 'x' } } } })
    renderDialog()
    fireEvent.click(screen.getByTestId('content-suggestion-generate'))
    expect(await screen.findByTestId('content-suggestion-error')).toHaveTextContent(copy)
    if (code === 'AI_QUOTA_EXCEEDED') {
      expect(screen.getByTestId('content-suggestion-generate')).toBeDisabled()
    }
  })

  it('offers a reload on PRODUCT_CONTENT_CHANGED', async () => {
    mocks.request.mockRejectedValue({ response: { status: 409, data: { error: { code: 'PRODUCT_CONTENT_CHANGED', message: 'x' } } } })
    const { props } = renderDialog()
    fireEvent.click(screen.getByTestId('content-suggestion-generate'))
    fireEvent.click(await screen.findByTestId('content-suggestion-reload'))
    expect(props.onReload).toHaveBeenCalled()
  })

  it('hides the feature on 404', async () => {
    mocks.request.mockRejectedValue({ response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'x' } } } })
    const { props } = renderDialog()
    fireEvent.click(screen.getByTestId('content-suggestion-generate'))
    await waitFor(() => expect(props.onUnavailable).toHaveBeenCalled())
    expect(props.onClose).toHaveBeenCalled()
  })
})
