import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import MerchantHonorBadge from './MerchantHonorBadge'

describe('MerchantHonorBadge Component', () => {
  it('strips emojis and applies gold theme with Crown icon for certified badges', () => {
    const { container } = render(<MerchantHonorBadge badge="👑 平台认证" />)
    const badge = screen.getByText('平台认证')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--gold')
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('strips emojis and applies cyan theme with Zap icon for speed/fulfillment badges', () => {
    render(<MerchantHonorBadge badge="⚡ 秒级履约" />)
    const badge = screen.getByText('秒级履约')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--cyan')
  })

  it('strips emojis and applies emerald theme with ShieldCheck icon for escrow/protection badges', () => {
    render(<MerchantHonorBadge badge="🛡️ 全额存管" />)
    const badge = screen.getByText('全额存管')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--emerald')
  })

  it('strips emojis and applies purple theme with Gem icon for quality/diamond merchant badges', () => {
    render(<MerchantHonorBadge badge="💎 优质商户" />)
    const badge = screen.getByText('优质商户')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--purple')
  })

  it('supports store age and award badges like 5年老店', () => {
    render(<MerchantHonorBadge badge="🏆 5年老店" />)
    const badge = screen.getByText('5年老店')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--amber')
  })

  it('renders clean fallback for arbitrary custom badge strings', () => {
    render(<MerchantHonorBadge badge="先行试用" />)
    const badge = screen.getByText('先行试用')
    expect(badge).toBeInTheDocument()
    expect(badge.closest('.pd-honor-badge')).toHaveClass('pd-honor-badge--default')
  })
})
