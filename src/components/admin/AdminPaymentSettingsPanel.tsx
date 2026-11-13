import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { integrationApi, type ManagedSettings } from '../../api/adminIntegrations'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
type Name = 'stripe' | 'paypal' | 'wechat_pay' | 'alipay' | 'vmqfox'
type Values = Record<string, string | number>
type Field = readonly [key: string, label: string]
const definitions: Record<Name, { label: string; public: Field[]; secrets: Field[]; defaults?: Values }> = {
  stripe: { label: 'Stripe', public: [['accountId','商户账号 ID（acct_ 开头）']], secrets: [['secretKey','API 密钥'],['webhookSecret','Webhook 签名密钥']] },
  paypal: { label: 'PayPal', public: [['merchantId','商户 ID'],['clientId','应用 Client ID'],['payeeEmail','收款邮箱（可选）']], secrets: [['clientSecret','应用密钥'],['webhookId','Webhook ID']] },
  wechat_pay: { label: '微信支付', public: [['mchid','商户号'],['appid','应用 ID'],['merchantSerialNo','商户证书序列号'],['platformSerialNo','平台公钥/证书序列号']], secrets: [['merchantPrivateKeyPem','商户私钥 PEM'],['apiV3Key','API v3 密钥（32 字节）'],['platformPublicKeyPem','平台公钥 PEM']] },
  alipay: { label: '支付宝', public: [['appId','应用 ID'],['sellerId','收款商户 ID']], secrets: [['privateKey','应用私钥 PEM'],['alipayPublicKey','支付宝公钥（公钥模式）'],['appCert','应用证书（证书模式）'],['alipayCert','支付宝证书（证书模式）'],['rootCert','根证书（证书模式）']] },
  vmqfox: { label: 'VMQFox', public: [['merchantId','稳定商户标识'],['baseUrl','支付服务域名'],['maxAmountMinor','单笔上限（分，最高 100000）'],['requestTimeoutMs','请求超时（毫秒）']], secrets: [['merchantKey','商户密钥']], defaults: { baseUrl: 'https://pay.snowvictor.com', maxAmountMinor: '100000', requestTimeoutMs: 5000 } },
}
function AccountPanel({ name }: { name: Name }) {
  const def = definitions[name], api = useMemo(() => integrationApi<Values, Values>(`payments/${name}`), [name])
  const empty = useMemo(() => ({ provider: name, mode: 'live', ...Object.fromEntries(def.public.map(([key]) => [key, ''])), ...def.defaults }), [name, def])
  const [state, setState] = useState<ManagedSettings<Values> | null>(null), [form, setForm] = useState<Values>(empty)
  const [secrets, setSecrets] = useState<Values>({}), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const seq = useRef(0), toast = useAppStore(s => s.showToast)
  function accept(next: ManagedSettings<Values>) { setState(next); setForm(next.draft ?? empty); setSecrets({}); setDirty(false); setError('') }
  async function reload() {
    const current = ++seq.current; setBusy(true)
    try { const next = await api.get(); if (current === seq.current) accept(next) }
    catch (err) { if (current === seq.current) setError(getApiErrorMessage(err, '加载支付账号配置失败')) }
    finally { if (current === seq.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { seq.current++ } }, [api])
  async function save(event: FormEvent) {
    event.preventDefault(); if (!state || busy) return
    setBusy(true); setError('')
    const credentials = Object.fromEntries(Object.entries(secrets).filter(([,v]) => v !== ''))
    const settings = Object.fromEntries(Object.entries(form).filter(([key,v]) => key !== 'payeeEmail' || v !== ''))
    try { accept(await api.save(state.version, settings, Object.keys(credentials).length ? { provider: name, ...credentials } : undefined)); toast('支付草稿已保存，请先校验') }
    catch (err) { setError(getApiErrorMessage(err, '保存支付配置失败')) } finally { setBusy(false) }
  }
  async function operate(action: 'test' | 'activate' | 'enabled' | 'rollback') {
    if (!state || busy) return
    setBusy(true); setError('')
    try {
      const next = await api.operate(action, state.version, action === 'enabled' ? { enabled: !state.enabled } : {})
      if (dirty && (action === 'enabled' || action === 'rollback')) setState(next); else accept(next)
      toast(action === 'test' ? name === 'stripe' ? '已核对 Stripe 商户身份；尚未验收完整支付流程' : '本地完整性校验通过；尚未验证第三方连接' : '支付设置已更新；历史交易继续处理')
    } catch (err) { setError(getApiErrorMessage(err, '支付配置操作失败')) } finally { setBusy(false) }
  }
  return <div className="space-y-4" data-testid={`payment-settings-${name}`}>
    {error && <p role="alert" className="text-sm text-[var(--color-danger)] break-words">{error}</p>}
    {!state ? <button disabled={busy} className="btn-secondary min-h-10 px-4" onClick={() => void reload()}>重新加载支付设置</button> : <>
      <p className="text-sm">{def.label} · 当前来源：{state.source === 'database' ? '管理员后台' : '部署环境兼容路径'} · 新收款：{state.enabled ? '允许（仍受部署总开关限制）' : '已停止'}</p>
      <p className="text-sm text-[var(--color-text-muted)]">{name === 'stripe' ? '校验会只读查询 Stripe 商户 ID，不创建订单。' : '校验仅检查参数、密钥材料与渠道能力，不请求扣款、退款或创建远端订单。'} 请另行完成第三方回调配置与受控业务验收。</p>
      {!state.encryptionReady && <p className="text-sm">部署集成凭据加密密钥后才能保存和激活。</p>}
      <form onSubmit={save} className="space-y-3">
        <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="text-sm">账号环境<select className="input mt-1 w-full min-h-10" value={form.mode} onChange={e => { setForm(f => ({ ...f, mode: e.target.value })); setDirty(true) }}><option value="live">正式商户</option>{name !== 'wechat_pay' && name !== 'vmqfox' && <option value={name === 'stripe' ? 'test' : 'sandbox'}>沙箱（生产部署不可用）</option>}</select></label>
          {def.public.map(([key,label]) => <label key={key} className="text-sm min-w-0">{label}<input className="input mt-1 w-full min-h-10" required={key !== 'payeeEmail'} type={key === 'requestTimeoutMs' ? 'number' : key === 'baseUrl' ? 'url' : 'text'} value={form[key] ?? ''} onChange={e => { setForm(f => ({ ...f, [key]: key === 'requestTimeoutMs' ? Number(e.target.value) : e.target.value })); setDirty(true) }} /></label>)}
          {def.secrets.map(([key,label]) => <label key={key} className="text-sm min-w-0">{label}{/Pem|Cert|Key$/.test(key) && name !== 'stripe' && name !== 'vmqfox' ? <textarea className="input mt-1 w-full min-h-20" autoComplete="off" value={secrets[key] ?? ''} onChange={e => { setSecrets(s => ({ ...s, [key]: e.target.value })); setDirty(true) }} /> : <input className="input mt-1 w-full min-h-10" type="password" autoComplete="new-password" value={secrets[key] ?? ''} onChange={e => { setSecrets(s => ({ ...s, [key]: e.target.value })); setDirty(true) }} />}</label>)}
        </fieldset>
        <p className="text-sm text-[var(--color-text-muted)]">凭据全部留空保留已保存值。替换时填写该账号的完整凭据组；更换商户或应用必须重新填写。凭据保存后清空，不会回传。支付宝选择完整证书组或公钥模式。</p>
        <button className="btn-primary min-h-10 px-4" disabled={busy || !state.encryptionReady}>保存支付草稿</button>
      </form>
      {state.draftWebhookUrl && <label className="block text-sm">草稿账号回调地址<input className="input mt-1 w-full min-h-10" readOnly value={state.draftWebhookUrl} onFocus={e => e.target.select()} /><span className="text-[var(--color-text-muted)]">请在第三方商户后台登记该地址。切换新商户时保留旧账号回调。</span></label>}
      <p className="text-sm text-[var(--color-text-muted)]">{dirty ? '有未保存修改。' : state.tested ? '草稿已完成配置校验。' : '请先校验草稿。'} 停止新收款后，历史回调、查询、退款与对账继续保留。</p>
      <div className="flex flex-wrap gap-3">
        <button className="btn-secondary min-h-10 px-4" disabled={busy || dirty || !state.draft} onClick={() => void operate('test')}>校验支付配置</button>
        <button className="btn-primary min-h-10 px-4" disabled={busy || dirty || !state.tested || !state.encryptionReady} onClick={() => void operate('activate')}>激活支付草稿</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void operate('enabled')}>{state.enabled ? '停止新收款' : '允许新收款'}</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy || !state.rollbackAvailable} onClick={() => void operate('rollback')}>回滚支付配置</button>
        <button className="btn-secondary min-h-10 px-4" disabled={busy} onClick={() => void reload()}>重新加载支付设置</button>
      </div>
    </>}
  </div>
}
export default function AdminPaymentSettingsPanel() {
  const [name, setName] = useState<Name>('stripe')
  return <section className="mt-6 rounded-lg border border-[var(--color-border)] p-4 space-y-4" data-testid="admin-payment-settings">
    <h3 className="font-semibold">支付商户账号</h3>
    <p className="text-sm text-[var(--color-text-muted)]">每个渠道可选择一个账号接受新订单。旧商户和凭据版本保留，用于历史交易。账号身份不可改写；回调地址见运行时配置运维说明。</p>
    <label className="block text-sm">支付渠道<select className="input mt-1 w-full min-h-10 sm:max-w-sm" value={name} onChange={e => setName(e.target.value as Name)}>{Object.entries(definitions).map(([value,def]) => <option key={value} value={value}>{def.label}</option>)}</select></label>
    <AccountPanel key={name} name={name} />
  </section>
}
