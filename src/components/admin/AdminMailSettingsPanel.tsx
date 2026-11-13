import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getAdminMailSettings, saveAdminMailDraft, operateAdminMailSettings,
  type AdminMailSettings, type MailTransportSettings,
} from '../../api/adminMail'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

const EMPTY: MailTransportSettings = { host: '', port: 587, secure: false, from: '', fromName: 'MoNexus' }

export default function AdminMailSettingsPanel({ onActivated }: { onActivated: () => void }) {
  const showToast = useAppStore(s => s.showToast)
  const [settings, setSettings] = useState<AdminMailSettings | null>(null)
  const [form, setForm] = useState<MailTransportSettings>(EMPTY)
  const [auth, setAuth] = useState(true)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const requestSeq = useRef(0)

  function accept(next: AdminMailSettings) {
    setSettings(next)
    setForm(next.draft ?? next.bootstrap ?? EMPTY)
    setAuth(next.draftAuthConfigured || (!next.draft && !next.bootstrap))
    setUser(''); setPass(''); setDirty(false); setError('')
  }

  async function reload() {
    const seq = ++requestSeq.current
    setBusy(true)
    try {
      const next = await getAdminMailSettings()
      if (seq === requestSeq.current) accept(next)
    }
    catch (err) { if (seq === requestSeq.current) setError(getApiErrorMessage(err, '加载业务邮件设置失败')) }
    finally { if (seq === requestSeq.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { requestSeq.current += 1 } }, [])

  function edit<K extends keyof MailTransportSettings>(key: K, value: MailTransportSettings[K]) {
    setForm(previous => ({ ...previous, [key]: value })); setDirty(true)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || busy) return
    if (auth && Boolean(user) !== Boolean(pass)) {
      setError('更换凭据时请同时填写账号和密码'); return
    }
    if (auth && !user && !settings.draftAuthConfigured) {
      setError('请填写 SMTP 账号和密码，或选择免认证中继'); return
    }
    setBusy(true); setError('')
    try {
      accept(await saveAdminMailDraft({
        ...form, expectedVersion: settings.version,
        ...(!auth ? { credentials: null } : user && pass ? { credentials: { user, pass } } : {}),
      }))
      showToast('草稿已保存，请发送测试邮件后激活')
    } catch (err) { setError(getApiErrorMessage(err, '保存邮件草稿失败')) }
    finally { setBusy(false) }
  }

  async function operate(action: 'test' | 'activate' | 'rollback') {
    if (!settings || busy) return
    if (action === 'test' && !email.trim()) { setError('请输入测试收件地址'); return }
    setBusy(true); setError('')
    try {
      accept(await operateAdminMailSettings(action, settings.version, action === 'test' ? email.trim() : undefined))
      if (action === 'test') { setEmail(''); showToast('测试邮件已提交发送，可以激活当前草稿') }
      else { onActivated(); showToast(action === 'activate' ? '已激活，后续业务邮件使用新配置' : '已回滚业务邮件配置') }
    } catch (err) { setError(getApiErrorMessage(err, '邮件配置操作失败')) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-5 rounded-lg border border-[var(--color-border)] p-4 space-y-4" data-testid="admin-mail-settings">
      <h3 className="font-semibold">业务邮件设置</h3>
      <p className="text-sm text-[var(--color-text-muted)]">
        保存草稿并发送测试邮件后激活。修改对后续发送生效，监控告警邮件由运维独立配置。
        使用账号密码时必须通过 TLS，587 端口会强制升级 STARTTLS。
      </p>
      {error && <p role="alert" className="text-sm text-[var(--color-danger)] break-words">{error}</p>}
      {!settings ? (
        <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>
          {busy ? '加载中…' : '重新加载设置'}
        </button>
      ) : (
        <>
          <p className="text-sm">当前来源：{settings.source === 'database' ? '管理员后台' : '部署环境变量'} · 生效版本：{settings.activeVersion}</p>
          {!settings.encryptionReady && <p className="text-sm text-[var(--color-text-muted)]">尚未配置凭据加密密钥，暂不能保存需要认证的 SMTP 服务。</p>}
          <form onSubmit={save} className="space-y-3">
            <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="text-sm min-w-0">SMTP 主机
                <input className="input w-full min-h-10 mt-1" required value={form.host} onChange={e => edit('host', e.target.value)} autoComplete="off" />
              </label>
              <label className="text-sm min-w-0">SMTP 端口
                <input className="input w-full min-h-10 mt-1" type="number" required min={1} max={65535} value={form.port} onChange={e => edit('port', Number(e.target.value))} />
              </label>
              <label className="text-sm min-w-0">发件邮箱
                <input className="input w-full min-h-10 mt-1" type="email" required value={form.from} onChange={e => edit('from', e.target.value)} autoComplete="off" />
              </label>
              <label className="text-sm min-w-0">发件人名称
                <input className="input w-full min-h-10 mt-1" maxLength={100} value={form.fromName} onChange={e => edit('fromName', e.target.value)} />
              </label>
              <label className="text-sm flex min-h-10 items-center gap-2">
                <input type="checkbox" checked={form.secure} onChange={e => edit('secure', e.target.checked)} />
                连接时使用 TLS（通常为 465 端口）
              </label>
              <label className="text-sm flex min-h-10 items-center gap-2">
                <input type="checkbox" checked={auth} onChange={e => { setAuth(e.target.checked); setDirty(true); setUser(''); setPass('') }} />
                使用账号密码认证
              </label>
              {auth && <>
                <label className="text-sm min-w-0">SMTP 账号
                  <input className="input w-full min-h-10 mt-1" value={user} onChange={e => { setUser(e.target.value); setDirty(true) }} autoComplete="off" placeholder={settings.draftAuthConfigured ? '留空保留已保存账号' : ''} />
                </label>
                <label className="text-sm min-w-0">SMTP 密码
                  <input className="input w-full min-h-10 mt-1" type="password" value={pass} onChange={e => { setPass(e.target.value); setDirty(true) }} autoComplete="new-password" placeholder={settings.draftAuthConfigured ? '留空保留已保存密码' : ''} />
                </label>
              </>}
            </fieldset>
            <button className="btn-primary min-h-10 px-4" disabled={busy || (auth && !settings.encryptionReady)}>{busy ? '处理中…' : '保存草稿'}</button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm min-w-0 flex-1">草稿测试收件地址
              <input className="input w-full min-h-10 mt-1" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" disabled={busy} />
            </label>
            <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || dirty || !settings.draft} onClick={() => void operate('test')}>发送草稿测试邮件</button>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">{dirty ? '有未保存的修改，请先保存草稿。' : settings.tested ? '当前草稿测试通过，可以激活。' : '当前草稿尚未通过测试。'}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary min-h-10 px-4" disabled={busy || dirty || !settings.tested} onClick={() => void operate('activate')}>激活当前草稿</button>
            <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy || !settings.rollbackAvailable} onClick={() => void operate('rollback')}>回滚上一版</button>
            <button type="button" className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>重新加载设置</button>
          </div>
        </>
      )}
    </div>
  )
}
