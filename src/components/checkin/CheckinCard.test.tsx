import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CheckinCard, { CheckinCompact } from './CheckinCard'
import CheckinModal from './CheckinModal'
import { useCheckin } from '../../hooks/useCheckin'
import { claimCheckinReward, getCheckinHeatmap, getCheckinStatus, postCheckin, postMakeup, type CheckinStatus } from '../../api/checkin'
import { celebrate } from '../../lib/celebrate'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'

vi.mock('../../api/checkin', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/checkin')>(),
  getCheckinStatus: vi.fn(),
  getCheckinHeatmap: vi.fn(),
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
  vi.mocked(getCheckinHeatmap).mockResolvedValue({
    today: '2026-11-09',
    startDate: '2026-06-01',
    weeks: 24,
    summary: { checkinDays: 3, activeDays: 4, longestStreak: 3 },
    days: [
      { date: '2026-11-05', level: 1, active: true, checkedIn: false, makeup: false, streak: 0 },
      { date: '2026-11-07', level: 2, active: true, checkedIn: true, makeup: true, streak: 1 },
      { date: '2026-11-08', level: 3, active: true, checkedIn: true, makeup: false, streak: 2 },
      { date: '2026-11-09', level: 4, active: true, checkedIn: true, makeup: false, streak: 3 },
    ],
  })
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

  it('shows a rolling strip across the month boundary and expands the month on demand', async () => {
    vi.mocked(getCheckinStatus).mockResolvedValue(status({
      today: '2026-11-02',
      month: { key: '2026-11', daysInMonth: 30, checked: [{ date: '2026-11-01', makeup: false }] },
      recent: [{ date: '2026-10-31', makeup: true }, { date: '2026-11-01', makeup: false }],
      makeup: { price: 20, monthlyLimit: 2, usedThisMonth: 1, windowDays: 7, eligibleDates: ['2026-10-30'] },
    }))
    renderCard()

    const strip = await screen.findByTestId('checkin-recent')
    expect(strip.children).toHaveLength(8)
    expect(strip).toHaveTextContent('周六10/31')
    expect(strip.querySelectorAll('[data-checked]')).toHaveLength(2)
    expect(screen.getByTestId('checkin-makeup-2026-10-30')).toHaveTextContent('周五')
    expect(screen.queryByTestId('checkin-calendar')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('checkin-month-toggle'))
    expect(screen.getByTestId('checkin-calendar').querySelectorAll('[data-checked]')).toHaveLength(1)
  })

  it('keeps only the check-in button when an older backend omits streak details', async () => {
    vi.mocked(getCheckinStatus).mockResolvedValue({ hasCheckedIn: false } as CheckinStatus)
    renderCard()

    expect(await screen.findByTestId('checkin-button')).toBeEnabled()
    expect(screen.queryByTestId('checkin-card')).not.toBeInTheDocument()
  })

  it('syncs check-in state across CheckinModal and other consumers', async () => {
    vi.mocked(getCheckinStatus)
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ hasCheckedIn: true, streak: 3, streakState: 'done' }))
    vi.mocked(postCheckin).mockResolvedValue({
      baseReward: 5, bonusReward: 0, totalReward: 5, balanceAfter: 105, streak: 3, newRewards: [],
    })

    function ModalHost() {
      const state = useCheckin()
      return (
        <>
          <span data-testid="nav-state">{state.status?.hasCheckedIn ? 'done' : 'pending'}</span>
          <CheckinModal open onOpenChange={() => {}} state={state} />
        </>
      )
    }

    render(<MemoryRouter initialEntries={['/']}><ModalHost /></MemoryRouter>)

    const modal = await screen.findByTestId('checkin-modal')
    expect(modal.className).toContain('bottom-0')
    expect(modal.className).toContain('sm:left-1/2')
    expect(screen.getByTestId('nav-state')).toHaveTextContent('pending')

    fireEvent.click(await screen.findByTestId('checkin-button'))
    await waitFor(() => expect(screen.getByTestId('nav-state')).toHaveTextContent('done'))
    expect(screen.getByTestId('checkin-button')).toBeDisabled()
    expect(screen.queryByTestId('checkin-heatmap')).not.toBeInTheDocument()
  })

  it('renders the GitHub-style check-in heatmap in Profile CheckinCard and updates cell detail on click', async () => {
    vi.mocked(getCheckinStatus).mockResolvedValue(status())
    renderCard()

    const wall = await screen.findByTestId('checkin-heatmap')
    expect(wall).toBeInTheDocument()
    expect(screen.getByTestId('checkin-heatmap-summary')).toHaveTextContent('签到 3 天')
    expect(screen.getByTestId('checkin-heatmap-summary')).toHaveTextContent('活跃 4 天')
    expect(screen.getByTestId('checkin-heatmap-summary')).toHaveTextContent('最长连签 3 天')

    expect(screen.getByTestId('heatmap-cell-2026-11-05')).toHaveAttribute('data-level', '1')
    expect(screen.getByTestId('heatmap-cell-2026-11-07')).toHaveAttribute('data-level', '2')
    expect(screen.getByTestId('heatmap-cell-2026-11-08')).toHaveAttribute('data-level', '3')
    expect(screen.getByTestId('heatmap-cell-2026-11-09')).toHaveAttribute('data-level', '4')

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-11-05'))
    expect(screen.getByTestId('checkin-heatmap-detail')).toHaveTextContent('2026-11-05')
    expect(screen.getByTestId('checkin-heatmap-detail')).toHaveTextContent('当日登录活跃')

    fireEvent.click(screen.getByTestId('heatmap-cell-2026-11-07'))
    expect(screen.getByTestId('checkin-heatmap-detail')).toHaveTextContent('补签')
  })
})
