import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminProductListItem } from '../../api/admin'
import type { SourceDescriptionPreview } from '../../api/sourceDescription'
import { useAppStore } from '../../stores/appStore'
import AdminSourceDescriptionDialog from './AdminSourceDescriptionDialog'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
}))

vi.mock('../../api/sourceDescription', () => ({
  previewAdminSourceDescription: mocks.preview,
  applyAdminSourceDescription: mocks.apply,
}))

const sourceHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const descriptionHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const previewFixture: SourceDescriptionPreview = {
  sourceHash,
  descriptionHash,
  source: {
    description: '上游简介文案',
    richDescription: '<p>上游正文</p>',
  },
  local: {
    description: '本地简介文案',
    richDescription: '<p>本地正文</p>',
    contentVersion: 3,
  },
  changedSinceAccepted: null,
}

const product: AdminProductListItem = {
  id: 11,
  name: 'Gold Plan',
  status: 'draft',
  merchantId: null,
  fakaBridge: true,
  fakaCapacity: {
    sku: 'plan-11-monthly',
    planId: 81,
    capacityLimit: 100,
    activeUsers: 4,
    remaining: 96,
    sellable: true,
    source: 'xboard',
  },
  offers: [{ id: 42, name: '月付', externalIntegration: 'faka_bridge', externalSku: 'plan-11-monthly' }],
}

function renderDialog(
  overrides: Partial<{
    product: AdminProductListItem | null
    onClose: () => void
    onApplied: () => void | Promise<void>
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn()
  const onApplied = overrides.onApplied ?? vi.fn()
  render(
    <AdminSourceDescriptionDialog
      product={overrides.product === undefined ? product : overrides.product}
      onClose={onClose}
      onApplied={onApplied}
    />,
  )
  return { onClose, onApplied }
}

describe('AdminSourceDescriptionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    mocks.preview.mockResolvedValue(previewFixture)
    mocks.apply.mockResolvedValue({
      id: 11,
      contentVersion: 4,
      appliedFields: ['description'],
      sourceHash,
      descriptionHash,
    })
  })

  it('renders preview current and upstream copy without treating first-time as already synced', async () => {
    renderDialog()

    const current = await screen.findByTestId('admin-source-description-current')
    expect(mocks.preview).toHaveBeenCalledWith(11)
    const upstream = screen.getByTestId('admin-source-description-source')
    expect(current).toHaveTextContent('当前内容')
    expect(current).toHaveTextContent('本地简介文案')
    expect(current).toHaveTextContent('本地正文')
    expect(upstream).toHaveTextContent('上游内容')
    expect(upstream).toHaveTextContent('上游简介文案')
    expect(upstream).toHaveTextContent('上游正文')

    const firstTime = screen.getByTestId('admin-source-description-first-time')
    expect(firstTime).toHaveTextContent('首次对比')
    expect(firstTime).not.toHaveTextContent('已同步')
    expect(screen.getByTestId('admin-source-description-dialog')).not.toHaveTextContent('已经同步')

    expect(screen.getByTestId('admin-source-description-field-description')).not.toBeChecked()
    expect(screen.getByTestId('admin-source-description-field-richDescription')).not.toBeChecked()

    expect(current).not.toHaveTextContent(sourceHash)
    expect(upstream).not.toHaveTextContent(descriptionHash)
    expect(screen.getByTestId('admin-source-description-tech')).toHaveTextContent('技术信息')
  })

  it('disables submit when no fields are selected', async () => {
    renderDialog()
    const apply = await screen.findByTestId('admin-source-description-apply')
    expect(apply).toBeDisabled()
    expect(apply).toHaveTextContent('替换已选内容')
    fireEvent.click(apply)
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('apply sends only the selected fields', async () => {
    const { onApplied, onClose } = renderDialog()
    await screen.findByTestId('admin-source-description-apply')

    fireEvent.click(screen.getByLabelText('替换简介'))
    const apply = screen.getByTestId('admin-source-description-apply')
    expect(apply).toBeEnabled()
    expect(apply).toHaveTextContent('替换简介')
    expect(screen.getByTestId('admin-source-description-field-richDescription')).not.toBeChecked()

    fireEvent.click(apply)
    await waitFor(() => {
      expect(mocks.apply).toHaveBeenCalledWith(11, {
        sourceHash,
        descriptionHash,
        expectedContentVersion: 3,
        fields: ['description'],
      })
    })
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onApplied).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })
})
