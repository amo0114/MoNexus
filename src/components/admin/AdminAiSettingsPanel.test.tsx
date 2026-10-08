import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminAiSettingsPanel from './AdminAiSettingsPanel'
import * as api from '../../api/adminAi'

vi.mock('../../api/adminAi', () => ({ getAdminAiSettings: vi.fn(), updateAdminAiSettings: vi.fn(), testAdminAiConnection: vi.fn() }))

const initial: api.AdminAiSettings = {
  chatTokenParameter: 'max_tokens', protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none',
  version: 4, source: 'database', enabled: false, productCopilotEnabled: false,
  merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', merchantWorkbenchEnabled: false,
  apiKeyConfigured: true, apiKeyLast4: '1234', credentialError: false, encryptionReady: true, model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1',
}
const KEY = 'sk-ui-SECRET_SENTINEL_123456'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getAdminAiSettings).mockResolvedValue(initial)
  vi.mocked(api.updateAdminAiSettings).mockResolvedValue({ ...initial, version: 5 })
})

async function mount() {
  render(<AdminAiSettingsPanel />)
  await screen.findByLabelText('API Key')
}

describe('Admin AI settings', () => {
  it('exposes the token parameter only for Chat and saves the chosen wire field', async () => {
    await mount()
    expect(screen.queryByLabelText('输出长度参数（Chat）')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('接口协议'), { target: { value: 'openai_chat' } })
    fireEvent.change(screen.getByLabelText('输出长度参数（Chat）'), { target: { value: 'max_completion_tokens' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai_chat', chatTokenParameter: 'max_completion_tokens', model: initial.model, baseUrl: initial.baseUrl,
    })))
  })
  it.each(['openai_chat', 'anthropic_messages'] as const)('saves %s without substituting the gateway or model alias', async protocol => {
    await mount()
    fireEvent.change(screen.getByLabelText('接口协议'), { target: { value: protocol } })
    fireEvent.change(screen.getByLabelText('结构化输出'), { target: { value: 'json_object' } })
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'my-gateway/deepseek-flash-custom' } })
    expect(screen.getByLabelText('API 地址（Base URL）')).toHaveValue(initial.baseUrl)
    expect(screen.getByLabelText('推理参数')).toHaveValue('default')
    expect(screen.getByRole('button', { name: '测试已保存的连接' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith({
      expectedVersion: 4, chatTokenParameter: 'max_tokens', protocol, outputMode: 'json_object', reasoningMode: 'default', baseUrl: initial.baseUrl,
      model: 'my-gateway/deepseek-flash-custom', enabled: false, productCopilotEnabled: false,
      merchantAgentEnabled: false, merchantAgentReasoningMode: 'default',
    }))
  })
  it('shows only the suffix, preserves an untouched key, and sends the current version', async () => {
    await mount()
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByText(/已配置 · ••••1234/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('AI 总开关'))
    fireEvent.click(screen.getByLabelText('商品 Copilot（新建与说明整理）'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith({ chatTokenParameter: 'max_tokens', protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none', merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', expectedVersion: 4, baseUrl: initial.baseUrl, model: initial.model, enabled: true, productCopilotEnabled: true }))
  })

  it('replaces a key without persisting it locally and clears the field after saving', async () => {
    await mount()
    const local = vi.spyOn(Storage.prototype, 'setItem')
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: KEY } })
    expect(screen.getByRole('button', { name: '测试已保存的连接' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith({ chatTokenParameter: 'max_tokens', protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none', merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', expectedVersion: 4, baseUrl: initial.baseUrl, model: initial.model, enabled: false, productCopilotEnabled: false, apiKey: KEY }))
    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue(''))
    expect(local.mock.calls.some(call => call.some(value => String(value).includes(KEY)))).toBe(false)
    local.mockRestore()
  })

  it('clears a configured key explicitly and disables both flags in the same save', async () => {
    vi.mocked(api.getAdminAiSettings).mockResolvedValue({ ...initial, enabled: true, productCopilotEnabled: true })
    await mount()
    fireEvent.click(screen.getByLabelText('清除已保存密钥，同时关闭 AI'))
    expect(screen.getByLabelText('AI 总开关')).not.toBeChecked()
    expect(screen.getByLabelText('商品 Copilot（新建与说明整理）')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith({ chatTokenParameter: 'max_tokens', protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none', merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', expectedVersion: 4, baseUrl: initial.baseUrl, model: initial.model, enabled: false, productCopilotEnabled: false, apiKey: null }))
  })

  it('tests the saved version once, shows the result and prevents concurrent saves', async () => {
    let finish!: (value: api.AdminAiTestResult) => void
    vi.mocked(api.testAdminAiConnection).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: '测试已保存的连接' }))
    expect(screen.getByRole('button', { name: '正在测试…' })).toBeDisabled()
    expect(screen.getByLabelText('AI 总开关')).toBeDisabled()
    expect(api.testAdminAiConnection).toHaveBeenCalledExactlyOnceWith(4)
    finish({ ok: false, code: 'unauthorized', message: 'API Key 无效或已失效，请更换密钥。', testedVersion: 4, latencyMs: 120 })
    await screen.findByText(/API Key 无效或已失效/)
  })

  it('keeps a conflict visible, clears submitted credentials and permits a reload', async () => {
    vi.mocked(api.updateAdminAiSettings).mockRejectedValue({ response: { data: { error: { code: 'CONFLICT', message: 'AI 配置已更新，请重新加载' } } } })
    await mount()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await screen.findByText('AI 配置已更新，请重新加载')
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    vi.mocked(api.getAdminAiSettings).mockResolvedValue({ ...initial, version: 8 })
    fireEvent.click(screen.getByRole('button', { name: '重新加载 AI 配置' }))
    await waitFor(() => expect(screen.queryByText('AI 配置已更新，请重新加载')).not.toBeInTheDocument())
  })

  it('blocks credential writes without server encryption and can retry a failed load', async () => {
    vi.mocked(api.getAdminAiSettings).mockRejectedValueOnce(new Error('offline'))
    render(<AdminAiSettingsPanel />)
    await screen.findByText('AI 配置加载失败')
    vi.mocked(api.getAdminAiSettings).mockResolvedValue({ ...initial, encryptionReady: false })
    fireEvent.click(screen.getByRole('button', { name: '重新加载 AI 配置' }))
    await screen.findByText(/服务器需先配置加密主密钥/)
    expect(screen.getByLabelText('API Key')).toBeDisabled()
  })

  it('requires a replacement key when changing the endpoint and saves the custom model', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('API 地址（Base URL）'), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'vendor/model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await screen.findByText('更换 API 地址时，请同时填写该服务的 API Key，或清除旧密钥。')
    expect(api.updateAdminAiSettings).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenCalledWith({
      chatTokenParameter: 'max_tokens', protocol: 'openai_responses', outputMode: 'json_schema', reasoningMode: 'none', merchantAgentEnabled: false, merchantAgentReasoningMode: 'default', expectedVersion: 4, baseUrl: 'https://gateway.example/v1', model: 'vendor/model', enabled: false, productCopilotEnabled: false, apiKey: KEY,
      merchantAgentEnabled: false, merchantAgentReasoningMode: 'default',
    }))
  })
})

