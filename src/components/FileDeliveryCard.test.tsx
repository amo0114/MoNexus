import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import FileDeliveryCard from './FileDeliveryCard'
import { useAppStore } from '../stores/appStore'

const { issueOrderFileDownloadUrl } = vi.hoisted(() => ({
  issueOrderFileDownloadUrl: vi.fn(),
}))

vi.mock('../api/orders', () => ({
  issueOrderFileDownloadUrl,
}))

describe('FileDeliveryCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('renders normal file delivery with download button enabled', async () => {
    issueOrderFileDownloadUrl.mockResolvedValue({ url: 'https://download.local/file.zip' })
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock })

    render(
      <FileDeliveryCard
        orderId={101}
        fileName="dataset_2026.zip"
        size={1048576}
        orderStatus="delivered"
      />,
    )

    expect(screen.getByTestId('file-delivery-card')).toBeInTheDocument()
    expect(screen.getByText('dataset_2026.zip')).toBeInTheDocument()
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument()

    // No SHA-256 field per buyer DTO contract
    expect(screen.queryByText(/sha-?256/i)).not.toBeInTheDocument()

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeEnabled()
    expect(downloadBtn).toHaveTextContent('下载文件')

    fireEvent.click(downloadBtn)
    await waitFor(() => {
      expect(issueOrderFileDownloadUrl).toHaveBeenCalledWith(101)
    })
    expect(assignMock).toHaveBeenCalledWith('https://download.local/file.zip')
  })

  it('disables download button and shows dispute notice when orderStatus is disputed', () => {
    render(
      <FileDeliveryCard
        orderId={102}
        fileName="dataset_2026.zip"
        size={1048576}
        orderStatus="disputed"
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    expect(downloadBtn).toHaveTextContent('下载已暂停')
    expect(screen.getByTestId('file-delivery-disputed-notice')).toHaveTextContent('争议处理中，文件下载已暂停')

    fireEvent.click(downloadBtn)
    expect(issueOrderFileDownloadUrl).not.toHaveBeenCalled()
  })

  it('disables download button and shows refunded notice when orderStatus is refunded', () => {
    render(
      <FileDeliveryCard
        orderId={103}
        fileName="dataset_2026.zip"
        size={1048576}
        orderStatus="refunded"
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    expect(downloadBtn).toHaveTextContent('下载已关闭')
    expect(screen.getByTestId('file-delivery-refunded-notice')).toHaveTextContent('订单已全额退款，文件下载授权已关闭')

    fireEvent.click(downloadBtn)
    expect(issueOrderFileDownloadUrl).not.toHaveBeenCalled()
  })

  it('honors explicit disabled prop', () => {
    render(
      <FileDeliveryCard
        orderId={104}
        fileName="dataset_2026.zip"
        size={1048576}
        disabled
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    fireEvent.click(downloadBtn)
    expect(issueOrderFileDownloadUrl).not.toHaveBeenCalled()
  })

  it('disables download button and shows revoked notice when fileStatus is revoked even if orderStatus is delivered', () => {
    render(
      <FileDeliveryCard
        orderId={105}
        fileName="dataset_2026.zip"
        size={1048576}
        orderStatus="delivered"
        fileStatus="revoked"
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    expect(downloadBtn).toHaveTextContent('下载已作废')
    expect(screen.getByTestId('file-delivery-revoked-notice')).toHaveTextContent('文件下载已作废，授权已失效。如有疑问请联系平台处理。')

    fireEvent.click(downloadBtn)
    expect(issueOrderFileDownloadUrl).not.toHaveBeenCalled()
  })

  it('disables download button and shows deleted notice when fileStatus is deleted', () => {
    render(
      <FileDeliveryCard
        orderId={106}
        fileName="dataset_2026.zip"
        size={1048576}
        orderStatus="delivered"
        fileStatus="deleted"
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    expect(downloadBtn).toHaveTextContent('文件已删除')
    expect(screen.getByTestId('file-delivery-deleted-notice')).toHaveTextContent('文件已从存储节点移除，无法继续下载。如有疑问请联系平台处理。')

    fireEvent.click(downloadBtn)
    expect(issueOrderFileDownloadUrl).not.toHaveBeenCalled()
  })
})
