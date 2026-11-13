import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminShortlinkSettingsPanel from './AdminShortlinkSettingsPanel'
import * as api from '../../api/adminIntegrations'

vi.mock('../../api/adminIntegrations', () => ({ getShortlinkSettings: vi.fn(), saveShortlinkDraft: vi.fn(), operateShortlinkSettings: vi.fn() }))
const draft = { apiBaseUrl: 'https://short-admin.example.com', publicOrigin: 'https://s.example.com', groupId: 'group-a' }
const initial: api.ShortlinkAdminSettings = {
  version: 1, activeRevisionId: null, source: 'environment', enabled: true, encryptionReady: true,
  draft, bootstrap: null, credentialsConfigured: true, tested: false, rollbackAvailable: false, updatedAt: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getShortlinkSettings).mockResolvedValue(initial)
  vi.mocked(api.saveShortlinkDraft).mockResolvedValue({ ...initial, version: 2 })
})
async function mount() { render(<AdminShortlinkSettingsPanel />); await screen.findByLabelText('短链 API 地址') }
describe('admin shortlink settings', () => {
  it('preserves hidden credentials and clears replacements after saving', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '保存短链草稿' }))
    await waitFor(() => expect(api.saveShortlinkDraft).toHaveBeenCalledWith({ ...draft, expectedVersion: 1 }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存短链草稿' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('短链账号'), { target: { value: 'replacement-user' } })
    fireEvent.change(screen.getByLabelText('短链密码'), { target: { value: 'replacement-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存短链草稿' }))
    await waitFor(() => expect(api.saveShortlinkDraft).toHaveBeenLastCalledWith({ ...draft, expectedVersion: 2, credentials: { username: 'replacement-user', password: 'replacement-secret' } }))
    await waitFor(() => expect(screen.getByLabelText('短链密码')).toHaveValue(''))
  })
  it('requires login probe before activation and blocks probing unsaved edits', async () => {
    await mount()
    expect(screen.getByRole('button', { name: '激活短链草稿' })).toBeDisabled()
    vi.mocked(api.operateShortlinkSettings).mockResolvedValueOnce({ ...initial, tested: true })
    fireEvent.click(screen.getByRole('button', { name: '探测短链登录' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '激活短链草稿' })).toBeEnabled())
    expect(screen.getByText(/不能证明分组与创建接口的权限/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('短链分组'), { target: { value: 'changed' } })
    expect(screen.getByRole('button', { name: '激活短链草稿' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '探测短链登录' })).toBeDisabled()
  })
  it('preserves unsaved edits when stopping new links and cannot activate without the current root', async () => {
    vi.mocked(api.getShortlinkSettings).mockResolvedValue({ ...initial, encryptionReady: false, tested: true })
    await mount()
    expect(screen.getByRole('button', { name: '激活短链草稿' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('短链分组'), { target: { value: 'unsaved-group' } })
    fireEvent.change(screen.getByLabelText('短链密码'), { target: { value: 'unsaved-password' } })
    vi.mocked(api.operateShortlinkSettings).mockResolvedValueOnce({ ...initial, version: 2, enabled: false })
    fireEvent.click(screen.getByRole('button', { name: '停止新建短链' }))
    await screen.findByRole('button', { name: '允许新建短链' })
    expect(screen.getByLabelText('短链分组')).toHaveValue('unsaved-group')
    expect(screen.getByLabelText('短链密码')).toHaveValue('unsaved-password')
  })
  it('stops new creation separately and exposes reload after a conflict', async () => {
    await mount()
    vi.mocked(api.operateShortlinkSettings).mockResolvedValueOnce({ ...initial, version: 2, enabled: false })
    fireEvent.click(screen.getByRole('button', { name: '停止新建短链' }))
    await waitFor(() => expect(api.operateShortlinkSettings).toHaveBeenCalledWith('enabled', 1, false))
    await screen.findByRole('button', { name: '允许新建短链' })
    vi.mocked(api.saveShortlinkDraft).mockRejectedValue({ response: { data: { error: { message: '配置已被更新' } } } })
    fireEvent.click(screen.getByRole('button', { name: '保存短链草稿' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('配置已被更新')
    fireEvent.click(screen.getByRole('button', { name: '重新加载短链设置' }))
    await waitFor(() => expect(api.getShortlinkSettings).toHaveBeenCalledTimes(2))
  })
})
