import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InviteCard from './InviteCard'
import { createInviteCode, getMyInvites, type InviteCodeRecord, type MyInvitesResponse } from '../../api/invites'
import { copyToClipboard } from '../../utils/clipboard'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import ActionIslandNotice from '../ActionIslandNotice'

vi.mock('../../api/invites', () => ({ getMyInvites: vi.fn(), createInviteCode: vi.fn() }))
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }))

const NEW_CODE: InviteCodeRecord = {
  code: 'NEWCODE2', status: 'active', createdAt: '2026-10-06T00:00:00Z',
  expiresAt: '2026-10-20T00:00:00Z', usedAt: null,
}
const noOp = () => {}
function MobileHost() {
  const notice = useAppStore(s => s.islandNotice)
  return <><InviteCard /><ActionIslandNotice notice={notice?.kind === 'notification' ? notice : null} suppressed={false} onVisibleChange={noOp} /></>
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.resetAllMocks()
  useAppStore.setState({ toasts: [], islandNotice: null, islandQueue: [], islandNoticeAvailable: false, modalDepth: 0 })
  useAuthStore.setState({
    user: { id: 1, email: 'invite@test.local', role: 'user', status: 'active', points: 100, merchant: null },
    accessToken: `e30.${btoa(JSON.stringify({ userId: 1, sid: 'invite-test' }))}.sig`,
    isLoggedIn: true,
  })
  vi.mocked(createInviteCode).mockResolvedValue(NEW_CODE)
  vi.mocked(getMyInvites).mockResolvedValue({
    eligible: true,
    quota: null,
    codes: [{
      code: 'TEST-INVITE',
      status: 'active',
      createdAt: '2026-10-05T00:00:00Z',
      expiresAt: '2026-11-05T00:00:00Z',
      usedAt: null,
    }],
  })
})

describe('InviteCard clipboard feedback', () => {
  it.each([
    ['复制邀请码', 'TEST-INVITE', '邀请码已复制', true],
    ['复制邀请码', 'TEST-INVITE', '复制失败，请手动复制', false],
    ['复制邀请链接', `${window.location.origin}/i/TEST-INVITE`, '邀请链接已复制', true],
    ['复制邀请链接', `${window.location.origin}/i/TEST-INVITE`, '复制失败，请手动复制', false],
  ] as const)('%s copies %s and reports "%s" (success=%s)', async (title, value, message, copied) => {
    let complete!: (result: boolean) => void
    vi.mocked(copyToClipboard).mockReturnValue(new Promise<boolean>((resolve) => { complete = resolve }))
    render(<InviteCard />)

    fireEvent.click(await screen.findByTitle(title))
    expect(copyToClipboard).toHaveBeenCalledWith(value)
    expect(useAppStore.getState().toasts).toHaveLength(0)

    await act(async () => { complete(copied) })
    expect(useAppStore.getState().toasts).toEqual([expect.objectContaining({ message, type: copied ? 'success' : 'error' })])
  })
})

