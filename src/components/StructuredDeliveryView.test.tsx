import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import StructuredDeliveryView from './StructuredDeliveryView'
import { useAppStore } from '../stores/appStore'
import type { StructuredDeliveryContent } from '../types/merchant'

const SAMPLE_CONTENT: StructuredDeliveryContent = {
  fields: [
    { key: 'account', label: '账号', sensitive: false },
    { key: 'password', label: '密码', sensitive: true },
    { key: 'port', label: '端口', sensitive: false },
  ],
  values: {
    account: 'developer@nexus.local',
    password: 'SuperSecretPassword123',
    port: '8443',
  },
}

describe('StructuredDeliveryView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('renders all fields and masks sensitive fields by default', () => {
    render(<StructuredDeliveryView content={SAMPLE_CONTENT} />)

    expect(screen.getByTestId('structured-delivery')).toBeInTheDocument()
    expect(screen.getByTestId('structured-field-account')).toHaveTextContent('developer@nexus.local')
    expect(screen.getByTestId('structured-field-password')).toHaveTextContent('••••••••')
    expect(screen.queryByText('SuperSecretPassword123')).not.toBeInTheDocument()

    // Toggle reveal
    const revealBtn = screen.getByTestId('structured-reveal-password')
    fireEvent.click(revealBtn)
    expect(screen.getByTestId('structured-field-password')).toHaveTextContent('SuperSecretPassword123')

    // Toggle back to mask
    fireEvent.click(revealBtn)
    expect(screen.getByTestId('structured-field-password')).toHaveTextContent('••••••••')
  })

  it('copies single field and shows Check icon feedback on resolved promise', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(<StructuredDeliveryView content={SAMPLE_CONTENT} />)

    const copyAccountBtn = screen.getByTestId('structured-copy-account')
    fireEvent.click(copyAccountBtn)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('developer@nexus.local')
    })
    expect(copyAccountBtn).toHaveTextContent('已复制')

    // Toast was shown
    expect(useAppStore.getState().toasts[0]?.message).toBe('「账号」已复制')
  })

  it('shows error toast when single field clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(<StructuredDeliveryView content={SAMPLE_CONTENT} />)

    const copyAccountBtn = screen.getByTestId('structured-copy-account')
    fireEvent.click(copyAccountBtn)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('developer@nexus.local')
    })
    // Did not switch to "已复制"
    expect(copyAccountBtn).not.toHaveTextContent('已复制')
    expect(useAppStore.getState().toasts[0]?.message).toContain('复制失败，请长按或手动选中文本复制')
  })

  it('provides copy all button and copies all fields formatted as key-value lines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(<StructuredDeliveryView content={SAMPLE_CONTENT} />)

    const copyAllBtn = screen.getByTestId('structured-copy-all')
    expect(copyAllBtn).toBeInTheDocument()
    expect(copyAllBtn).toHaveTextContent('一键复制全部')

    fireEvent.click(copyAllBtn)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '账号：developer@nexus.local\n密码：SuperSecretPassword123\n端口：8443',
      )
    })
    expect(copyAllBtn).toHaveTextContent('已复制全部')
    expect(useAppStore.getState().toasts[0]?.message).toBe('已复制全部凭据')
  })

  it('does not render copy button for empty field value', () => {
    const sparseContent: StructuredDeliveryContent = {
      fields: [
        { key: 'account', label: '账号' },
        { key: 'note', label: '备注文档' },
      ],
      values: {
        account: 'user1',
        note: '',
      },
    }

    render(<StructuredDeliveryView content={sparseContent} />)

    expect(screen.getByTestId('structured-copy-account')).toBeInTheDocument()
    expect(screen.queryByTestId('structured-copy-note')).not.toBeInTheDocument()
  })

  it('manages single and copy-all timers independently so alternating copies fade correctly', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(<StructuredDeliveryView content={SAMPLE_CONTENT} />)

    const copyAccountBtn = screen.getByTestId('structured-copy-account')
    const copyAllBtn = screen.getByTestId('structured-copy-all')

    // 1. Copy single field
    await act(async () => {
      fireEvent.click(copyAccountBtn)
    })
    expect(copyAccountBtn).toHaveTextContent('已复制')

    // 2. Immediately copy all
    await act(async () => {
      fireEvent.click(copyAllBtn)
    })
    expect(copyAllBtn).toHaveTextContent('已复制全部')
    expect(copyAccountBtn).toHaveTextContent('已复制')

    // 3. Advance time by 2000ms: both timers should fire and reset their respective states
    await act(async () => {
      vi.advanceTimersByTime(2100)
    })

    expect(copyAccountBtn).not.toHaveTextContent('已复制')
    expect(copyAllBtn).not.toHaveTextContent('已复制全部')
    expect(copyAllBtn).toHaveTextContent('一键复制全部')

    vi.useRealTimers()
  })
})
