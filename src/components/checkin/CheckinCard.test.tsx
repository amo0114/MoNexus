import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CheckinCard, { CheckinCompact } from './CheckinCard'
import { useCheckin } from '../../hooks/useCheckin'
import { claimCheckinReward, getCheckinStatus, postCheckin, postMakeup, type CheckinStatus } from '../../api/checkin'
import { celebrate } from '../../lib/celebrate'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'

vi.mock('../../api/checkin', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/checkin')>(),
  getCheckinStatus: vi.fn(),
  postCheckin: vi.fn(),
  postMakeup: vi.fn(),
  claimCheckinReward: vi.fn(),
}))
vi.mock('../../lib/celebrate', () => ({ celebrate: vi.fn() }))

function status(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    hasCheckedIn: false,
    today: '2026-11-09',
    streak: 2,
    streakState: 'pending',
    month: { key: '2026-11', daysInMonth: 30, checked: [{ date: '2026-11-07', makeup: false }, { date: '2026-11-08', makeup: false }] },
    milestones: [{ days: 3, reward: 5, reached: false }, { days: 7, reward: 10, reached: false }],
    repeatEveryDays: 30,
    nextMilestone: { days: 3, reward: 5 },
    monthlyReward: 20,
    claimable: [],
    makeup: { price: 20, monthlyLimit: 2, usedThisMonth: 0, windowDays: 7, eligibleDates: ['2026-11-06'] },
    ...overrides,
  }
}

function Host() {
  const state = useCheckin()
  return <><CheckinCompact state={state} /><CheckinCard state={state} /></>
}

const renderCard = () => render(<MemoryRouter><Host /></MemoryRouter>)

beforeEach(() => {
  vi.resetAllMocks()
  useAppStore.setState({ toasts: [], islandNotice: null, islandQueue: [], islandNoticeAvailable: false, modalDepth: 0 })
  useAuthStore.setState({
    user: { id: 1, email: 'checkin@test.local', role: 'user', status: 'active', points: 100, merchant: null },
    accessToken: `e30.${btoa(JSON.stringify({ userId: 1, sid: 'checkin-test' }))}.sig`,
    isLoggedIn: true,
  })
})

describe('CheckinCard', () => {
  it('shows the pending streak, next milestone and makeup entry', async () => {
    vi.mocked(getCheckinStatus).mockResolvedValue(status())
    renderCard()

    expect((await screen.findAllByText('已连签 2 天，今天签到不断签')).length).toBe(2)
    expect(screen.getAllByText('再签 1 天，连签 3 天可领 5 积分').length).toBeGreaterThan(0)
    expect(screen.getByTestId('checkin-makeup-2026-11-06')).toBeInTheDocument()
    expect(screen.getByText(/本月剩余 2 次/)).toBeInTheDocument()
  })

  it('checks in, refreshes and celebrates', async () => {
    vi.mocked(getCheckinStatus)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ hasCheckedIn: true, streak: 3, streakState: 'done' }))
    vi.mocked(postCheckin).mockResolvedValue({
      baseReward: 5, bonusReward: 0, totalReward: 5, balanceAfter: 105, streak: 3, newRewards: [],
    })
    renderCard()

    fireEvent.click(await screen.findByTestId('checkin-button'))
    expect(await screen.findByText('今日已签到')).toBeInTheDocument()
    expect(celebrate).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().user?.points).toBe(105)
  })

  it('claims a reward and confirms makeup with the displayed price', async () => {
    const claimable = [{ id: 9, kind: 'streak' as const, milestone: 3, amount: 5, expiresAt: '2026-12-09T00:00:00Z' }]
    vi.mocked(getCheckinStatus).mockResolvedValue(status({ claimable }))
    vi.mocked(claimCheckinReward).mockResolvedValue({ id: 9, amount: 5, balanceAfter: 105, alreadyClaimed: false })
    vi.mocked(postMakeup).mockResolvedValue({ date: '2026-11-06', streak: 3, balanceAfter: 85, newRewards: [] })
    renderCard()

    fireEvent.click((await screen.findAllByTestId('checkin-claim-9'))[0])
    await waitFor(() => expect(claimCheckinReward).toHaveBeenCalledWith(9))
    await waitFor(() => expect(celebrate).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('checkin-makeup-2026-11-06'))
    fireEvent.click(await screen.findByTestId('checkin-makeup-confirm'))
    await waitFor(() => expect(postMakeup).toHaveBeenCalledWith('2026-11-06', 20))
    expect(celebrate).toHaveBeenCalledTimes(1)
  })

  it('keeps only the check-in button when an older backend omits streak details', async () => {
    vi.mocked(getCheckinStatus).mockResolvedValue({ hasCheckedIn: false } as CheckinStatus)
    renderCard()

    expect(await screen.findByTestId('checkin-button')).toBeEnabled()
    expect(screen.queryByTestId('checkin-card')).not.toBeInTheDocument()
  })
})