describe('mobile invitation completion', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
    useAppStore.setState({ islandNoticeAvailable: true })
  })

  it('waits for generation, prevents double submission and copies the NEW link only on island action', async () => {
    let complete!: (code: InviteCodeRecord) => void
    vi.mocked(createInviteCode).mockReturnValue(new Promise(resolve => { complete = resolve }))
    vi.mocked(copyToClipboard).mockResolvedValue(true)
    render(<MobileHost />)
    const generate = await screen.findByRole('button', { name: '生成新码' })
    act(() => { fireEvent.click(generate); fireEvent.click(generate) })
    expect(createInviteCode).toHaveBeenCalledOnce()
    expect(generate).toBeDisabled()
    expect(useAppStore.getState().islandNotice).toBeNull()
    await act(async () => complete(NEW_CODE))
    expect(screen.getByText('NEWCODE2')).toBeInTheDocument()
    expect(screen.getByTestId('action-island-notice')).toHaveTextContent('邀请码已生成')
    expect(copyToClipboard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '复制邀请链接', exact: true }))
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/i/NEWCODE2`))
    expect(useAppStore.getState().islandNotice?.message).toBe('邀请链接已复制')
  })

  it('keeps the generated code available for retry when copying from the island fails', async () => {
    vi.mocked(copyToClipboard).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<MobileHost />)
    fireEvent.click(await screen.findByRole('button', { name: '生成新码' }))
    fireEvent.click(await screen.findByRole('button', { name: '复制邀请链接', exact: true }))
    await waitFor(() => expect(useAppStore.getState().toasts).toEqual([expect.objectContaining({ message: '复制失败，请手动复制', type: 'error' })]))
    expect(screen.getByText('NEWCODE2')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTitle('复制邀请链接')[0])
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(2))
    expect(copyToClipboard).toHaveBeenLastCalledWith(`${window.location.origin}/i/NEWCODE2`)
    expect(useAppStore.getState().islandNotice?.message).toBe('邀请链接已复制')
  })

  it('keeps the list and retry available after generation fails', async () => {
    vi.mocked(createInviteCode).mockRejectedValueOnce({ response: { data: { error: { message: '生成失败，请重试' } } } })
    render(<InviteCard />)
    const generate = await screen.findByRole('button', { name: '生成新码' })
    fireEvent.click(generate)
    await waitFor(() => expect(generate).toBeEnabled())
    expect(screen.getByText('TEST-INVITE')).toBeInTheDocument()
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(useAppStore.getState().toasts[0]?.message).toBe('生成失败，请重试')
    fireEvent.click(generate)
    await screen.findByText('NEWCODE2')
    expect(useAppStore.getState().islandNotice?.title).toBe('邀请码已生成')
  })

  it('uses up the last generation allowance without removing the new code', async () => {
    vi.mocked(getMyInvites).mockResolvedValue({ eligible: true, quota: { limit: 1, used: 0, remaining: 1, periodKey: 'M2026-10' }, codes: [] })
    render(<InviteCard />)
    fireEvent.click(await screen.findByRole('button', { name: '立即生成邀请码' }))
    await screen.findByText('NEWCODE2')
    expect(screen.queryByRole('button', { name: '生成新码' })).toBeNull()
    expect(useAppStore.getState().islandNotice?.actionLabel).toBe('复制邀请链接')
  })

  it('discards pending generation and old list data after changing session', async () => {
    let complete!: (code: InviteCodeRecord) => void
    vi.mocked(createInviteCode).mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<InviteCard />)
    fireEvent.click(await screen.findByRole('button', { name: '生成新码' }))
    vi.mocked(getMyInvites).mockResolvedValue({ eligible: false, quota: null, codes: [] })
    act(() => useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 }))
    await act(async () => complete(NEW_CODE))
    expect(screen.queryByText('TEST-INVITE')).toBeNull()
    expect(screen.queryByText('NEWCODE2')).toBeNull()
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('does not overwrite a new session with an old initial list response', async () => {
    let complete!: (data: MyInvitesResponse) => void
    vi.mocked(getMyInvites).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    render(<InviteCard />)
    vi.mocked(getMyInvites).mockResolvedValue({ eligible: false, quota: null, codes: [] })
    act(() => useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 }))
    await screen.findByText('暂无可用邀请码')
    await act(async () => complete({ eligible: true, quota: null, codes: [NEW_CODE] }))
    expect(screen.queryByText('NEWCODE2')).toBeNull()
    expect(screen.queryByRole('button', { name: '生成新码' })).toBeNull()
  })

  it('prevents an old island action from copying after a session change', async () => {
    render(<InviteCard />)
    fireEvent.click(await screen.findByRole('button', { name: '生成新码' }))
    await screen.findByText('NEWCODE2')
    const action = useAppStore.getState().islandNotice?.onAction
    await act(async () => useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 }))
    act(() => action?.())
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('discards clipboard feedback after a session change', async () => {
    let complete!: (copied: boolean) => void
    vi.mocked(copyToClipboard).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
    render(<InviteCard />)
    fireEvent.click(await screen.findByTitle('复制邀请链接'))
    act(() => useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 }))
    await act(async () => complete(true))
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('keeps desktop completion as the original toast', async () => {
    vi.mocked(window.matchMedia).mockImplementation(media => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
    render(<InviteCard />)
    fireEvent.click(await screen.findByRole('button', { name: '生成新码' }))
    await screen.findByText('NEWCODE2')
    expect(useAppStore.getState().toasts).toEqual([expect.objectContaining({ message: '邀请码已生成', type: 'success' })])
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(copyToClipboard).not.toHaveBeenCalled()
  })
})
