import { useEffect, useState } from 'react'
import { AdminBuildInfo, getAdminBuildInfo } from '../../api/adminBuildInfo'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

function shortSha(commit: string): string {
  return commit.slice(0, 7)
}

export default function AdminSystemInfoPanel() {
  const showToast = useAppStore((s) => s.showToast)
  const [info, setInfo] = useState<AdminBuildInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    void fetchInfo()
  }, [])

  async function fetchInfo() {
    setLoading(true)
    try {
      setInfo(await getAdminBuildInfo())
      setLoadError(false)
    } catch (err) {
      setLoadError(true)
      showToast(getApiErrorMessage(err, '加载构建信息失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function copyCommit() {
    if (!info?.commit) return
    try {
      await navigator.clipboard.writeText(info.commit)
      showToast('已复制完整提交哈希')
    } catch {
      showToast('复制失败', 'error')
    }
  }

  if (loading) {
    return <div className="text-sm text-[var(--color-text-muted)] py-4">加载中...</div>
  }

  if (loadError || !info) {
    return (
      <div className="text-sm text-[var(--color-danger)] py-2" data-testid="admin-system-info-error">
        构建信息加载失败
        <button type="button" className="btn-secondary btn-sm ml-3 px-3" onClick={() => void fetchInfo()}>
          重试
        </button>
      </div>
    )
  }

  const unavailable = info.source === 'unavailable'

  return (
    <section data-testid="admin-system-info-panel">
      {unavailable && (
        <p className="text-sm text-[var(--color-text-muted)] mb-4" data-testid="admin-system-info-unavailable">
          构建信息未提供
        </p>
      )}

      <dl className="text-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
          <dt className="text-[var(--color-text-muted)] sm:w-24 shrink-0">运行版本</dt>
          <dd data-testid="admin-system-info-version" className="font-mono text-[var(--color-text)] break-all">
            {unavailable || !info.version ? '构建信息未提供' : info.version}
          </dd>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
          <dt className="text-[var(--color-text-muted)] sm:w-24 shrink-0">环境</dt>
          <dd data-testid="admin-system-info-environment" className="text-[var(--color-text)]">
            {info.environment}
          </dd>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
          <dt className="text-[var(--color-text-muted)] sm:w-24 shrink-0">提交</dt>
          <dd className="flex flex-wrap items-center gap-2 min-w-0">
            <span data-testid="admin-system-info-commit" className="font-mono text-[var(--color-text)] break-all">
              {unavailable || !info.commit ? '构建信息未提供' : shortSha(info.commit)}
            </span>
            {!unavailable && info.commit && (
              <button
                type="button"
                onClick={() => void copyCommit()}
                data-testid="admin-system-info-copy-commit"
                className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
              >
                复制完整哈希
              </button>
            )}
          </dd>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
          <dt className="text-[var(--color-text-muted)] sm:w-24 shrink-0">构建时间</dt>
          <dd data-testid="admin-system-info-built-at" className="font-mono text-[var(--color-text)] break-all">
            {unavailable || !info.builtAt ? '构建信息未提供' : info.builtAt}
          </dd>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
          <dt className="text-[var(--color-text-muted)] sm:w-24 shrink-0">发行标签</dt>
          <dd data-testid="admin-system-info-release-tag" className="text-[var(--color-text)] break-all">
            {unavailable ? '构建信息未提供' : info.releaseTag ?? '未记录标签'}
          </dd>
        </div>
      </dl>
    </section>
  )
}
