import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '../../api/admin'
import {
  AdminAnnouncement,
  AnnouncementAudience,
  AnnouncementStatus,
  CreateAnnouncementRequest,
} from '../../types/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import AdminPagination from './AdminPagination'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'

const PAGE_SIZE = 20

const AUDIENCE_LABEL: Record<AnnouncementAudience, string> = {
  all: '全员',
  user: '用户',
  merchant: '商家',
  admin: '管理员',
}

const STATUS_LABEL: Record<AnnouncementStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
}

const STATUS_PILL: Record<AnnouncementStatus, string> = {
  draft: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]',
  published: 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25',
  archived: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]',
}

function toDateTimeLocalValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTimeWindow(a: AdminAnnouncement): string {
  const start = new Date(a.startsAt).toLocaleString()
  if (!a.endsAt) return `${start} 起长期`
  return `${start} ~ ${new Date(a.endsAt).toLocaleString()}`
}

interface EditorState {
  mode: 'create' | 'edit'
  id: number | null
  title: string
  content: string
  audience: AnnouncementAudience
  priority: string
  startsAt: string
  endsAt: string
  hasEndsAt: boolean
  status: AnnouncementStatus
}

const emptyEditor: EditorState = {
  mode: 'create',
  id: null,
  title: '',
  content: '',
  audience: 'all',
  priority: '0',
  startsAt: toDateTimeLocalValue(new Date().toISOString()),
  endsAt: '',
  hasEndsAt: false,
  status: 'draft',
}

