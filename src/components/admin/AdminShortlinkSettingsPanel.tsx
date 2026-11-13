import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getShortlinkSettings, saveShortlinkDraft, operateShortlinkSettings, type ShortlinkAdminSettings, type ShortlinkSettings } from '../../api/adminIntegrations'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

const EMPTY: ShortlinkSettings = { apiBaseUrl: '', publicOrigin: '', groupId: '' }
export default function AdminShortlinkSettingsPanel() {
  const [settings, setSettings] = useState<ShortlinkAdminSettings | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const showToast = useAppStore(s => s.showToast)
  function accept(next: ShortlinkAdminSettings) {
    setSettings(next); setForm(next.draft ?? next.bootstrap ?? EMPTY)
    setUsername(''); setPassword(''); setDirty(false); setError('')
  }
  async function reload() {
    const current = ++sequence.current
    setBusy(true)
    try { const next = await getShortlinkSettings(); if (current === sequence.current) accept(next) }
    catch (err) { if (current === sequence.current) setError(getApiErrorMessage(err, '加载短链设置失败')) }
    finally { if (current === sequence.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { sequence.current += 1 } }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || busy) return
    if (Boolean(username) !== Boolean(password) || (!username && !settings.credentialsConfigured)) {
      setError('请同时填写短链账号和密码'); return
    }
    setBusy(true); setError('')
    try {
      accept(await saveShortlinkDraft({ ...form, expectedVersion: settings.version,
        ...(username && password ? { credentials: { username, password } } : {}),
      }))
      showToast('短链草稿已保存，请进行登录探测')
    } catch (err) { setError(getApiErrorMessage(err, '保存短链草稿失败')) }
    finally { setBusy(false) }
  }
  async function operate(action: 'test' | 'activate' | 'rollback' | 'enabled') {
    if (!settings || busy) return
    setBusy(true); setError('')
    try {
      const next = await operateShortlinkSettings(action, settings.version, action === 'enabled' ? !settings.enabled : undefined)
      if (dirty && (action === 'enabled' || action === 'rollback')) { setSettings(next); setError('') }
      else accept(next)
      showToast(action === 'test' ? '登录探测通过；尚未验证分组与创建权限' : action === 'activate' ? '已激活，后续新建链接使用新配置' : action === 'rollback' ? '已回滚短链配置' : settings.enabled ? '已停止新建短链，已有链接保留' : '已允许新建短链')
    } catch (err) { setError(getApiErrorMessage(err, '短链配置操作失败')) }
    finally { setBusy(false) }
  }
  function edit(key: keyof ShortlinkSettings, value: string) { setForm(previous => ({ ...previous, [key]: value })); setDirty(true) }
  return (
    <div className="mt-6 rounded-lg border border-[var(--color-border)] p-4 space-y-4" data-testid="admin-shortlink-settings">
      <h3 className="font-semibold">商品分享短链</h3>
      <p className="text-sm text-[var(--color-text-muted)]">保存草稿、登录探测后激活。已有分享链接会保留，正在创建的请求继续使用原配置。</p>
      {error && <p role="alert" className="text-sm text-[var(--color-danger)] break-words">{error}</p>}
      {!settings ? <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>{busy ? '加载中…' : '重新加载短链设置'}</button> : <>
        <p className="text-sm">当前来源：{settings.source === 'database' ? '管理员后台' : '部署环境变量'} · 新建短链：{settings.enabled ? '允许' : '已停用'}</p>
        {!settings.encryptionReady && <p className="text-sm text-[var(--color-text-muted)]">尚未配置集成凭据加密密钥，暂不能保存认证凭据。</p>}
        <form onSubmit={save} className="space-y-3">
          <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="text-sm min-w-0">短链 API 地址<input className="input mt-1 w-full min-h-10" required type="url" value={form.apiBaseUrl} onChange={e => edit('apiBaseUrl', e.target.value)} placeholder="https://shortlink-admin.example.com" /></label>
            <label className="text-sm min-w-0">短链公开域名<input className="input mt-1 w-full min-h-10" required type="url" value={form.publicOrigin} onChange={e => edit('publicOrigin', e.target.value)} placeholder="https://s.example.com" /></label>
            <label className="text-sm min-w-0">短链分组<input className="input mt-1 w-full min-h-10" required value={form.groupId} onChange={e => edit('groupId', e.target.value)} /></label>
            <label className="text-sm min-w-0">短链账号<input className="input mt-1 w-full min-h-10" autoComplete="off" value={username} onChange={e => { setUsername(e.target.value); setDirty(true) }} placeholder={settings.credentialsConfigured ? '留空保留已保存账号' : ''} /></label>
            <label className="text-sm min-w-0">短链密码<input className="input mt-1 w-full min-h-10" type="password" autoComplete="new-password" value={password} onChange={e => { setPassword(e.target.value); setDirty(true) }} placeholder={settings.credentialsConfigured ? '留空保留已保存密码' : ''} /></label>
          </fieldset>
          <button className="btn-primary min-h-10 px-4" disabled={busy || !settings.encryptionReady}>保存短链草稿</button>
        </form>
        <p className="text-sm text-[var(--color-text-muted)]">{dirty ? '有未保存修改，请先保存。' : settings.tested ? '当前草稿已通过登录探测。' : '当前草稿尚未通过登录探测。'} 探测不创建链接，不能证明分组与创建接口的权限。</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || dirty || !settings.draft} onClick={() => void operate('test')}>探测短链登录</button>
          <button type="button" className="btn-primary min-h-10 px-4" disabled={busy || dirty || !settings.tested || !settings.encryptionReady} onClick={() => void operate('activate')}>激活短链草稿</button>
          <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void operate('enabled')}>{settings.enabled ? '停止新建短链' : '允许新建短链'}</button>
          <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !settings.rollbackAvailable} onClick={() => void operate('rollback')}>回滚短链配置</button>
          <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>重新加载短链设置</button>
        </div>
      </>}
    </div>
  )
}
