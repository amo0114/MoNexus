import { FormEvent, useEffect, useMemo, useState } from 'react'
import { HardDrive, RefreshCw, ShieldAlert } from 'lucide-react'
import {
  activateAdminStorageProvider,
  createAdminStorageProvider,
  disableAdminStorageProvider,
  getAdminStorageStatus,
  listAdminStorageProviders,
  rollbackAdminStorageProvider,
  testAdminStorageProvider,
  type StoragePreset,
  type StorageProviderItem,
  type StorageProviderPublicConfig,
  type StorageStatus,
} from '../../api/adminStorage'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { ProviderIcon } from './storage/ProviderIcons'
import ConfirmDialog from '../ui/ConfirmDialog'

const EMPTY_FORM: StorageProviderPublicConfig & {
  type: StoragePreset['type']
  name: string
  accessKey: string
  secretKey: string
} = {
  type: 'r2',
  name: '',
  endpoint: '',
  region: 'auto',
  publicBucket: '',
  privateBucket: '',
  publicUrlBase: '',
  deliveryPublicEndpoint: '',
  forcePathStyle: true,
  accessKey: '',
  secretKey: '',
}

function statusLabel(status: string) {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'verified':
      return '已验证'
    case 'active':
      return '生效中'
    case 'disabled':
      return '已禁用'
    default:
      return status
  }
}

function statusClass(status: string) {
  switch (status) {
    case 'active':
      return 'text-[var(--color-cta)] bg-[var(--color-cta)]/10 border-[var(--color-cta)]/25'
    case 'verified':
      return 'text-[var(--color-primary)] bg-[var(--color-primary)]/10 border-[var(--color-primary)]/25'
    case 'disabled':
      return 'text-[var(--color-text-muted)] bg-[var(--color-background)] border-[var(--color-border)]'
    default:
      return 'text-amber-600 bg-amber-500/10 border-amber-500/25'
  }
}

/**
 * SPEC-STORAGE-001：对象存储控制台。
 * 密钥仅写入请求体，从不回显；底座 env 只读展示。
 */
