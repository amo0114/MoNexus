import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InviteCard from './InviteCard'
import { getMyInvites } from '../../api/invites'
import { copyToClipboard } from '../../utils/clipboard'

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (state: { showToast: typeof showToast }) => unknown) => selector({ showToast }),
}))
vi.mock('../../api/invites', () => ({ getMyInvites: vi.fn(), createInviteCode: vi.fn() }))
vi.mock('../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(showToast).not.toHaveBeenCalled()

    await act(async () => { complete(copied) })
    expect(showToast).toHaveBeenCalledExactlyOnceWith(message, copied ? 'success' : 'error')
  })
})