describe('merchant operations agent settings', () => {
  it('saves the agent switch and its own reasoning mode, and drops the agent when AI is turned off', async () => {
    const loaded = { ...initial, enabled: true, merchantWorkbenchEnabled: true }
    vi.mocked(api.getAdminAiSettings).mockResolvedValue(loaded)
    vi.mocked(api.updateAdminAiSettings).mockResolvedValue({ ...loaded, version: 5, merchantAgentEnabled: true, merchantAgentReasoningMode: 'none' })
    render(<AdminAiSettingsPanel />)
    const agent = await screen.findByLabelText('商家经营助手')
    expect(screen.getByTestId('admin-ai-agent-dependency')).toHaveTextContent('当前已开启')
    fireEvent.click(agent)
    fireEvent.change(screen.getByLabelText('经营助手推理参数'), { target: { value: 'none' } })
    expect(screen.getByLabelText('推理参数')).toHaveValue('none')
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))
    await waitFor(() => expect(api.updateAdminAiSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true, productCopilotEnabled: false, reasoningMode: 'none', merchantAgentEnabled: true, merchantAgentReasoningMode: 'none',
    })))

    await waitFor(() => expect(screen.getByLabelText('商家经营助手')).toBeChecked())
    fireEvent.click(screen.getByLabelText('AI 总开关'))
    expect(screen.getByLabelText('商家经营助手')).not.toBeChecked()
    expect(screen.getByLabelText('商家经营助手')).toBeDisabled()
  })

  it('states that the workbench dependency is off and needs a backend restart', async () => {
    render(<AdminAiSettingsPanel />)
    expect(await screen.findByTestId('admin-ai-agent-dependency')).toHaveTextContent('当前未开启')
    expect(screen.getByTestId('admin-ai-agent-dependency')).toHaveTextContent('重启后端')
    expect(screen.getByLabelText('商家经营助手')).toBeDisabled()
  })
})
