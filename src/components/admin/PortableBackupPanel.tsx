import { FormEvent, useEffect, useState } from 'react'
import { AlertTriangle, Download, FileArchive, LoaderCircle, Upload } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import {
  createPortableBackup,
  downloadPortableBackup,
  getPortableBackup,
  restorePortableBackup,
  type PortableBackupJob,
} from '../../api/portableBackups'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import ConfirmDialog from '../ui/ConfirmDialog'

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '-'
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
export default function PortableBackupPanel() {
  const showToast = useAppStore((state) => state.showToast)
  const logout = useAuthStore((state) => state.logout)
  const [exportPassphrase, setExportPassphrase] = useState('')
  const [job, setJob] = useState<PortableBackupJob | null>(null)
  const [creating, setCreating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPassphrase, setImportPassphrase] = useState('')
  const [importing, setImporting] = useState(false)
  const [confirmingRestore, setConfirmingRestore] = useState(false)

  useEffect(() => {
    if (!job || job.state !== 'running') return
    const timer = window.setInterval(() => {
      getPortableBackup(job.id)
        .then(setJob)
        .catch((err) => {
          window.clearInterval(timer)
          showToast(getApiErrorMessage(err, '无法获取备份进度'), 'error')
        })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.state, showToast])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (exportPassphrase.length < 12) {
      showToast('备份口令至少 12 个字符', 'error')
      return
    }
    setCreating(true)
    try {
      setJob(await createPortableBackup(exportPassphrase))
      setExportPassphrase('')
      showToast('正在创建加密备份包，请保持此页面打开')
    } catch (err) {
      showToast(getApiErrorMessage(err, '创建备份失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  async function handleDownload() {
    if (!job || job.state !== 'ready') return
    setDownloading(true)
    try {
      await downloadPortableBackup(job)
      showToast('备份包已开始下载；请妥善保存口令和文件')
    } catch (err) {
      showToast(getApiErrorMessage(err, '下载备份失败'), 'error')
    } finally {
      setDownloading(false)
    }
  }

  function handleRestore(event: FormEvent) {
    event.preventDefault()
    if (!importFile) {
      showToast('请选择 .monexus-backup 文件', 'error')
      return
    }
    if (importPassphrase.length < 12) {
      showToast('备份口令至少 12 个字符', 'error')
      return
    }
    setConfirmingRestore(true)
  }

  async function doRestore() {
    if (!importFile) return
    setImporting(true)
    try {
      const result = await restorePortableBackup(importFile, importPassphrase)
      showToast(`已恢复 ${result.objectCount} 个对象，即将退出并请重新登录`)
      logout()
    } catch (err) {
      showToast(getApiErrorMessage(err, '导入失败'), 'error')
    } finally {
      setImporting(false)
      setImportPassphrase('')
      setConfirmingRestore(false)
    }
  }

  const taskDescription = !job
    ? '尚未创建备份'
    : job.state === 'running'
      ? '正在导出数据库与对象文件…'
      : job.state === 'ready'
        ? `已完成：${formatBytes(job.byteSize)}，${job.objectCount ?? 0} 个对象`
        : job.error ?? '备份创建失败'

  return (
    <div className="space-y-8" data-testid="portable-backup-panel">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 space-y-4">
        <div className="flex gap-3 items-start">
          <FileArchive className="w-5 h-5 text-[var(--color-primary)] mt-0.5 shrink-0" />
          <div>
            <h3 className="font-bold text-[var(--color-text)]">创建可移植备份</h3>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              导出数据库和上传文件为一个加密包。环境变量、JWT、数据库和对象存储密钥不会被导出。
            </p>
          </div>
        </div>

        <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <label className="block flex-grow">
            <span className="text-sm font-medium text-[var(--color-text)]">备份口令（至少 12 字符）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={exportPassphrase}
              onChange={(event) => setExportPassphrase(event.target.value)}
              disabled={creating || job?.state === 'running'}
              className="input mt-1 w-full"
            />
          </label>
          <button
            type="submit"
            disabled={creating || job?.state === 'running'}
            className="btn-cta px-4 py-2.5 disabled:opacity-50"
          >
            {creating || job?.state === 'running' ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <FileArchive className="w-4 h-4" />}
            {creating || job?.state === 'running' ? '创建中' : '创建备份'}
          </button>
        </form>

        <div className={`text-sm rounded-md px-3 py-2 ${job?.state === 'failed' ? 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]' : 'bg-[var(--color-primary)]/8 text-[var(--color-text-muted)]'}`}>
          {taskDescription}
        </div>
        {job?.state === 'ready' && (
          <button onClick={handleDownload} disabled={downloading} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
            {downloading ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            下载 {job.fileName}
          </button>
        )}
      </section>

      <section className="rounded-lg border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/5 p-5 space-y-4">
        <div className="flex gap-3 items-start">
          <AlertTriangle className="w-5 h-5 text-[var(--color-danger)] mt-0.5 shrink-0" />
          <div>
            <h3 className="font-bold text-[var(--color-text)]">导入到新实例</h3>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              仅允许全新、没有业务数据的实例导入。系统会保留当前登录的引导管理员，并撤销所有旧会话。
            </p>
          </div>
        </div>

        <form onSubmit={handleRestore} className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-[var(--color-text)]">备份文件</span>
            <input
              type="file"
              accept=".monexus-backup,application/octet-stream"
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
              disabled={importing}
              className="block mt-1 text-sm text-[var(--color-text-muted)]"
            />
          </label>
          <label className="block max-w-xl">
            <span className="text-sm font-medium text-[var(--color-text)]">备份口令</span>
            <input
              type="password"
              autoComplete="current-password"
              value={importPassphrase}
              onChange={(event) => setImportPassphrase(event.target.value)}
              disabled={importing}
              className="input mt-1 w-full"
            />
          </label>
          <button type="submit" disabled={importing} className="btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)] disabled:opacity-50">
            {importing ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {importing ? '正在校验并导入' : '导入备份'}
          </button>
        </form>
      </section>

      {/* Restore confirm — replaces window.confirm */}
      <ConfirmDialog
        open={confirmingRestore}
        onOpenChange={setConfirmingRestore}
        title="导入备份"
        description="导入会替换当前空实例的业务数据并使当前会话失效，确定继续吗？"
        confirmLabel="继续导入"
        tone="danger"
        loading={importing}
        onConfirm={doRestore}
      />
    </div>
  )
}
