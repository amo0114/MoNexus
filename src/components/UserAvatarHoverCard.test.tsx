import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import UserAvatarHoverCard from './UserAvatarHoverCard'
import { useAppStore } from '../stores/appStore'
import type { AuthUser } from '../types/merchant'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('../api/client', () => ({
  default: { get: (...args: unknown[]) => apiGet(...args), post: vi.fn() },
}))

const MERCHANT_USER: AuthUser = {
  id: 3,
  email: 'merchant@moyuan.net',
  nickname: '墨缘掌柜',
  role: 'merchant',
  status: '正常',
  points: 5000,
  merchant: { id: 1, name: '墨缘精选商家', status: 'active', commissionRate: '0.1' },
  merchantCapabilities: ['history.read', 'catalog.write'],
}

function mockTier(tier: 'bronze' | 'silver' | 'gold' | 'platinum') {
  const map = {
    bronze: { tier: 'bronze', label: '青铜', tone: 'neutral', lifetimeEarnedPoints: 100, bonusBps: 0, thresholds: { silver: 1000, gold: 5000, platinum: 20000 }, nextTier: 'silver', nextTierLabel: '银卡', pointsToNextTier: 900 },
    silver: { tier: 'silver', label: '银卡', tone: 'info', lifetimeEarnedPoints: 2000, bonusBps: 500, thresholds: { silver: 1000, gold: 5000, platinum: 20000 }, nextTier: 'gold', nextTierLabel: '金卡', pointsToNextTier: 3000 },
    gold: { tier: 'gold', label: '金卡', tone: 'warning', lifetimeEarnedPoints: 5055, bonusBps: 1000, thresholds: { silver: 1000, gold: 5000, platinum: 20000 }, nextTier: 'platinum', nextTierLabel: '铂金', pointsToNextTier: 14945 },
    platinum: { tier: 'platinum', label: '铂金', tone: 'success', lifetimeEarnedPoints: 25000, bonusBps: 2000, thresholds: { silver: 1000, gold: 5000, platinum: 20000 }, nextTier: null, nextTierLabel: null, pointsToNextTier: 0 },
  } as const
  return map[tier]
}

function renderCard() {
  return render(
    <MemoryRouter>
      <UserAvatarHoverCard user={MERCHANT_USER} />
    </MemoryRouter>,
  )
}

describe('UserAvatarHoverCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    apiGet.mockReset()
    apiGet.mockImplementation((url: string) => {
      if (url === '/points/tier') return Promise.resolve({ data: mockTier('platinum') })
      return Promise.resolve({ data: [] })
    })
    useAppStore.setState({
      orderAttentionCount: 2,
      pointsHistoryOpen: false,
      checkinModalOpen: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies full-card prestige styling without cheesy copy or duplicated navbar items', async () => {
    renderCard()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const trigger = screen.getByTestId('navbar-avatar-trigger')
    expect(trigger).toHaveAttribute('data-tier', 'platinum')
    expect(screen.queryByTestId('avatar-hover-card')).not.toBeInTheDocument()

    fireEvent.mouseEnter(trigger.parentElement!)
    act(() => {
      vi.advanceTimersByTime(80)
    })

    const card = screen.getByTestId('avatar-hover-card')
    expect(card).toBeInTheDocument()
    expect(card).toHaveAttribute('data-tier', 'platinum')
    expect(card).toHaveTextContent('玉')
    expect(card).not.toHaveTextContent('墨玉')
    expect(card).not.toHaveTextContent('青玉')
    expect(card).toHaveTextContent('签到 +20%')
    expect(screen.getByTestId('hover-card-tier-progress')).toHaveTextContent('已达最高阶')
    expect(screen.getByTestId('hover-card-stat-points')).toHaveTextContent('5,000')
    expect(screen.getByTestId('hover-card-stat-orders')).toHaveTextContent('2')

    // No duplicated navbar entries and no cheesy buzzwords
    expect(card).not.toHaveTextContent('商家后台')
    expect(card).not.toHaveTextContent('主题外观')
    expect(card).not.toHaveTextContent('消息通知')
    expect(card).not.toHaveTextContent('黑金尊享')

    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/points/tier')

    fireEvent.mouseLeave(trigger.parentElement!)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByTestId('avatar-hover-card')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(screen.queryByTestId('avatar-hover-card')).not.toBeInTheDocument()
  })

  it('lazy-loads left preview flyouts for recent orders and points history on hover', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/points/tier') return Promise.resolve({ data: mockTier('gold') })
      if (url === '/orders') {
        return Promise.resolve({
          data: [
            {
              id: 88,
              price: 300,
              status: 'completed',
              deliveryMode: 'instant_inventory',
              createdAt: '2026-11-24T08:00:00.000Z',
              merchant: null,
              product: { id: 4, name: 'Apple ID 美区空白号', type: '充值卡密', icon: '', imageUrl: null, deliveryMode: 'instant_inventory' },
              delivery: null,
            },
          ],
        })
      }
      if (url === '/points/history') {
        return Promise.resolve({
          data: [
            { id: 1, type: 'in', amount: 20, reason: '每日签到奖励', createdAt: '2026-11-24T08:00:00.000Z' },
          ],
        })
      }
      return Promise.resolve({ data: [] })
    })

    renderCard()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.focus(screen.getByTestId('navbar-avatar-trigger'))
    expect(screen.getByTestId('avatar-hover-card')).toHaveAttribute('data-tier', 'gold')
    expect(screen.getByTestId('avatar-hover-card')).toHaveTextContent('金')
    expect(screen.getByTestId('avatar-hover-card')).not.toHaveTextContent('泥金笺')

    fireEvent.mouseEnter(screen.getByTestId('hover-card-stat-orders'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('hover-card-flyout-orders')).toHaveTextContent('Apple ID 美区空白号')

    fireEvent.mouseEnter(screen.getByTestId('hover-card-row-points'))
    act(() => {
      vi.advanceTimersByTime(100)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('hover-card-flyout-points')).toHaveTextContent('每日签到奖励')
  })

  it('opens check-in modal from the stats tile and closes on Escape', async () => {
    renderCard()
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.focus(screen.getByTestId('navbar-avatar-trigger'))
    expect(screen.getByTestId('avatar-hover-card')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('hover-card-stat-checkin'))
    expect(useAppStore.getState().checkinModalOpen).toBe(true)
    expect(screen.queryByTestId('avatar-hover-card')).not.toBeInTheDocument()

    fireEvent.focus(screen.getByTestId('navbar-avatar-trigger'))
    expect(screen.getByTestId('avatar-hover-card')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('avatar-hover-card')).not.toBeInTheDocument()
  })
})
