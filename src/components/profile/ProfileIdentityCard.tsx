import { useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { updateMe } from '../../api/auth'
import { uploadImage, UploadError } from '../../api/uploads'
import { getApiErrorMessage } from '../../api/error'
import AvatarPresetDialog from './AvatarPresetDialog'
import UserAvatar from '../ui/UserAvatar'

/**
 * 标准个人资料卡：预设/上传头像 + 昵称。
 * 替代原先「仅评价用」的孤立昵称卡,作为个性化主入口。
 */
export default function ProfileIdentityCard() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const showToast = useAppStore((s) => s.showToast)
  const fileRef = useRef<HTMLInputElement>(null)

  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [savingNick, setSavingNick] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [choosingAvatar, setChoosingAvatar] = useState(false)

  async function handleSavePreset(avatarUrl: string) {
    if (!user || uploading) return
    setUploading(true)
    try {
      const me = await updateMe({ avatarUrl })
      setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null })
      setChoosingAvatar(false)
      showToast('头像已更新')
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '头像保存失败，请重试'), 'error')
    } finally {
      setUploading(false)
    }
  }

  async function handleSaveNickname() {
    const value = nickname.trim()
    if (!value || value.length > 20) {
      showToast('昵称需为 1-20 个字符', 'error')
      return
    }
    setSavingNick(true)
    try {
      const me = await updateMe({ nickname: value })
      setUser({ ...user!, ...me, merchant: me.merchant ?? user?.merchant ?? null })
      showToast('昵称已更新')
      setEditing(false)
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setSavingNick(false)
    }
  }

  async function handleAvatarFile(file: File | null) {
    if (!file || !user) return
    setUploading(true)
    try {
      const { url } = await uploadImage(file)
      const me = await updateMe({ avatarUrl: url })
      setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null })
      showToast('头像已更新')
    } catch (err: unknown) {
      if (err instanceof UploadError) {
        showToast(err.message, 'error')
      } else {
        showToast(getApiErrorMessage(err, '头像上传失败'), 'error')
      }
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleClearAvatar() {
    if (!user?.avatarUrl) return
    setUploading(true)
    try {
      const me = await updateMe({ avatarUrl: null })
      setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null })
      showToast('已恢复默认头像')
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '清除头像失败'), 'error')
    } finally {
      setUploading(false)
    }
  }

  const displayName = user?.nickname || user?.email || '用户'

  return (
    <div className="card flex flex-col gap-4" data-testid="nickname-card">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setChoosingAvatar(true)}
            disabled={uploading || savingNick}
            className="group relative w-16 h-16 rounded-full overflow-hidden border-2 border-[var(--color-border)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer disabled:opacity-60"
            aria-label="更换头像"
            data-testid="avatar-edit"
          >
            <UserAvatar url={user?.avatarUrl} name={displayName} size={60} className="text-xl" />
            <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              {uploading ? (
                <Loader2 className="w-5 h-5 text-white animate-spin" />
              ) : (
                <Camera className="w-5 h-5 text-white" />
              )}
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            data-testid="avatar-file-input"
            onChange={(e) => void handleAvatarFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-heading font-bold text-[var(--color-text)] mb-0.5">个人资料</h4>
          <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
            选择喜欢的三国头像，或上传自己的图片，让个人资料更有个性。
          </p>
          <button type="button" onClick={() => setChoosingAvatar(true)} disabled={uploading || savingNick} className="mt-2 text-sm text-[var(--color-primary)] underline cursor-pointer disabled:opacity-60">选择头像</button>
          {user?.avatarUrl && (
            <button
              type="button"
              onClick={() => void handleClearAvatar()}
              disabled={uploading || savingNick}
              className="ml-4 mt-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] underline cursor-pointer"
            >
              清除头像
            </button>
          )}
        </div>
      </div>

      {choosingAvatar && (
        <AvatarPresetDialog
          currentUrl={user?.avatarUrl} busy={uploading}
          onClose={() => setChoosingAvatar(false)} onSave={handleSavePreset}
          onUpload={() => { setChoosingAvatar(false); fileRef.current?.click() }}
        />
      )}

      <div className="border-t border-[var(--color-border)] pt-4">
        {editing ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input w-full min-w-0 flex-1 py-2"
              maxLength={20}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              disabled={savingNick || uploading}
              placeholder="1–20 个字符"
              data-testid="nickname-input"
            />
            <button
              type="button"
              onClick={() => void handleSaveNickname()}
              disabled={savingNick || uploading}
              className="btn-primary w-full shrink-0 px-4 py-2 text-sm sm:w-auto"
              data-testid="nickname-save"
            >
              {savingNick ? '保存中...' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={savingNick || uploading}
              className="btn-secondary w-full shrink-0 px-4 py-2 text-sm sm:w-auto"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs text-[var(--color-text-muted)] mb-0.5">昵称</p>
              <span className="min-w-0 break-words text-sm font-bold text-[var(--color-text)]">
                {user?.nickname || '未设置'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setNickname(user?.nickname ?? '')
                setEditing(true)
              }}
              className="btn-secondary shrink-0 self-start px-4 py-1.5 text-xs btn-sm sm:self-auto"
              data-testid="nickname-edit"
              disabled={uploading}
            >
              编辑昵称
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
