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

  async function runAction(
    id: number,
    action: 'test' | 'activate' | 'rollback' | 'disable',
  ) {
    if (!writable) return
    if (action === 'activate') {
      const ok = window.confirm(
        '激活后，新上传将写入该提供商。历史对象仍按各自绑定位置读取，不会自动迁移。是否继续？',
      )
      if (!ok) return
    }
    if (action === 'rollback') {
      const ok = window.confirm('确认回滚写入目标？新上传将回到上一配置或环境变量底座。')
      if (!ok) return
    }
    setBusyId(id)
    try {
      if (action === 'test') {
        const res = await testAdminStorageProvider(id)
        showToast(res.probe.ok ? res.probe.summary : `探测失败：${res.probe.summary}`, res.probe.ok ? 'success' : 'error')
      } else if (action === 'activate') {
        await activateAdminStorageProvider(id)
        showToast('已激活：新写入将使用该提供商')
      } else if (action === 'rollback') {
        await rollbackAdminStorageProvider(id)
        showToast('已回滚写入目标')
      } else {
        await disableAdminStorageProvider(id)
        showToast('已禁用该配置')
      }
      await reload()
    } catch (err) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
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
            默认使用部署环境中的 MinIO / S3 底座。云厂商配置是加密覆盖层：保存 → 测试 → 激活分步进行；历史文件按对象绑定读取，不会因切换而静默读错副本。
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
                    {status.bootstrap.healthy ? '底座可用' : '底座异常'}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    写入目标：{status.runtime.writeTarget === 'bootstrap' ? '环境变量底座' : `配置 #${status.runtime.activeConfigId}`}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">主机 </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.endpointHost ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">Region </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.region ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">公有桶 </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.publicBucket ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)] inline">私有桶 </dt>
                    <dd className="inline font-mono text-[var(--color-text)]">{status.bootstrap.privateBucket ?? '—'}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-[var(--color-text-muted)] inline">诊断 </dt>
                    <dd className="inline text-[var(--color-text)]">{status.bootstrap.healthDetail}</dd>
                  </div>
                </dl>
                <p className="text-xs text-[var(--color-text-muted)] mt-3">
                  配置源：<code className="font-mono">{status.configSource}</code>
                  {' · '}
                  UI 写操作：{status.uiConfigEnabled ? '开启' : '关闭'}
                  {' · '}
                  凭证主密钥：{status.credentialsEncKeyConfigured ? '已配置' : '未配置'}
                  {' · '}
                  runtime 版本：{status.runtime.configVersion}
                </p>
              </div>
            </div>
          </section>

          {(!status.uiConfigEnabled || status.configSource === 'env') && (
            <div className="flex gap-2 items-start rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {status.configSource === 'env'
                  ? 'STORAGE_CONFIG_SOURCE=env：已熔断，仅使用环境变量底座，后台无法激活云配置。'
                  : 'STORAGE_UI_CONFIG_ENABLED=false：控制台只读。'}
              </span>
            </div>
          )}

          {/* Preset cards */}
          <section>
            <h3 className="font-semibold text-[var(--color-text)] mb-2">添加云提供商</h3>
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
              Endpoint 示例：<code className="font-mono">{selectedPreset.endpointHint}</code>
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">显示名称</span>
              <input className="input w-full" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">Endpoint</span>
              <input className="input w-full font-mono text-xs" value={form.endpoint} onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))} required placeholder="https://..." />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">Region</span>
              <input className="input w-full" value={form.region} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1 flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={e => setForm(f => ({ ...f, forcePathStyle: e.target.checked }))}
              />
              <span className="text-[var(--color-text-muted)]">Path-style 寻址</span>
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">公有桶（商品图）</span>
              <input className="input w-full" value={form.publicBucket} onChange={e => setForm(f => ({ ...f, publicBucket: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">私有桶（交付文件）</span>
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
              <span className="text-[var(--color-text-muted)]">Access Key</span>
              <input className="input w-full font-mono" type="password" autoComplete="off" value={form.accessKey} onChange={e => setForm(f => ({ ...f, accessKey: e.target.value }))} required />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-[var(--color-text-muted)]">Secret Key</span>
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

      <section>
        <h3 className="font-semibold text-[var(--color-text)] mb-2">已保存配置</h3>
        {providers.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] py-4">暂无云配置，新上传使用环境变量底座。</p>
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
                      onClick={() => void runAction(p.id, 'test')}
                    >
                      测试连接
                    </button>
                  )}
                  {p.status === 'verified' && (
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      disabled={!writable || busyId === p.id}
                      onClick={() => void runAction(p.id, 'activate')}
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
                      onClick={() => void runAction(p.id, 'rollback')}
                    >
                      回滚
                    </button>
                  )}
                  {p.status !== 'active' && p.status !== 'disabled' && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm text-red-500"
                      disabled={!writable || busyId === p.id}
                      onClick={() => void runAction(p.id, 'disable')}
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
    </div>
  )
}
