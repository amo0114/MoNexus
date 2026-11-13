import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMailSettingsPanel from './AdminMailSettingsPanel'
import * as api from '../../api/adminMail'

vi.mock('../../api/adminMail', () => ({
  getAdminMailSettings: vi.fn(), saveAdminMailDraft: vi.fn(), operateAdminMailSettings: vi.fn(),
}))
const draft = { host: 'smtp.example.com', port: 587, secure: false, from: 'mail@example.com', fromName: 'MoNexus' }
const initial: api.AdminMailSettings = {
  version: 1, activeVersion: 0, source: 'environment', encryptionReady: true,
  draft, bootstrap: null, draftAuthConfigured: true, tested: false, rollbackAvailable: false, updatedAt: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getAdminMailSettings).mockResolvedValue(initial)
  vi.mocked(api.saveAdminMailDraft).mockResolvedValue({ ...initial, version: 2 })
})
async function mount(onActivated = vi.fn()) {
  render(<AdminMailSettingsPanel onActivated={onActivated} />)
  await screen.findByLabelText('SMTP 主机')
  return onActivated
}

describe('business SMTP settings', () => {
  it('preserves hidden credentials on save and clears replacement fields after saving', async () => {
    await mount()
    expect(screen.getByLabelText('SMTP 账号')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(api.saveAdminMailDraft).toHaveBeenCalledWith({ ...draft, expectedVersion: 1 }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('SMTP 账号'), { target: { value: 'new-login' } })
    fireEvent.change(screen.getByLabelText('SMTP 密码'), { target: { value: 'NEW-SECRET-SENTINEL' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(api.saveAdminMailDraft).toHaveBeenLastCalledWith({
      ...draft, expectedVersion: 2, credentials: { user: 'new-login', pass: 'NEW-SECRET-SENTINEL' },
    }))
    await waitFor(() => expect(screen.getByLabelText('SMTP 密码')).toHaveValue(''))
    expect(screen.getByLabelText('SMTP 账号')).toHaveValue('')
  })

  it('requires a successful test of the saved draft before activation and refreshes runtime status', async () => {
    const onActivated = await mount()
    expect(screen.getByRole('button', { name: '激活当前草稿' })).toBeDisabled()
    vi.mocked(api.operateAdminMailSettings).mockResolvedValueOnce({ ...initial, tested: true })
    fireEvent.change(screen.getByLabelText('草稿测试收件地址'), { target: { value: 'ops@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送草稿测试邮件' }))
    await waitFor(() => expect(api.operateAdminMailSettings).toHaveBeenCalledWith('test', 1, 'ops@example.com'))
    await waitFor(() => expect(screen.getByRole('button', { name: '激活当前草稿' })).toBeEnabled())
    expect(screen.getByLabelText('草稿测试收件地址')).toHaveValue('')
    vi.mocked(api.operateAdminMailSettings).mockResolvedValueOnce({ ...initial, source: 'database', version: 2, activeVersion: 1, rollbackAvailable: true })
    fireEvent.click(screen.getByRole('button', { name: '激活当前草稿' }))
    await waitFor(() => expect(onActivated).toHaveBeenCalledOnce())
    expect(screen.getByText(/当前来源：管理员后台/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回滚上一版' })).toBeEnabled()
  })

  it('disables tests and activation while there are unsaved edits', async () => {
    vi.mocked(api.getAdminMailSettings).mockResolvedValue({ ...initial, tested: true })
    await mount()
    fireEvent.change(screen.getByLabelText('SMTP 主机'), { target: { value: 'changed.example.com' } })
    expect(screen.getByRole('button', { name: '发送草稿测试邮件' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '激活当前草稿' })).toBeDisabled()
    expect(api.operateAdminMailSettings).not.toHaveBeenCalled()
  })

  it('keeps failed saves visible and lets the administrator reload after a version conflict', async () => {
    await mount()
    vi.mocked(api.saveAdminMailDraft).mockRejectedValue({ response: { data: { error: { message: '邮件配置已被更新，请重新加载后再操作' } } } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('邮件配置已被更新')
    fireEvent.click(screen.getByRole('button', { name: '重新加载设置' }))
    await waitFor(() => expect(api.getAdminMailSettings).toHaveBeenCalledTimes(2))
  })
})