export default function AnnouncementsAdmin() {
  const showToast = useAppStore((s) => s.showToast)

  const [items, setItems] = useState<AdminAnnouncement[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<'draft' | 'published' | 'archived' | ''>('')
  const [audienceFilter, setAudienceFilter] = useState<AnnouncementAudience | ''>('')

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetchList()
  }, [page, statusFilter, audienceFilter])

  async function fetchList() {
    try {
      const data = await getAnnouncements({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
        audience: audienceFilter || undefined,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载公告列表失败'), 'error')
    }
  }

  function openCreate() {
    setEditor({ ...emptyEditor })
  }

  function openEdit(a: AdminAnnouncement) {
    setEditor({
      mode: 'edit',
      id: a.id,
      title: a.title,
      content: a.content,
      audience: a.audience,
      priority: String(a.priority),
      startsAt: toDateTimeLocalValue(a.startsAt),
      endsAt: a.endsAt ? toDateTimeLocalValue(a.endsAt) : '',
      hasEndsAt: a.endsAt !== null,
      status: a.status,
    })
  }

  async function handleSubmit() {
    if (!editor) return
    if (!editor.title.trim() || !editor.content.trim()) {
      showToast('标题和内容不能为空', 'error')
      return
    }
    const priority = parseInt(editor.priority, 10)
    if (Number.isNaN(priority) || priority < -1000 || priority > 1000) {
      showToast('优先级需为 -1000 到 1000 之间的整数', 'error')
      return
    }
    const start = new Date(editor.startsAt)
    if (Number.isNaN(start.getTime())) {
      showToast('开始时间无效', 'error')
      return
    }
    const startsAt = start.toISOString()
    let endsAt: string | null = null
    if (editor.hasEndsAt) {
      if (!editor.endsAt) {
        showToast('请填写结束时间或取消长期选项', 'error')
        return
      }
      const end = new Date(editor.endsAt)
      if (Number.isNaN(end.getTime())) {
        showToast('结束时间无效', 'error')
        return
      }
      if (end.getTime() < start.getTime()) {
        showToast('结束时间必须晚于开始时间', 'error')
        return
      }
      endsAt = end.toISOString()
    }

    const payload: CreateAnnouncementRequest = {
      title: editor.title.trim(),
      content: editor.content.trim(),
      audience: editor.audience,
      priority,
      startsAt,
      endsAt,
      status: editor.status,
    }

    setSubmitting(true)
    try {
      if (editor.mode === 'create') {
        await createAnnouncement(payload)
        showToast('已创建公告')
      } else if (editor.id !== null) {
        await updateAnnouncement(editor.id, payload)
        showToast('已更新公告')
      }
      setEditor(null)
      fetchList()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(a: AdminAnnouncement) {
    if (!confirm(`确定要删除公告「${a.title}」吗？此操作不可恢复。`)) return
    try {
      await deleteAnnouncement(a.id)
      showToast('已删除公告')
      fetchList()
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '删除失败'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">公告管理</h2>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as typeof statusFilter)
            setPage(1)
          }}
          data-testid="admin-announcement-status-filter"
          className="input !py-1.5 !text-sm w-36"
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="published">已发布</option>
          <option value="archived">已归档</option>
        </select>
        <select
          value={audienceFilter}
          onChange={(e) => {
            setAudienceFilter(e.target.value as typeof audienceFilter)
            setPage(1)
          }}
          data-testid="admin-announcement-audience-filter"
          className="input !py-1.5 !text-sm w-36"
        >
          <option value="">全部受众</option>
          <option value="all">全员</option>
          <option value="user">用户</option>
          <option value="merchant">商家</option>
          <option value="admin">管理员</option>
        </select>
        <div className="flex-1" />
        <button
          type="button"
          className="btn-primary !px-4 !py-2 !text-sm flex items-center gap-1.5 cursor-pointer"
          data-testid="admin-announcement-create"
          onClick={openCreate}
        >
          <Plus className="w-4 h-4" />
          新建公告
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="admin-table">
          <thead>
            <tr>
              <th>标题 / 内容</th>
              <th>受众</th>
              <th>优先级</th>
              <th>状态</th>
              <th>时间窗口</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="font-bold text-[var(--color-text)]">{a.title}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-1 max-w-md">
                    {a.content}
                  </div>
                </td>
                <td>
                  <span className="text-xs font-bold px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text-muted)]">
                    {AUDIENCE_LABEL[a.audience]}
                  </span>
                </td>
                <td className="font-mono font-bold text-[var(--color-text)]">{a.priority}</td>
                <td>
                  <span className={`inline-flex items-center px-2.5 py-1 text-[11px] rounded font-bold border ${STATUS_PILL[a.status]}`}>
                    {STATUS_LABEL[a.status]}
                  </span>
                </td>
                <td className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                  {formatTimeWindow(a)}
                </td>
                <td className="text-right space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer inline-flex items-center gap-1"
                    data-testid={`admin-announcement-edit-${a.id}`}
                    onClick={() => openEdit(a)}
                  >
                    <Pencil className="w-3 h-3" />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-danger)]/25 cursor-pointer inline-flex items-center gap-1"
                    data-testid={`admin-announcement-delete-${a.id}`}
                    onClick={() => handleDelete(a)}
                  >
                    <Trash2 className="w-3 h-3" />
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-[var(--color-text-muted)]">
                  暂无公告
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} testId="admin-announcement-pagination" />

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setEditor(null)
        }}
      >
        <DialogContent className="!z-[120] !max-w-lg" data-testid="admin-announcement-editor-dialog">
          <DialogTitle>{editor?.mode === 'edit' ? '编辑公告' : '新建公告'}</DialogTitle>
          <DialogDescription>
            公告按优先级倒序展示；仅已发布且在时间窗口内的条目对用户可见。
          </DialogDescription>
          {editor && (
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">标题</label>
                <input
                  type="text"
                  className="input text-sm"
                  value={editor.title}
                  onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                  maxLength={200}
                  data-testid="admin-announcement-title"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">内容</label>
                <textarea
                  className="input min-h-[96px] resize-y text-sm"
                  value={editor.content}
                  onChange={(e) => setEditor({ ...editor, content: e.target.value })}
                  maxLength={5000}
                  data-testid="admin-announcement-content"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">受众</label>
                  <select
                    className="input text-sm"
                    value={editor.audience}
                    onChange={(e) => setEditor({ ...editor, audience: e.target.value as AnnouncementAudience })}
                    data-testid="admin-announcement-audience"
                  >
                    <option value="all">全员</option>
                    <option value="user">用户</option>
                    <option value="merchant">商家</option>
                    <option value="admin">管理员</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">优先级 (-1000 ~ 1000)</label>
                  <input
                    type="number"
                    className="input text-sm"
                    value={editor.priority}
                    onChange={(e) => setEditor({ ...editor, priority: e.target.value })}
                    min={-1000}
                    max={1000}
                    data-testid="admin-announcement-priority"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">开始时间</label>
                  <input
                    type="datetime-local"
                    className="input text-sm"
                    value={editor.startsAt}
                    onChange={(e) => setEditor({ ...editor, startsAt: e.target.value })}
                    data-testid="admin-announcement-starts-at"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">状态</label>
                  <select
                    className="input text-sm"
                    value={editor.status}
                    onChange={(e) => setEditor({ ...editor, status: e.target.value as AnnouncementStatus })}
                    data-testid="admin-announcement-status"
                  >
                    <option value="draft">草稿</option>
                    <option value="published">已发布</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editor.hasEndsAt}
                    onChange={(e) => setEditor({ ...editor, hasEndsAt: e.target.checked })}
                    className="accent-[var(--color-primary)]"
                  />
                  指定结束时间（未勾选则长期有效）
                </label>
                {editor.hasEndsAt && (
                  <input
                    type="datetime-local"
                    className="input text-sm mt-2"
                    value={editor.endsAt}
                    onChange={(e) => setEditor({ ...editor, endsAt: e.target.value })}
                    data-testid="admin-announcement-ends-at"
                  />
                )}
              </div>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              className="btn-secondary !px-4 !py-2 !text-sm"
              disabled={submitting}
              onClick={() => setEditor(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary !px-4 !py-2 !text-sm"
              disabled={submitting}
              onClick={handleSubmit}
              data-testid="admin-announcement-submit"
            >
              {submitting ? '提交中…' : editor?.mode === 'edit' ? '保存修改' : '创建公告'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
