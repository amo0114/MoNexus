import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProfileIdentityCard from './ProfileIdentityCard'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { AVATAR_PRESETS } from '../../lib/avatarPresets'
import { updateMe } from '../../api/auth'
import { uploadImage } from '../../api/uploads'

vi.mock('../../api/auth', () => ({ updateMe: vi.fn() }))
vi.mock('../../api/uploads', () => ({ uploadImage: vi.fn(), UploadError: class extends Error {} }))

const user = { id: 7, email: 'avatar@test.local', nickname: '测试用户', avatarUrl: null, role: 'user' as const, status: 'active', points: 20, merchant: null }
const zhao = AVATAR_PRESETS.find((a) => a.id === 'shu-zhao-yun')!

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ user: { ...user }, isLoggedIn: true })
  useAppStore.setState({ toasts: [] })
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
