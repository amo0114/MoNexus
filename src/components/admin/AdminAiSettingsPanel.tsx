import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getAdminAiSettings, updateAdminAiSettings, testAdminAiConnection,
  type AdminAiSettings, type AdminAiTestResult, type UpdateAdminAiSettings,
} from '../../api/adminAi'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

export default function AdminAiSettingsPanel() {
  const showToast = useAppStore(s => s.showToast)
  const [settings, setSettings] = useState<AdminAiSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [copilotEnabled, setCopilotEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  // Credentials live only in this form's memory, never in persistent or shared state.
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState<AdminAiTestResult | null>(null)

  function acceptSettings(value: AdminAiSettings) {
    setSettings(value)
    setEnabled(value.enabled)
    setCopilotEnabled(value.productCopilotEnabled)
    setBaseUrl(value.baseUrl)
    setModel(value.model)
    setApiKey('')
    setClearKey(false)
    setError('')
    setTestResult(null)
  }

  async function load() {
    setLoading(true)
    setLoadError(false)
    try { acceptSettings(await getAdminAiSettings()) }
    catch { setLoadError(true) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || busyRef.current) return
    const key = apiKey.trim()
    if (key && !/^[A-Za-z0-9_-]{16,512}$/.test(key)) {
      setError('请输入完整的 API Key，不能填写掩码。')
      return
    }
    if (enabled && !clearKey && !key && (!settings.apiKeyConfigured || settings.credentialError)) {
      setError('请先填写可用的 API Key。')
      return
    }
    if (baseUrl.trim().replace(/\/+$/, '') !== settings.baseUrl && settings.apiKeyConfigured && !clearKey && !key) {
      setError('更换 API 地址时，请同时填写该服务的 API Key，或清除旧密钥。')
      return
    }
    busyRef.current = true
    setBusy('save')
    setError('')
    const input: UpdateAdminAiSettings = {
      expectedVersion: settings.version,
      enabled: clearKey ? false : enabled,
      productCopilotEnabled: clearKey ? false : copilotEnabled,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(clearKey ? { apiKey: null } : key ? { apiKey: key } : {}),
    }
    try {
      acceptSettings(await updateAdminAiSettings(input))
      showToast('AI 配置已保存，新请求立即生效')
    } catch (err) {
      setError(getApiErrorMessage(err, '保存 AI 配置失败'))
    } finally {
      // Also clear failed submissions so a secret does not linger after a request.
      setApiKey('')
      busyRef.current = false
      setBusy(null)
    }
  }

  async function testConnection() {
    if (!settings || busyRef.current) return
    busyRef.current = true
    setBusy('test')
    setError('')
    setTestResult(null)
    try { setTestResult(await testAdminAiConnection(settings.version)) }
    catch (err) { setError(getApiErrorMessage(err, '连接测试失败')) }
    finally { busyRef.current = false; setBusy(null) }
  }

  if (loading) return <p className="text-sm text-[var(--color-text-muted)] mb-6">正在加载 AI 配置…</p>
  if (loadError || !settings) return (
    <div className="mb-6" role="alert">
      AI 配置加载失败
      <button type="button" className="btn-secondary btn-sm ml-3" onClick={() => void load()}>重新加载 AI 配置</button>
    </div>
  )

  const dirty = apiKey.length > 0 || clearKey || enabled !== settings.enabled || copilotEnabled !== settings.productCopilotEnabled
    || baseUrl !== settings.baseUrl || model !== settings.model
  return (
    <form onSubmit={save} className="mb-6 space-y-4" aria-label="AI 服务配置">
      <div>
        <h4 className="font-bold text-[var(--color-text)]">AI 服务</h4>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          配置 OpenAI 或第三方兼容服务，开启商品说明整理。保存后对新请求立即生效；每日配额在下方分别设置。
        </p>
      </div>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-4">
        <dl className="text-sm space-y-1">
          <div>配置来源：{settings.source === 'database' ? '管理后台' : '部署环境（首次保存后由后台管理）'}</div>
          <div>密钥状态：{settings.apiKeyConfigured ? `已配置 · ••••${settings.apiKeyLast4 ?? ''}` : '未配置'}</div>
        </dl>
        {!settings.encryptionReady && <p role="alert" className="text-sm text-[var(--color-danger)]">
          服务器需先配置加密主密钥 AI_CREDENTIALS_ENC_KEY，才能保存 API Key。请联系部署管理员完成一次性配置。
        </p>}
        {settings.credentialError && <p role="alert" className="text-sm text-[var(--color-danger)]">
          已保存的密钥无法解密，AI 暂不可用。请恢复服务器加密主密钥，或重新填写 API Key。
        </p>}
        <div>
          <label htmlFor="admin-ai-base-url" className="block text-sm font-semibold mb-1">API 地址（Base URL）</label>
          <input id="admin-ai-base-url" type="url" required maxLength={2048} className="input w-full"
            placeholder="https://api.example.com/v1" value={baseUrl} disabled={busy !== null}
            onChange={e => { setBaseUrl(e.target.value); setTestResult(null) }} />
          <p className="text-xs text-[var(--color-text-muted)] mt-1">填写服务商提供的 HTTPS 基础地址，通常以 /v1 结尾。更换地址时须同时填写对应密钥。</p>
        </div>
        <div>
          <label htmlFor="admin-ai-model" className="block text-sm font-semibold mb-1">模型名称</label>
          <input id="admin-ai-model" type="text" required maxLength={200} className="input w-full"
            value={model} disabled={busy !== null} onChange={e => { setModel(e.target.value); setTestResult(null) }} />
          <p className="text-xs text-[var(--color-text-muted)] mt-1">填写服务商的 model ID。服务和模型需支持 Responses API、严格 JSON Schema 输出及 reasoning.effort=none；更换后请先验证生成效果。</p>
        </div>
        <div>
          <label htmlFor="admin-ai-api-key" className="block text-sm font-semibold mb-1">API Key</label>
          <input id="admin-ai-api-key" type="password" autoComplete="new-password" spellCheck={false}
            className="input w-full" placeholder={settings.apiKeyConfigured ? '留空保留当前密钥；填写新密钥以更换' : '填写 API Key'}
            value={apiKey} disabled={busy !== null || clearKey || !settings.encryptionReady} maxLength={512}
            onChange={e => { setApiKey(e.target.value); setTestResult(null) }} />
          <p className="text-xs text-[var(--color-text-muted)] mt-1">密钥加密保存，保存后不会显示完整内容。</p>
        </div>
        {settings.apiKeyConfigured && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clearKey} disabled={busy !== null} onChange={e => {
            setClearKey(e.target.checked); setApiKey(''); setTestResult(null)
            if (e.target.checked) { setEnabled(false); setCopilotEnabled(false) }
          }} />清除已保存密钥，同时关闭 AI
        </label>}
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={enabled} disabled={busy !== null || clearKey} onChange={e => {
            setEnabled(e.target.checked)
            if (!e.target.checked) setCopilotEnabled(false)
          }} />AI 总开关
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={copilotEnabled} disabled={busy !== null || !enabled || clearKey}
            onChange={e => setCopilotEnabled(e.target.checked)} />商品说明 Copilot
        </label>
        <p className="text-xs text-[var(--color-text-muted)]">两个开关均开启且对应角色的配额大于 0 时，已选择商品形态的商品编辑页才会显示 AI 整理入口。</p>
      </div>
      {error && <div role="alert" className="text-sm text-[var(--color-danger)]">{error}
        <button type="button" className="btn-secondary btn-sm ml-2" disabled={busy !== null} onClick={() => void load()}>重新加载 AI 配置</button>
      </div>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary btn-sm" disabled={busy !== null || !dirty}>{busy === 'save' ? '保存中…' : '保存 AI 配置'}</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void testConnection()}
          disabled={busy !== null || dirty || !settings.apiKeyConfigured || settings.credentialError}>{busy === 'test' ? '正在测试…' : '测试已保存的连接'}</button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">连接测试检查连接、鉴权与模型列表，不发送商品内容、不扣每日配额。它不验证生成权限、质量和账户余额。</p>
      {testResult && <p role="status" className={`text-sm ${testResult.ok ? 'text-[var(--color-text)]' : 'text-[var(--color-danger)]'}`}>
        {testResult.message}（{testResult.latencyMs} 毫秒）
      </p>}
    </form>
  )
}
