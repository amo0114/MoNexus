import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import AdminProductPublicationDialog, {
  type AdminPublicationTarget,
} from './AdminProductPublicationDialog'

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    getAdminProductReadiness: mocks.readiness,
    publishAdminProduct: mocks.publish,
  }
})

const platformDraft: AdminPublicationTarget = {
  id: 11,
  name: 'Gold Plan',
  offers: [{ id: 42, name: '月付' }],
  origin: 'xboard-import',
}

const listDraft: AdminPublicationTarget = {
  id: 11,
  name: 'Gold Plan',
  offers: [{ id: 42, name: '月付' }],
  origin: 'product-list',
}

function renderDialog(
  target: AdminPublicationTarget | null = platformDraft,
  overrides: Partial<{
    open: boolean
    onClose: () => void
    onPublished: () => void
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn()
  const onPublished = overrides.onPublished ?? vi.fn()
  render(
    <AdminProductPublicationDialog
      open={overrides.open ?? true}
      target={target}
      onClose={onClose}
      onPublished={onPublished}
    />,
  )
  return { onClose, onPublished }
}

describe('AdminProductPublicationDialog (T-APUB-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null })
    mocks.readiness.mockResolvedValue({ ready: true, productId: 11, issues: [] })
    mocks.publish.mockResolvedValue({
      id: 11,
      status: 'active',
      publishedAt: '2026-08-17T00:00:00.000Z',
    })
  })

  it('loads server readiness on open before enabling publish (AC-APUB-005)', async () => {
    let resolveReadiness: ((value: unknown) => void) | undefined
    mocks.readiness.mockImplementation(
      () => new Promise((resolve) => { resolveReadiness = resolve }),
    )
    renderDialog()

    expect(await screen.findByTestId('admin-publication-loading')).toHaveTextContent('正在获取发布检查')
    expect(screen.queryByTestId('publication-publish')).not.toBeInTheDocument()
    expect(mocks.publish).not.toHaveBeenCalled()

    resolveReadiness?.({ ready: true, productId: 11, issues: [] })
    const publish = await screen.findByTestId('publication-publish')
    expect(publish).toBeEnabled()
    expect(publish).toHaveTextContent('发布到商城')
    expect(mocks.readiness).toHaveBeenCalledWith(11)
    expect(mocks.readiness).toHaveBeenCalledTimes(1)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('publishes only through the admin adapter when ready (AC-APUB-006)', async () => {
    const { onPublished, onClose } = renderDialog()
    fireEvent.click(await screen.findByTestId('publication-publish'))

    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(11))
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mocks.publish.mock.calls)).not.toMatch(/merchant/)
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith({
      id: 11,
      name: 'Gold Plan',
      status: 'active',
    }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows human issue copy and specification names, never raw codes or IDs (AC-APUB-007)', async () => {
    mocks.readiness.mockResolvedValue({
      ready: false,
      productId: 11,
      issues: [
        { code: 'COVER_REQUIRED', field: 'images', offerId: null },
        { code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: 42 },
      ],
    })
    renderDialog()

    const issues = await screen.findAllByTestId('readiness-issue')
    expect(issues[0]).toHaveTextContent('需要为商品设置有效封面')
    expect(issues[1]).toHaveTextContent('“月付”当前不可售')

    const dialog = screen.getByTestId('admin-publication-dialog')
    expect(dialog).not.toHaveTextContent('COVER_REQUIRED')
    expect(dialog).not.toHaveTextContent('OFFER_NOT_SELLABLE')
    expect(dialog).not.toHaveTextContent('images')
    expect(dialog).not.toHaveTextContent('42')
    expect(dialog).not.toHaveTextContent('#11')
    expect(screen.getByTestId('publication-publish')).toBeDisabled()
    expect(screen.getByTestId('admin-publication-retry')).toBeInTheDocument()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and refreshes issues after a 422 publish (AC-APUB-008)', async () => {
    mocks.publish.mockRejectedValueOnce({
      response: {
        status: 422,
        data: {
          error: {
            code: 'PRODUCT_NOT_READY',
            details: [{ code: 'COVER_REQUIRED', field: 'images', offerId: null }],
          },
        },
      },
    })
    mocks.readiness
      .mockResolvedValueOnce({ ready: true, productId: 11, issues: [] })
      .mockResolvedValueOnce({
        ready: false,
        productId: 11,
        issues: [{ code: 'COVER_REQUIRED', field: 'images', offerId: null }],
      })

    const { onPublished, onClose } = renderDialog()
    fireEvent.click(await screen.findByTestId('publication-publish'))

    await waitFor(() => expect(mocks.readiness).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('readiness-issue')).toHaveTextContent('需要为商品设置有效封面')
    expect(screen.getByTestId('admin-publication-dialog')).toBeInTheDocument()
    expect(onPublished).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已发布'))).toBe(false)
  })

  it('does not publish when the user chooses to handle later (AC-APUB-009)', async () => {
    const { onClose, onPublished } = renderDialog()
    await screen.findByTestId('publication-publish')
    fireEvent.click(screen.getByTestId('admin-publication-later'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPublished).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('sends only one publish request for a rapid double click (AC-APUB-013)', async () => {
    let resolvePublish: ((value: unknown) => void) | undefined
    mocks.publish.mockImplementation(
      () => new Promise((resolve) => { resolvePublish = resolve }),
    )
    renderDialog()
    const button = await screen.findByTestId('publication-publish')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    resolvePublish?.({ id: 11, status: 'active', publishedAt: '2026-08-17T00:00:00.000Z' })
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
  })

  it('keeps the imported draft and allows retry after a readiness network failure (AC-APUB-014)', async () => {
    mocks.readiness
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ready: true, productId: 11, issues: [] })

    const { onClose } = renderDialog()
    const error = await screen.findByTestId('admin-publication-error')
    expect(error).toHaveTextContent('商品已导入并保存为草稿，发布检查暂时失败')
    expect(error).not.toHaveTextContent('导入失败')
    expect(screen.queryByTestId('publication-publish')).not.toBeInTheDocument()
    expect(mocks.publish).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('admin-publication-retry'))
    expect(await screen.findByTestId('publication-publish')).toBeEnabled()
    expect(mocks.readiness).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('refreshes readiness after a 409 without claiming success', async () => {
    mocks.publish.mockRejectedValueOnce({
      response: { status: 409, data: { error: { message: '商品状态已变化，请刷新后重试' } } },
    })
    renderDialog(listDraft)
    fireEvent.click(await screen.findByTestId('publication-publish'))
    await waitFor(() => expect(mocks.readiness).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('商品状态已变化'))).toBe(true)
    expect(screen.getByTestId('admin-publication-dialog')).toBeInTheDocument()
  })

  it('ignores a stale readiness response after the target changes', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    mocks.readiness
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({
        ready: false,
        productId: 22,
        issues: [{ code: 'CATEGORY_INACTIVE', field: 'categoryId', offerId: null }],
      })

    const { rerender } = render(
      <AdminProductPublicationDialog
        open
        target={platformDraft}
        onClose={vi.fn()}
        onPublished={vi.fn()}
      />,
    )
    expect(await screen.findByTestId('admin-publication-loading')).toBeInTheDocument()

    rerender(
      <AdminProductPublicationDialog
        open
        target={{ id: 22, name: 'Other Plan', origin: 'product-list' }}
        onClose={vi.fn()}
        onPublished={vi.fn()}
      />,
    )
    resolveFirst?.({ ready: true, productId: 11, issues: [] })

    expect(await screen.findByTestId('readiness-issue')).toHaveTextContent('当前商品分类已停用')
    expect(screen.queryByTestId('publication-ready')).not.toBeInTheDocument()
  })
})