export default function AdminStoragePanel() {
  const showToast = useAppStore(s => s.showToast)
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [providers, setProviders] = useState<StorageProviderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<{
    id: number
    action: 'activate' | 'rollback' | 'disable'
    name: string
  } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const writable = Boolean(status?.uiConfigEnabled && status.configSource === 'database')

  const selectedPreset = useMemo(
    () => status?.presets.find(p => p.type === form.type),
    [status, form.type],
  )

  async function reload() {
    setLoading(true)
    try {
      const [s, list] = await Promise.all([getAdminStorageStatus(), listAdminStorageProviders()])
      setStatus(s)
      setProviders(list)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载对象存储状态失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  function applyPreset(type: StoragePreset['type']) {
    const preset = status?.presets.find(p => p.type === type)
    setForm(f => ({
      ...f,
      type,
      forcePathStyle: preset?.forcePathStyleDefault ?? true,
      region: type === 'r2' ? 'auto' : f.region === 'auto' ? 'us-east-1' : f.region,
      name: f.name || preset?.label || '',
    }))
    setShowForm(true)
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!writable || creating) return
    setCreating(true)
    try {
      await createAdminStorageProvider({
        type: form.type,
        name: form.name.trim(),
        accessKey: form.accessKey,
        secretKey: form.secretKey,
        publicConfig: {
          endpoint: form.endpoint.trim(),
          region: form.region.trim() || 'us-east-1',
          publicBucket: form.publicBucket.trim(),
          privateBucket: form.privateBucket.trim(),
          publicUrlBase: form.publicUrlBase?.trim() || undefined,
          deliveryPublicEndpoint: form.deliveryPublicEndpoint?.trim() || undefined,
          forcePathStyle: form.forcePathStyle,
        },
      })
      showToast('存储配置已保存为草稿')
      setForm(EMPTY_FORM)
      setShowForm(false)
      await reload()
    } catch (err) {
      showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  async function runTest(id: number) {
    if (!writable || busyId === id) return
    setBusyId(id)
    try {
      const res = await testAdminStorageProvider(id)
      showToast(res.probe.ok ? res.probe.summary : `探测失败：${res.probe.summary}`, res.probe.ok ? 'success' : 'error')
      await reload()
    } catch (err) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function executeAction(
    id: number,
    action: 'activate' | 'rollback' | 'disable',
  ) {
    if (!writable || actionLoading) return
    setActionLoading(true)
    setBusyId(id)
    try {
      if (action === 'activate') {
        await activateAdminStorageProvider(id)
        showToast('已激活：新写入将使用该提供商')
      } else if (action === 'rollback') {
        await rollbackAdminStorageProvider(id)
        showToast('已回滚写入目标')
      } else {
        await disableAdminStorageProvider(id)
        showToast('已禁用该配置')
      }
      setConfirmTarget(null)
      await reload()
    } catch (err) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
      setActionLoading(false)
      setBusyId(null)
    }
  }

  if (loading && !status) {
    return (
      <div data-testid="admin-storage-panel" className="text-sm text-[var(--color-text-muted)] py-6">
        加载对象存储状态…
      </div>
    )
  }

  return (
    <div data-testid="admin-storage-panel" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
            <HardDrive className="w-5 h-5" /> 对象存储
          </h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-2xl">
            默认使用部署时设置的存储。后台可新增云存储配置，保存并测试后再启用；切换只改变新上传文件的位置。
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => void reload()}>
          <RefreshCw className="w-3.5 h-3.5" /> 刷新
        </button>
      </div>

      {status && (
        <>
          {/* Bootstrap card */}
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <ProviderIcon type="minio" className="w-10 h-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold text-[var(--color-text)]">{status.bootstrap.providerLabel}</h3>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                      status.bootstrap.healthy
                        ? 'text-[var(--color-cta)] bg-[var(--color-cta)]/10 border-[var(--color-cta)]/25'
                        : 'text-red-500 bg-red-500/10 border-red-500/25'
                    }`}
                  >
                    {status.bootstrap.healthy ? '部署默认存储可用' : '部署默认存储异常'}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    写入目标：{status.runtime.writeTarget === 'bootstrap' ? '部署默认存储' : `后台配置 #${status.runtime.activeConfigId}`}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">服务地址（Endpoint） </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.endpointHost ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">区域（Region） </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.region ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">公共文件存储桶 </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.publicBucket ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">私有交付存储桶 </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.privateBucket ?? '—'}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-[var(--color-text-muted)] inline">连通诊断 </dt>
                    <dd className="inline text-[var(--color-text)]">{status.bootstrap.healthDetail}</dd>
                  </div>
                </dl>
                <div className="text-xs text-[var(--color-text-muted)] mt-3">
                  <span>当前配置版本：{status.runtime.configVersion}</span>
                  {' · '}
                  <span>后台写操作：{status.uiConfigEnabled ? '开启' : '关闭'}</span>
                  {' · '}
                  <span>凭证主密钥：{status.credentialsEncKeyConfigured ? '已配置' : '未配置'}</span>
                </div>
              </div>
            </div>
          </section>

          {(!status.uiConfigEnabled || status.configSource === 'env') && (
            <div className="flex gap-2 items-start rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  {status.configSource === 'env'
                    ? '环境变量强制模式：仅使用部署默认存储，后台无法新增或切换云配置。'
                    : '存储控制台只读模式：当前不允许通过后台修改存储配置。'}
                </p>
                <details className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  <summary className="cursor-pointer">运维详情</summary>
                  <div className="font-mono mt-0.5">
                    {status.configSource === 'env' ? 'STORAGE_CONFIG_SOURCE=env' : 'STORAGE_UI_CONFIG_ENABLED=false'}
                  </div>
                </details>
              </div>
            </div>
          )}

          {/* Saved configs section */}
          <section>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-2">
              <h3 className="font-semibold text-[var(--color-text)]">已保存配置及操作</h3>
              <span className="text-xs text-[var(--color-text-muted)]">
                提示：激活影响新上传；历史文件按原绑定位置读取；回滚改变写入目标；禁用不等于删除历史文件。
              </span>
            </div>
            {providers.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] py-4">暂无云配置，新上传使用部署默认存储。</p>
            ) : (
              <div className="space-y-3">
                {providers.map(p => (
                  <div
                    key={p.id}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                    data-testid={`storage-provider-${p.id}`}
                  >
                    <ProviderIcon type={p.type} className="w-9 h-9 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[var(--color-text)]">{p.name}</span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${statusClass(p.status)}`}>
                          {statusLabel(p.status)}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)] font-mono">v{p.configVersion}</span>
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] mt-1 font-mono truncate">
                        {p.publicConfig.endpoint} · AK …{p.accessKeyLast4 ?? '????'}
                      </div>
                      {p.lastTestSummary && (
                        <div className={`text-xs mt-1 ${p.lastTestOk ? 'text-[var(--color-cta)]' : 'text-red-500'}`}>
                          最近探测：{p.lastTestSummary}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0">
                      {p.status !== 'disabled' && p.status !== 'active' && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={!writable || busyId === p.id}
                          onClick={() => void runTest(p.id)}
                        >
                          测试连接
                        </button>
                      )}
                      {p.status === 'verified' && (
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={!writable || busyId === p.id}
                          onClick={() => setConfirmTarget({ id: p.id, action: 'activate', name: p.name })}
                          data-testid={`storage-activate-${p.id}`}
                        >
                          激活
                        </button>
                      )}
                      {p.status === 'active' && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={!writable || busyId === p.id}
                          onClick={() => setConfirmTarget({ id: p.id, action: 'rollback', name: p.name })}
                        >
                          回滚
                        </button>
                      )}
                      {p.status !== 'active' && p.status !== 'disabled' && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm text-red-500"
                          disabled={!writable || busyId === p.id}
                          onClick={() => setConfirmTarget({ id: p.id, action: 'disable', name: p.name })}
                        >
                          禁用
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Preset cards & Create Form */}
          <section className="border-t border-[var(--color-border)] pt-6">
            <h3 className="font-semibold text-[var(--color-text)] mb-2">添加云存储提供商配置</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {status.presets.map(p => (
                <button
                  key={p.type}
                  type="button"
                  disabled={!writable}
                  onClick={() => applyPreset(p.type)}
                  className="text-left rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:border-[var(--color-primary)]/40 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                  data-testid={`storage-preset-${p.type}`}
                >
                  <ProviderIcon type={p.type} className="w-9 h-9 mb-2" />
                  <div className="font-bold text-sm text-[var(--color-text)]">{p.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-2">{p.notes}</div>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {showForm && writable && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 space-y-3"
          data-testid="storage-provider-form"
        >
          <h3 className="font-bold text-[var(--color-text)]">新建配置 · {selectedPreset?.label ?? form.type}</h3>
          {selectedPreset && (
            <p className="text-xs text-[var(--color-text-muted)]">
              服务地址示例：<code className="font-mono">{selectedPreset.endpointHint}</code>
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">显示名称</span>
              <input className="input w-full" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">服务地址（Endpoint）</span>
              <input className="input w-full font-mono text-xs" value={form.endpoint} onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))} required placeholder="https://..." />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">区域（Region）</span>
              <input className="input w-full" value={form.region} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1 flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={e => setForm(f => ({ ...f, forcePathStyle: e.target.checked }))}
              />
              <span className="text-[var(--color-text-muted)]">使用路径式访问（Path-style）</span>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">公共文件存储桶</span>
              <input className="input w-full" value={form.publicBucket} onChange={e => setForm(f => ({ ...f, publicBucket: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">私有交付存储桶</span>
              <input className="input w-full" value={form.privateBucket} onChange={e => setForm(f => ({ ...f, privateBucket: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">公有 URL 前缀（可选）</span>
              <input className="input w-full font-mono text-xs" value={form.publicUrlBase || ''} onChange={e => setForm(f => ({ ...f, publicUrlBase: e.target.value }))} placeholder="https://cdn.example.com/bucket" />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">交付预签名 Host（可选）</span>
              <input className="input w-full font-mono text-xs" value={form.deliveryPublicEndpoint || ''} onChange={e => setForm(f => ({ ...f, deliveryPublicEndpoint: e.target.value }))} placeholder="https://files.example.com" />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">访问凭证标识（Access Key）</span>
              <input className="input w-full font-mono" type="password" autoComplete="off" value={form.accessKey} onChange={e => setForm(f => ({ ...f, accessKey: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">访问凭证密钥（Secret Key）</span>
              <input className="input w-full font-mono" type="password" autoComplete="off" value={form.secretKey} onChange={e => setForm(f => ({ ...f, secretKey: e.target.value }))} required />
            </label>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" className="btn-primary" disabled={creating} data-testid="storage-provider-save">
              {creating ? '保存中…' : '保存为草稿'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => { if (!open && !actionLoading) setConfirmTarget(null) }}
        title={
          confirmTarget?.action === 'activate'
            ? '激活对象存储配置'
            : confirmTarget?.action === 'rollback'
              ? '回滚存储写入目标'
              : '禁用存储配置'
        }
        description={
          confirmTarget?.action === 'activate'
            ? `确认激活配置「${confirmTarget.name}」？激活后新上传将写入该提供商，历史对象仍按各自绑定位置读取。`
            : confirmTarget?.action === 'rollback'
              ? '确认回滚写入目标？新上传将回到上一配置或部署默认存储，历史文件不受影响。'
              : `确认禁用配置「${confirmTarget?.name}」？禁用后不可再作为激活目标；已存储的历史文件仍可按原位置读取，不会被删除。`
        }
        confirmLabel={
          actionLoading
            ? '执行中…'
            : confirmTarget?.action === 'activate'
              ? '确认激活'
              : confirmTarget?.action === 'rollback'
                ? '确认回滚'
                : '确认禁用'
        }
        tone={confirmTarget?.action === 'activate' ? 'primary' : 'danger'}
        loading={actionLoading}
        onConfirm={async () => {
          if (confirmTarget) {
            await executeAction(confirmTarget.id, confirmTarget.action)
          }
        }}
      />
    </div>
  )
}
