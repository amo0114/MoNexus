import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import MerchantSupportModal from './MerchantSupportModal'
import { useAppStore } from '../../stores/appStore'

describe('MerchantSupportModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ showToast: vi.fn() })
  })

  it('renders nothing when open is false', () => {
    render(<MerchantSupportModal open={false} onClose={onClose} merchantName="元柔纸品" />)
    expect(screen.queryByTestId('merchant-support-modal')).toBeNull()
  })

  it('renders merchant name, official badge, and support channels when open', () => {
    render(<MerchantSupportModal open={true} onClose={onClose} merchantName="元柔纸品" />)
    expect(screen.getByTestId('merchant-support-modal')).toBeInTheDocument()
    expect(screen.getByText('服务支持与客服')).toBeInTheDocument()
    expect(screen.getByText('元柔纸品')).toBeInTheDocument()
    expect(screen.getByText('认证商家')).toBeInTheDocument()
    expect(screen.getByText('support@monexus.io')).toBeInTheDocument()
  })

  it('falls back to 官方自营 when merchantName is omitted', () => {
    render(<MerchantSupportModal open={true} onClose={onClose} />)
    expect(screen.getByText('MoNexus 官方自营')).toBeInTheDocument()
    expect(screen.getByText('官方自营')).toBeInTheDocument()
  })

  it('calls onClose when clicking close or acknowledge button', () => {
    render(<MerchantSupportModal open={true} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '我知道了' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('copies email to clipboard on copy button click', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })

    render(<MerchantSupportModal open={true} onClose={onClose} />)
    const copyBtn = screen.getByRole('button', { name: '复制邮箱' })
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('support@monexus.io')
      expect(screen.getByText('已复制')).toBeInTheDocument()
    })
  })

  it('closes on Escape key press', () => {
    render(<MerchantSupportModal open={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
