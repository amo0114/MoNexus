import { useEffect, useRef, useState, type FormEvent } from 'react'
import { fakaIntegrationApi as api, type FakaSettings, type ManagedSettings } from '../../api/adminIntegrations'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
const empty: FakaSettings = { url: '', statusUrl: '', revokeUrl: '', panelUrl: '', timeoutMs: 15000, maxAttempts: 3, instanceId: null, clientId: 'monexus' }
const fields = [['url', '开通接口'], ['statusUrl', '状态接口'], ['revokeUrl', '撤销接口'], ['panelUrl', '交付面板地址'], ['instanceId', 'Xboard 实例 ID（可选）'], ['clientId', '调用方 ID']] as const
export default function AdminFakaSettingsPanel() {
  const [state, setState] = useState<ManagedSettings<FakaSettings> | null>(null)
  const [form, setForm] = useState(empty), [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState('')
  const [legacyConfirmed, setLegacyConfirmed] = useState(false)
  const seq = useRef(0), showToast = useAppStore(s => s.showToast)
  function accept(next: ManagedSettings<FakaSettings>) { setState(next); setForm(next.draft ?? next.bootstrap ?? empty); setSecret(''); setDirty(false); setError(''); setLegacyConfirmed(false) }
  async function reload() {
    const id = ++seq.current; setBusy(true)
    try { const next = await api.get(); if (seq.current === id) accept(next) }
    catch (err) { if (seq.current === id) setError(getApiErrorMessage(err, '加载履约设置失败')) }
    finally { if (seq.current === id) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { seq.current++ } }, [])
  async function save(event: FormEvent) {
    event.preventDefault(); if (!state || busy) return
    setBusy(true); setError('')
    try { accept(await api.save(state.version, form, secret ? { secret } : undefined)); showToast('履约草稿已保存') }
    catch (err) { setError(getApiErrorMessage(err, '保存履约草稿失败')) } finally { setBusy(false) }
  }
  async function operate(action: 'test' | 'activate' | 'enabled' | 'rollback') {
    if (!state || busy) return
    setBusy(true); setError('')
    try {
      const next = await api.operate(action, state.version, action === 'enabled' ? { enabled: !state.enabled } : action === 'activate' ? { legacyConfirmed } : {})
      if (dirty && (action === 'enabled' || action === 'rollback')) setState(next); else accept(next)
      showToast(action === 'test' ? '只读探测通过，尚未验证实际开通与撤销' : '履约配置已更新；历史任务保留原配置')
    } catch (err) { setError(getApiErrorMessage(err, '履约配置操作失败')) } finally { setBusy(false) }
  }
  return <section className="mt-6 rounded-lg border border-[var(--color-border)] p-4 space-y-4" data-testid="admin-faka-settings">
    <h3 className="font-semibold">FakaBridge / Xboard 履约</h3>
    <p className="text-sm text-[var(--color-text-muted)]">新任务绑定激活时的配置。历史开通、查询、退款撤销与流量重置继续使用原版本。只读探测不修改外部订阅。</p>
    {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
    {!state ? <button className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>重新加载履约设置</button> : <>
      <p className="text-sm">来源：{state.source === 'database' ? '管理员后台' : '部署环境'} · 新履约：{state.enabled ? '允许' : '已停止'}</p>
      {!state.encryptionReady && <p>需部署集成凭据加密密钥后才能保存与激活。</p>}
      <form className="space-y-3" onSubmit={save}>
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          {fields.map(([key, label]) => <label key={key} className="text-sm min-w-0">{label}<input className="input mt-1 w-full min-h-10" required={key !== 'instanceId'} type={key.endsWith('Url') || key === 'url' ? 'url' : 'text'} value={form[key] ?? ''} onChange={e => { setForm(f => ({ ...f, [key]: key === 'instanceId' ? e.target.value || null : e.target.value })); setDirty(true) }} /></label>)}
          {([['timeoutMs','请求超时（毫秒）',1000,60000],['maxAttempts','最大重试次数',1,10]] as const).map(([key,label,min,max]) => <label key={key} className="text-sm">{label}<input className="input mt-1 w-full min-h-10" type="number" required min={min} max={max} value={form[key]} onChange={e => { setForm(f => ({ ...f, [key]: Number(e.target.value) })); setDirty(true) }} /></label>)}
          <label className="text-sm">签名密钥<input className="input mt-1 w-full min-h-10" type="password" autoComplete="new-password" value={secret} placeholder={state.credentialsConfigured ? '留空保留；更换目标请重新填写' : ''} onChange={e => { setSecret(e.target.value); setDirty(true) }} /></label>
        </fieldset>
        <button className="btn-primary min-h-10 px-4" disabled={busy || !state.encryptionReady}>保存履约草稿</button>
      </form>
      {!state.activeRevisionId && <label className="flex gap-2 text-sm items-start"><input type="checkbox" checked={legacyConfirmed} onChange={e => setLegacyConfirmed(e.target.checked)} />我已核实当前部署配置是历史履约任务原来使用的站点和密钥。首次激活会冻结这份历史配置；无法确认时请先核验。</label>}
      <p className="text-sm text-[var(--color-text-muted)]">{dirty ? '有未保存修改。' : state.tested ? '草稿已通过只读探测。' : '请先保存并进行只读探测。'} 探测成功不代表实际开通、撤销和流量重置已验收。</p>
      <div className="flex flex-wrap gap-3">
        <button className="btn-secondary min-h-10 px-4" disabled={busy || dirty || !state.draft} onClick={() => void operate('test')}>探测履约配置</button>
        <button className="btn-primary min-h-10 px-4" disabled={busy || dirty || !state.tested || !state.encryptionReady} onClick={() => void operate('activate')}>激活履约草稿</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void operate('enabled')}>{state.enabled ? '停止新履约' : '允许新履约'}</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy || !state.rollbackAvailable} onClick={() => void operate('rollback')}>回滚履约配置</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>重新加载履约设置</button>
      </div>
    </>}
  </section>
}
