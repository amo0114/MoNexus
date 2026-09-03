import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, FolderLock, Loader2 } from 'lucide-react'
import {
  listAdminDeliveryFiles,
  listAdminFileGrants,
  revokeAdminDeliveryFile,
  AdminDeliveryFile,
  AdminFileGrant,
} from '../../api/adminFiles'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { formatFileSize } from '../../utils/formatFileSize'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import AdminPagination from './AdminPagination'

const PAGE_SIZE = 20
const GRANTS_PAGE_SIZE = 10

/** P5.5 T1：管理端「文件治理」tab——交付文件列表、发放流水与吊销（自行拉取数据）。 */
export default function AdminFileGovernance() {
  const showToast = useAppStore((s) => s.showToast)

  const [files, setFiles] = useState<AdminDeliveryFile[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const filesReqSeqRef = useRef(0)

  const [filterStatus, setFilterStatus] = useState('')
  const [filterMerchantId, setFilterMerchantId] = useState('')
  const [filterFileName, setFilterFileName] = useState('')

  // 发放流水（行展开面板，同一时刻只展开一个文件）
  const [expandedFileId, setExpandedFileId] = useState<number | null>(null)
  const expandedFileIdRef = useRef<number | null>(null)
  const grantsReqSeqRef = useRef(0)

  const [grants, setGrants] = useState<AdminFileGrant[]>([])
  const [grantsTotal, setGrantsTotal] = useState(0)
  const [grantsPage, setGrantsPage] = useState(1)
  const [grantsLoading, setGrantsLoading] = useState(false)

  // 吊销确认弹窗
  const [revokeTarget, setRevokeTarget] = useState<AdminDeliveryFile | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [revoking, setRevoking] = useState(false)

  function updateExpandedFile(id: number | null) {
    expandedFileIdRef.current = id
    setExpandedFileId(id)
  }

  async function fetchFiles(
    pageArg: number,
    overrides?: { status?: string; merchantId?: string; fileName?: string },
  ) {
    const seq = ++filesReqSeqRef.current
    setLoading(true)
    try {
      const status = overrides?.status ?? filterStatus
      const merchantId = overrides?.merchantId ?? filterMerchantId
      const fileName = overrides?.fileName ?? filterFileName
      const query: Parameters<typeof listAdminDeliveryFiles>[0] = { page: pageArg, pageSize: PAGE_SIZE }
      if (status) query.status = status
      if (merchantId) query.merchantId = Number(merchantId)
      if (fileName) query.fileName = fileName
      const data = await listAdminDeliveryFiles(query)
      if (seq !== filesReqSeqRef.current) return
      setFiles(data.items)
      setTotal(data.total)
    } catch (err: any) {
      if (seq !== filesReqSeqRef.current) return
      showToast(getApiErrorMessage(err, '加载文件列表失败'), 'error')
    } finally {
      if (seq === filesReqSeqRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    grantsReqSeqRef.current++
    updateExpandedFile(null)
    setGrants([])
    setGrantsTotal(0)
    setGrantsPage(1)
    setGrantsLoading(false)
    fetchFiles(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  function handleSearch() {
    grantsReqSeqRef.current++
    updateExpandedFile(null)
    setGrants([])
    setGrantsTotal(0)
    setGrantsPage(1)
    setGrantsLoading(false)
    if (page === 1) fetchFiles(1)
    else setPage(1)
  }

  function handleReset() {
    setFilterStatus('')
    setFilterMerchantId('')
    setFilterFileName('')
    grantsReqSeqRef.current++
    updateExpandedFile(null)
    setGrants([])
    setGrantsTotal(0)
    setGrantsPage(1)
    setGrantsLoading(false)
    if (page === 1) fetchFiles(1, { status: '', merchantId: '', fileName: '' })
    else setPage(1)
  }

  async function loadGrants(fileId: number, pageArg: number) {
    const seq = ++grantsReqSeqRef.current
    setGrantsLoading(true)
    try {
      const data = await listAdminFileGrants(fileId, { page: pageArg, pageSize: GRANTS_PAGE_SIZE })
      // Guard: drop response if a newer request was dispatched or expandedFile changed
      if (seq !== grantsReqSeqRef.current || expandedFileIdRef.current !== fileId) {
        return
      }
      setGrants(data.items)
      setGrantsTotal(data.total)
      setGrantsPage(pageArg)
    } catch (err: any) {
      if (seq !== grantsReqSeqRef.current || expandedFileIdRef.current !== fileId) {
        return
      }
      showToast(getApiErrorMessage(err, '加载发放流水失败'), 'error')
    } finally {
      if (seq === grantsReqSeqRef.current && expandedFileIdRef.current === fileId) {
        setGrantsLoading(false)
      }
    }
  }

  function toggleGrants(fileId: number) {
    if (expandedFileIdRef.current === fileId) {
      grantsReqSeqRef.current++
      updateExpandedFile(null)
      setGrants([])
      setGrantsTotal(0)
      setGrantsPage(1)
      setGrantsLoading(false)
      return
    }
    grantsReqSeqRef.current++
    updateExpandedFile(fileId)
    setGrants([])
    setGrantsTotal(0)
    setGrantsPage(1)
    void loadGrants(fileId, 1)
  }

  async function handleRevoke() {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await revokeAdminDeliveryFile(revokeTarget.id, revokeReason.trim() || undefined)
      showToast('已吊销文件')
      setRevokeTarget(null)
      setRevokeReason('')
      fetchFiles(page)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '吊销失败'), 'error')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">文件治理</h2>
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="input py-1.5 w-32"
          data-testid="admin-file-status-filter"
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="revoked">已吊销</option>
          <option value="deleted">已删除</option>
        </select>
        <input
          type="text"
          placeholder="商家ID"
          value={filterMerchantId}
          onChange={(e) => setFilterMerchantId(e.target.value.replace(/\D/g, ''))}
          className="input py-1.5 w-32"
        />
        <input
          type="text"
          placeholder="文件名"
          value={filterFileName}
          onChange={(e) => setFilterFileName(e.target.value)}
          className="input py-1.5 w-40"
        />
        <button onClick={handleSearch} className="btn-primary py-1.5 text-sm">查询</button>
        <button onClick={handleReset} className="btn-secondary py-1.5 text-sm">重置</button>
      </div>
      <div className="overflow-x-auto">
        {loading && files.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="admin-table table-cards">
          <thead>
            <tr>
              <th>ID</th>
              <th>文件名</th>
              <th>大小</th>
              <th>SHA-256</th>
              <th>商家</th>
              <th>状态</th>
              <th>引用</th>
              <th>创建时间</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                expanded={expandedFileId === f.id}
                grants={grants}
                grantsTotal={grantsTotal}
                grantsPage={grantsPage}
                grantsLoading={grantsLoading}
                onToggleGrants={() => toggleGrants(f.id)}
                onGrantsPageChange={(p) => loadGrants(f.id, p)}
                onRevoke={() => {
                  setRevokeReason('')
                  setRevokeTarget(f)
                }}
              />
            ))}
            {!loading && files.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <EmptyState compact icon={FolderLock} title="暂无交付文件" description="商家上传的交付文件将出现在这里" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>
      <AdminPagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        testId="admin-file-pagination"
      />

      {/* 吊销确认弹窗（吊销后买家侧下载链接立即失效，需二次确认） */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => { if (!o && !revoking) setRevokeTarget(null) }}>
        <DialogContent className="max-w-sm" data-testid="admin-file-revoke-dialog">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)] flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>吊销文件</DialogTitle>
              <DialogDescription>
                确认吊销「{revokeTarget?.fileName}」？吊销后买家将无法再获取该文件的下载链接。
                当前引用：在售规格 {revokeTarget?.refCounts.offers ?? 0} 个 / 交付记录 {revokeTarget?.refCounts.deliveryRecords ?? 0} 条。
              </DialogDescription>
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
              吊销原因 - 可选
            </label>
            <textarea
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="如：版权投诉 / 内容违规..."
              className="input resize-none"
              data-testid="admin-file-revoke-reason"
            />
          </div>
          <div className="flex justify-end gap-3 mt-5">
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm"
              disabled={revoking}
              onClick={() => setRevokeTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)]"
              disabled={revoking}
              onClick={handleRevoke}
              data-testid="admin-file-revoke-confirm"
            >
              {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认吊销'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FileRow({
  file,
  expanded,
  grants,
  grantsTotal,
  grantsPage,
  grantsLoading,
  onToggleGrants,
  onGrantsPageChange,
  onRevoke,
}: {
  file: AdminDeliveryFile
  expanded: boolean
  grants: AdminFileGrant[]
  grantsTotal: number
  grantsPage: number
  grantsLoading: boolean
  onToggleGrants: () => void
  onGrantsPageChange: (page: number) => void
  onRevoke: () => void
}) {
  return (
    <>
      <tr>
        <td className="text-[var(--color-text-muted)] text-xs" data-label="ID">{file.id}</td>
        <td data-label="文件名">
          <div className="font-bold text-[var(--color-text)] text-sm truncate max-w-[200px]" title={file.fileName}>{file.fileName}</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{file.mimeType}</div>
        </td>
        <td className="text-sm text-[var(--color-text)] whitespace-nowrap" data-label="大小">{formatFileSize(file.size)}</td>
        <td className="font-mono text-xs text-[var(--color-text-muted)]" data-label="SHA-256">
          <span title={file.sha256 || undefined}>{file.sha256 ? `${file.sha256.slice(0, 12)}…` : '—'}</span>
        </td>
        <td className="font-bold text-sm text-[var(--color-text)]" data-label="商家">{file.merchant?.name ?? '-'}</td>
        <td data-label="状态"><FileStatusPill status={file.status} /></td>
        <td className="text-xs text-[var(--color-text-muted)] whitespace-nowrap" data-label="引用">
          在售规格 {file.refCounts.offers} / 交付记录 {file.refCounts.deliveryRecords}
        </td>
        <td className="text-[var(--color-text-muted)] text-xs whitespace-nowrap" data-label="创建时间">{new Date(file.createdAt).toLocaleString()}</td>
        <td className="text-right space-x-3 whitespace-nowrap" data-label="操作">
          <button
            type="button"
            onClick={onToggleGrants}
            className="text-[var(--color-primary)] hover:underline text-xs font-semibold cursor-pointer btn-sm"
            data-testid={`admin-file-grants-${file.id}`}
          >
            {expanded ? '收起流水' : '查看流水'}
          </button>
          <button
            type="button"
            onClick={onRevoke}
            disabled={file.status !== 'active'}
            className="text-[var(--color-danger)] hover:underline text-xs font-semibold cursor-pointer btn-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
            data-testid={`admin-file-revoke-${file.id}`}
          >
            吊销
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} className="bg-[var(--color-background)]" data-label="发放流水">
            <div className="p-3 space-y-2">
              <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">发放流水</div>
              {grantsLoading ? (
                <div className="text-xs text-[var(--color-text-muted)] py-2">加载中...</div>
              ) : grants.length === 0 ? (
                <div className="text-xs text-[var(--color-text-muted)] py-2">暂无发放记录</div>
              ) : (
                grants.map((g) => (
                  <div key={g.id} className="border border-[var(--color-border)] rounded-lg px-3 py-2 bg-[var(--color-surface)]">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <GrantOutcomePill outcome={g.outcome} />
                      <span className="font-bold text-[var(--color-text)]">{grantRoleLabel(g.role)}</span>
                      <span className="text-[var(--color-text)]">订单 #{g.orderId}</span>
                      <span className="text-[var(--color-text)]">用户 U{g.userId}</span>
                      <span className="text-[var(--color-text-muted)] ml-auto">{new Date(g.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)] flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>IP 哈希：{g.ipHash ? g.ipHash.slice(0, 12) : '-'}</span>
                      <span className="truncate max-w-[320px]" title={g.userAgent ?? undefined}>UA：{g.userAgent || '-'}</span>
                      {g.expiresAt && <span>链接有效期至 {new Date(g.expiresAt).toLocaleString()}</span>}
                    </div>
                  </div>
                ))
              )}
              <AdminPagination
                page={grantsPage}
                total={grantsTotal}
                pageSize={GRANTS_PAGE_SIZE}
                onPageChange={onGrantsPageChange}
                testId={`admin-grants-pagination-${file.id}`}
                showQuickJumper={false}
                hideOnSinglePage={true}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function FileStatusPill({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; border: string; label: string }> = {
    active:  { bg: 'bg-[var(--color-cta)]/10', text: 'text-[var(--color-cta)]', border: 'border-[var(--color-cta)]/25', label: '正常' },
    revoked: { bg: 'bg-red-500/10',            text: 'text-red-500',            border: 'border-red-500/25',            label: '已吊销' },
    deleted: { bg: 'bg-[var(--color-text-muted)]/10', text: 'text-[var(--color-text-muted)]', border: 'border-[var(--color-text-muted)]/25', label: '已删除' },
  }
  const s = styles[status] || { bg: 'bg-[var(--color-text-muted)]/10', text: 'text-[var(--color-text-muted)]', border: 'border-[var(--color-text-muted)]/25', label: status }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 text-xs rounded font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

function GrantOutcomePill({ outcome }: { outcome: string }) {
  const granted = outcome === 'granted'
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs rounded font-bold border ${
        granted
          ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
          : 'bg-red-500/10 text-red-500 border-red-500/25'
      }`}
    >
      {granted ? '已发放' : outcome}
    </span>
  )
}

function grantRoleLabel(role: string): string {
  const labels: Record<string, string> = { buyer: '买家', merchant: '商家', admin: '管理员' }
  return labels[role] ?? role
}
