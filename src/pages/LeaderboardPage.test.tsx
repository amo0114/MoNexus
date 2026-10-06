import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLeaderboard, type LeaderboardResponse } from '../api/leaderboard'
import { AVATAR_PRESETS } from '../lib/avatarPresets'
import LeaderboardPage from './LeaderboardPage'
import { useAuthStore } from '../stores/authStore'

vi.mock('../api/leaderboard', () => ({ getLeaderboard: vi.fn() }))
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))
vi.mock('../stores/appStore', () => ({
  useAppStore: Object.assign((selector: (s: { tabbarHidden: boolean }) => unknown) => selector({ tabbarHidden: false }), {
    getState: () => ({ showToast }),
  }),
}))

function board(overrides: Partial<LeaderboardResponse> = {}): LeaderboardResponse {
  return {
    scope: 'total', periodKey: 'ALL', periodLabel: '全部', dataThrough: '2026-06-01', updatedAt: '2026-06-01T01:02:03.000Z',
    top: Array.from({ length: 4 }, (_, i) => ({
      rank: i + 1, displayName: `选手${i + 1}`, avatarUrl: AVATAR_PRESETS[i].url,
      points: 100 - i, isMe: i === 0, prevRank: i + 1,
    })),
    me: { rank: 1, points: 100, prevRank: 1 }, ...overrides,
  }
}

async function open() {
  await act(async () => { render(<MemoryRouter><LeaderboardPage /></MemoryRouter>) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAuthStore.setState({ authEpoch: 1 })
  vi.mocked(getLeaderboard).mockResolvedValue(board())
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('LeaderboardPage current periods and identity', () => {
  it('shows server avatars in both podium and rows, and an explicit Beijing cutoff', async () => {
    await open()
    expect(screen.getByTestId('leaderboard-podium-1').querySelector('img')).toHaveAttribute('src', AVATAR_PRESETS[0].url)
    expect(screen.getByTestId('leaderboard-row').querySelector('img')).toHaveAttribute('src', AVATAR_PRESETS[3].url)
    expect(screen.getByText('截至 2026-06-01 09:02:03（北京时间） · 每分钟更新')).toBeInTheDocument()
    expect(screen.queryByText(/每日更新/)).not.toBeInTheDocument()
  })

  it('refreshes a visible page each minute and stops after unmount', async () => {
    await open()
    vi.mocked(getLeaderboard).mockResolvedValue(board({ updatedAt: '2026-06-01T01:03:03.000Z' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getLeaderboard).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/09:03:03（北京时间）/)).toBeInTheDocument()
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getLeaderboard).toHaveBeenCalledTimes(2)
  })

  it('pauses hidden polling and refreshes on returning to the tab', async () => {
    await open()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(getLeaderboard).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(getLeaderboard).toHaveBeenCalledTimes(2)
  })

  it('does not claim every empty week is a new week or requires waiting until tomorrow', async () => {
    await open()
    vi.mocked(getLeaderboard).mockResolvedValue(board({ scope: 'week', periodKey: 'W2026-06-01', top: [], me: null }))
    await act(async () => { fireEvent.click(screen.getByTestId('leaderboard-tab-week')) })
    expect(within(screen.getByTestId('leaderboard-empty')).getByText('本周还没有人上榜')).toBeInTheDocument()
    expect(screen.queryByText(/明天见分晓|新的一周刚开始/)).not.toBeInTheDocument()
    expect(screen.getByText(/本周一 00:00 起累计/)).toBeInTheDocument()
  })

  it('preserves the original cutoff on a background failure and recovers on manual refresh', async () => {
    await open()
    vi.mocked(getLeaderboard).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByText(/更新失败，暂时显示上次结果/)).toBeInTheDocument()
    expect(screen.getByText(/09:02:03（北京时间）/)).toBeInTheDocument()
    expect(screen.getByTestId('leaderboard-podium')).toBeInTheDocument()
    vi.mocked(getLeaderboard).mockResolvedValue(board({ updatedAt: '2026-06-01T01:04:03.000Z' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新', exact: true })) })
    expect(screen.queryByText(/更新失败/)).not.toBeInTheDocument()
    expect(screen.getByText(/09:04:03（北京时间）/)).toBeInTheDocument()
  })

  it('ignores an older scope response arriving after a new scope', async () => {
    let resolveTotal!: (value: LeaderboardResponse) => void
    vi.mocked(getLeaderboard).mockReturnValueOnce(new Promise(resolve => { resolveTotal = resolve }))
    await open()
    vi.mocked(getLeaderboard).mockResolvedValue(board({ scope: 'week', periodKey: 'W2026-06-01', periodLabel: '2026-06-01 ~ 2026-06-07' }))
    await act(async () => { fireEvent.click(screen.getByTestId('leaderboard-tab-week')) })
    await act(async () => { resolveTotal(board({ top: [] })) })
    expect(screen.getByText('2026-06-01 ~ 2026-06-07')).toBeInTheDocument()
    expect(screen.getByTestId('leaderboard-podium')).toBeInTheDocument()
    expect(screen.queryByTestId('leaderboard-empty')).not.toBeInTheDocument()
  })

  it('discards the previous session response when the signed-in account changes', async () => {
    let resolveOld!: (value: LeaderboardResponse) => void
    vi.mocked(getLeaderboard).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    await open()
    vi.mocked(getLeaderboard).mockResolvedValue(board({ top: [], me: null }))
    await act(async () => { useAuthStore.setState({ authEpoch: 2 }) })
    await act(async () => { resolveOld(board()) })
    expect(screen.getByTestId('leaderboard-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('leaderboard-podium')).not.toBeInTheDocument()
  })
})
