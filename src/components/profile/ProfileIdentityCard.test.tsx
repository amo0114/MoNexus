import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProfileIdentityCard from './ProfileIdentityCard'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { AVATAR_PRESETS } from '../../lib/avatarPresets'
import { changePassword, sendVerificationEmail, updateMe } from '../../api/auth'
import { uploadImage } from '../../api/uploads'

vi.mock('../../api/auth', () => ({ updateMe: vi.fn(), changePassword: vi.fn(), sendVerificationEmail: vi.fn() }))
vi.mock('../../api/uploads', () => ({ uploadImage: vi.fn(), UploadError: class extends Error {} }))

const user = { id: 7, email: 'avatar@test.local', nickname: '测试用户', avatarUrl: null, role: 'user' as const, status: 'active', points: 20, merchant: null }
const zhao = AVATAR_PRESETS.find((a) => a.id === 'shu-zhao-yun')!

function createSessionToken() {
  const payload = btoa(JSON.stringify({
    userId: user.id,
    sid: 'profile-identity-card-session',
    exp: Math.floor(Date.now() / 1000) + 60,
  }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${payload}.signature`
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useAuthStore.setState({
    user: { ...user },
    accessToken: createSessionToken(),
    sessionId: 'profile-identity-card-session',
    isLoggedIn: true,
    authEpoch: 1,
  })
  useAppStore.setState({ toasts: [] })
})

describe('profile pending actions', () => {
  it('does not log out a newer session when an old password change completes', async () => {
    let resolve!: () => void
    vi.mocked(changePassword).mockReturnValueOnce(new Promise((done) => { resolve = () => done({ message: 'ok' }) }))
    render(<ProfileIdentityCard />)
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('新密码（至少 6 位）'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }))
    expect(changePassword).toHaveBeenCalledOnce()
    act(() => useAuthStore.setState({ sessionId: 'new-session', authEpoch: 2 }))
    await act(async () => resolve())
    expect(useAuthStore.getState().isLoggedIn).toBe(true)
    expect(useAuthStore.getState().sessionId).toBe('new-session')
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('does not apply an old verification response to a newer session', async () => {
    let resolve!: () => void
    vi.mocked(sendVerificationEmail).mockReturnValueOnce(new Promise((done) => { resolve = () => done({ ok: true }) }))
    render(<ProfileIdentityCard />)
    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(sendVerificationEmail).toHaveBeenCalledOnce()
    act(() => useAuthStore.setState({ sessionId: 'new-session', authEpoch: 2 }))
    await act(async () => resolve())
    expect(screen.getByRole('button', { name: '发送验证邮件' })).toBeEnabled()
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('retains the nickname draft after a failed save and allows retry', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(updateMe).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
      .mockResolvedValueOnce({ ...user, nickname: '新昵称' })
    render(<ProfileIdentityCard />)
    fireEvent.click(screen.getByTestId('nickname-edit'))
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新昵称' } })
    fireEvent.click(screen.getByTestId('nickname-save'))
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    fireEvent.click(screen.getByTestId('nickname-save'))
    expect(updateMe).toHaveBeenCalledTimes(1)
    await act(async () => reject(new Error('network')))
    expect(screen.getByLabelText('昵称')).toHaveValue('新昵称')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByLabelText('昵称')).toBeNull())
    expect(useAuthStore.getState().user?.nickname).toBe('新昵称')
  })

  it('keeps password feedback visible during submission and exposes server errors', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(changePassword).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    render(<ProfileIdentityCard />)
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('新密码（至少 6 位）'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }))
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '收起表单' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(changePassword).toHaveBeenCalledOnce()
    await act(async () => reject(new Error('network')))
    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('修改密码失败')
    expect(screen.getByLabelText('当前密码')).toHaveAttribute('aria-describedby', error.id)
    expect(screen.getByRole('button', { name: '确认修改' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('当前密码')).toBeNull()
  })

  it('keeps email resend disabled after pending switches to cooldown', async () => {
    let resolve!: () => void
    vi.mocked(sendVerificationEmail).mockReturnValueOnce(new Promise((done) => { resolve = () => done({ ok: true }) }))
    render(<ProfileIdentityCard />)
    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled()
    await act(async () => resolve())
    expect(screen.getByRole('button', { name: '60s 后可重发' })).toBeDisabled()
    expect(sendVerificationEmail).toHaveBeenCalledOnce()
  })

  it('shows upload progress without requiring hover', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(uploadImage).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    render(<ProfileIdentityCard />)
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [new File(['img'], 'avatar.png', { type: 'image/png' })] } })
    const avatar = screen.getByTestId('avatar-edit')
    expect(avatar).toHaveAttribute('aria-busy', 'true')
    expect(avatar.querySelector('span.absolute')).toHaveClass('opacity-100')
    expect(avatar).toBeDisabled()
    await act(async () => reject(new Error('network')))
    expect(avatar).toHaveAttribute('aria-busy', 'false')
    expect(avatar).toBeEnabled()
  })
})

describe('profile avatar selection', () => {
  it('previews across factions, saves only on confirmation, and keeps the persisted selection when reopened', async () => {
    const clicker = userEvent.setup()
    vi.mocked(updateMe).mockResolvedValue({ ...user, avatarUrl: zhao.url })
    render(<ProfileIdentityCard />)
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    expect(screen.getAllByRole('button', { name: /^选择.+/ })).toHaveLength(8)
    await clicker.click(screen.getByRole('tab', { name: '蜀汉' }))
    await clicker.click(screen.getByRole('button', { name: '选择赵云' }))
    expect(updateMe).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.avatarUrl).toBeNull()
    await clicker.click(screen.getByRole('button', { name: '使用此头像' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateMe).toHaveBeenCalledWith({ avatarUrl: zhao.url })
    expect(uploadImage).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.avatarUrl).toBe(zhao.url)
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    expect(screen.getByRole('tab', { name: '蜀汉' })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('button', { name: '选择赵云' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '使用此头像' })).toBeDisabled()
  })

  it('keeps the old avatar on failure, preserves the draft, and allows retry', async () => {
    const clicker = userEvent.setup()
    vi.mocked(updateMe).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ...user, avatarUrl: zhao.url })
    render(<ProfileIdentityCard />)
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    await clicker.click(screen.getByRole('tab', { name: '蜀汉' }))
    await clicker.click(screen.getByRole('button', { name: '选择赵云' }))
    await clicker.click(screen.getByRole('button', { name: '使用此头像' }))
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1))
    expect(useAuthStore.getState().user?.avatarUrl).toBeNull()
    expect(screen.getByRole('button', { name: '选择赵云' })).toHaveAttribute('aria-pressed', 'true')
    await clicker.click(screen.getByRole('button', { name: '使用此头像' }))
    await waitFor(() => expect(useAuthStore.getState().user?.avatarUrl).toBe(zhao.url))
  })

  it('dismisses without saving and retains upload and clear support', async () => {
    const clicker = userEvent.setup()
    const url = 'https://files.example/uploads/avatar.webp'
    vi.mocked(uploadImage).mockResolvedValue({ url, key: 'uploads/avatar.webp' })
    vi.mocked(updateMe).mockResolvedValueOnce({ ...user, avatarUrl: url }).mockResolvedValueOnce({ ...user, avatarUrl: null })
    render(<ProfileIdentityCard />)
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    await clicker.click(screen.getByRole('button', { name: '选择曹操' }))
    await clicker.keyboard('{Escape}')
    expect(updateMe).not.toHaveBeenCalled()
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    await clicker.click(screen.getByRole('button', { name: '上传图片' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const file = new File(['image'], 'avatar.webp', { type: 'image/webp' })
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [file] } })
    await waitFor(() => expect(useAuthStore.getState().user?.avatarUrl).toBe(url))
    expect(uploadImage).toHaveBeenCalledWith(file)
    await clicker.click(screen.getByRole('button', { name: '清除头像' }))
    await waitFor(() => expect(useAuthStore.getState().user?.avatarUrl).toBeNull())
    expect(updateMe).toHaveBeenLastCalledWith({ avatarUrl: null })
  })

  it('blocks duplicate saves and dismissal while saving', async () => {
    const clicker = userEvent.setup()
    let complete!: (value: typeof user) => void
    vi.mocked(updateMe).mockReturnValue(new Promise((resolve) => { complete = resolve }))
    render(<ProfileIdentityCard />)
    await clicker.click(screen.getByRole('button', { name: '选择头像' }))
    await clicker.click(screen.getByRole('button', { name: '选择曹操' }))
    await clicker.click(screen.getByRole('button', { name: '使用此头像' }))
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    await clicker.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(updateMe).toHaveBeenCalledTimes(1)
    complete(user)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
