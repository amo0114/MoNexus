import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }))
vi.mock('../utils/clipboard', () => ({ copyToClipboard }))
vi.mock('../api/orders', () => ({ getOrderDetail: vi.fn() }))
vi.mock('../api/auth', () => ({ getMe: vi.fn() }))

import SuccessModal from './SuccessModal'
import { getOrderDetail } from '../api/orders'

function signInBuyer() {
  const payload = btoa(JSON.stringify({ userId: 1, sid: 'buyer-sess', exp: 4102444800 })).replace(/=+$/, '')
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'buyer@test.local',
      role: 'user',
      status: 'active',
      points: 500,
      merchant: null,
    },
    accessToken: `header.${payload}.sig`,
    sessionId: 'buyer-sess',
    isLoggedIn: true,
    authEpoch: 1,
  })
}

describe('SuccessModal delivery reveal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyToClipboard.mockResolvedValue(true)
    useAppStore.setState({ toasts: [] })
    signInBuyer()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  it('coats a plain-text code and reveals it when the buyer copies', async () => {
    render(<SuccessModal deliveryContent="CARD-1234-ABCD" deliveryContentType="text" orderId={7} onClose={() => {}} />)

    const text = screen.getByTestId('delivery-text-content')
    expect(text.parentElement).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(screen.getByTestId('success-copy-content'))

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('CARD-1234-ABCD'))
    expect(text.parentElement).toHaveAttribute('aria-hidden', 'false')
    expect(screen.queryByTestId('scratch-reveal-button')).not.toBeInTheDocument()
  })

  it('reveals through the copy-text button in the code header', async () => {
    render(<SuccessModal deliveryContent="CARD-1234-ABCD" deliveryContentType="text" orderId={7} onClose={() => {}} />)

    fireEvent.click(screen.getByTestId('delivery-copy-text'))

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('CARD-1234-ABCD'))
    expect(screen.getByTestId('scratch-reveal')).toHaveAttribute('data-revealed', 'true')
  })

  it('leaves link deliveries uncoated', () => {
    render(
      <SuccessModal
        deliveryContent="https://example.com/download"
        deliveryContentType="url"
        orderId={7}
        onClose={() => {}}
      />,
    )

    expect(screen.getByTestId('success-delivery-link')).toHaveAttribute('href', 'https://example.com/download')
    expect(screen.queryByTestId('scratch-reveal')).not.toBeInTheDocument()
  })
})

describe('SuccessModal async provision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    signInBuyer()
  })

  it('shows a refunded provision as a failure, not as a successful redemption', async () => {
    vi.mocked(getOrderDetail).mockResolvedValue({ status: 'refunded' } as never)
    render(<SuccessModal deliveryContent="" orderId={7} provisionPending onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('success-provision-refunded')).toBeInTheDocument(), { timeout: 2000 })
    expect(screen.getByTestId('success-modal-title')).toHaveTextContent('开通失败')
    expect(screen.getByTestId('success-refunded-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('success-check-icon')).not.toBeInTheDocument()
    expect(screen.queryByTestId('success-copy-content')).not.toBeInTheDocument()
  })
})
