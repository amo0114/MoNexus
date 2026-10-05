import { useRef, useState, useEffect, useId } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { updateMe, changePassword, sendVerificationEmail } from '../../api/auth'
import { uploadImage, UploadError } from '../../api/uploads'
import { getApiErrorMessage } from '../../api/error'
import { getAuthSessionContext, matchesAuthSessionContext } from '../../auth/sessionContext'
import AvatarPresetDialog from './AvatarPresetDialog'
import UserAvatar from '../ui/UserAvatar'
import AsyncButton from '../ui/AsyncButton'

/**
 * 个人资料与账号安全卡：
 * 聚合头像、昵称、登录邮箱及验证状态、登录密码修改。
 */
export default function ProfileIdentityCard() {
  const passwordErrorId = useId()
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)
  const fileRef = useRef<HTMLInputElement>(null)

  function getRequestAuthContext() {
    return getAuthSessionContext(useAuthStore.getState())
  }

  function isRequestContextCurrent(requestContext: NonNullable<ReturnType<typeof getRequestAuthContext>>) {
    return matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))
  }

  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [savingNick, setSavingNick] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [choosingAvatar, setChoosingAvatar] = useState(false)

  // 密码修改相关状态
  const [changingPwd, setChangingPwd] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)
  const [pwdError, setPwdError] = useState('')

  // 邮箱验证重发状态
  const [sendingVerify, setSendingVerify] = useState(false)
  const [verifyCooldown, setVerifyCooldown] = useState(0)

  useEffect(() => {
    if (verifyCooldown <= 0) return
    const timer = setInterval(() => setVerifyCooldown((c) => c - 1), 1000)
    return () => clearInterval(timer)
  }, [verifyCooldown])

  async function handleSendVerifyEmail() {
    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setSendingVerify(true)
    try {
      await sendVerificationEmail()
      if (!isRequestContextCurrent(requestContext)) return
      showToast('验证邮件已发送，请查收邮箱')
      setVerifyCooldown(60)
    } catch (err: unknown) {
      if (isRequestContextCurrent(requestContext)) {
        showToast(getApiErrorMessage(err, '发送验证邮件失败'), 'error')
      }
    } finally {
      setSendingVerify(false)
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwdError('')

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPwdError('请填写所有密码字段')
      return
    }

    if (newPassword !== confirmPassword) {
      setPwdError('两次输入的新密码不一致')
      return
    }

    if (newPassword.length < 6) {
      setPwdError('新密码长度不能少于 6 个字符')
      return
    }

    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setSavingPwd(true)
    try {
      await changePassword({ currentPassword, newPassword })
      if (!isRequestContextCurrent(requestContext)) return
      showToast('密码已修改，请重新登录')
      logout(requestContext)
      window.location.href = '/login'
    } catch (err: unknown) {
      if (isRequestContextCurrent(requestContext)) {
        setPwdError(getApiErrorMessage(err, '修改密码失败'))
      }
    } finally {
      setSavingPwd(false)
    }
  }

  async function handleSavePreset(avatarUrl: string) {
    if (!user || uploading) return
    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setUploading(true)
    try {
      const me = await updateMe({ avatarUrl })
      if (!setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null }, requestContext)) return
      setChoosingAvatar(false)
      showToast('头像已更新')
    } catch (err: unknown) {
      if (isRequestContextCurrent(requestContext)) {
        showToast(getApiErrorMessage(err, '头像保存失败，请重试'), 'error')
      }
    } finally {
      setUploading(false)
    }
  }

  async function handleSaveNickname() {
    if (!user) return
    const value = nickname.trim()
    if (!value || value.length > 20) {
      showToast('昵称需为 1-20 个字符', 'error')
      return
    }
    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setSavingNick(true)
    try {
      const me = await updateMe({ nickname: value })
      if (!setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null }, requestContext)) return
      showToast('昵称已更新')
      setEditing(false)
    } catch (err: unknown) {
      if (isRequestContextCurrent(requestContext)) showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setSavingNick(false)
    }
  }

  async function handleAvatarFile(file: File | null) {
    if (!file || !user) return
    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setUploading(true)
    try {
      const { url } = await uploadImage(file)
      const me = await updateMe({ avatarUrl: url })
      if (!setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null }, requestContext)) return
      showToast('头像已更新')
    } catch (err: unknown) {
      if (!isRequestContextCurrent(requestContext)) return
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
    const requestContext = getRequestAuthContext()
    if (!requestContext) return
    setUploading(true)
    try {
      const me = await updateMe({ avatarUrl: null })
      if (!setUser({ ...user, ...me, merchant: me.merchant ?? user.merchant ?? null }, requestContext)) return
      showToast('已恢复默认头像')
    } catch (err: unknown) {
      if (isRequestContextCurrent(requestContext)) {
        showToast(getApiErrorMessage(err, '清除头像失败'), 'error')
      }
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
            aria-busy={uploading}
            data-testid="avatar-edit"
          >
            <UserAvatar url={user?.avatarUrl} name={displayName} size={60} className="text-xl" />
            <span aria-hidden="true" className={`absolute inset-0 bg-black/40 ${uploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'} transition-opacity flex items-center justify-center`}>
              {uploading ? (
                <Loader2 className="w-5 h-5 text-white animate-spin motion-reduce:animate-none" />
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
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={() => setChoosingAvatar(true)}
              disabled={uploading || savingNick}
              className="inline-flex min-h-11 min-w-11 items-center rounded-md px-2 text-sm text-[var(--color-primary)] underline cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            >
              选择头像
            </button>
            {user?.avatarUrl && (
              <button
                type="button"
                onClick={() => void handleClearAvatar()}
                disabled={uploading || savingNick}
                className="inline-flex min-h-11 min-w-11 items-center rounded-md px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] underline cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              >
                清除头像
              </button>
            )}
          </div>
        </div>
      </div>

      {choosingAvatar && (
        <AvatarPresetDialog
          currentUrl={user?.avatarUrl}
          busy={uploading}
          onClose={() => setChoosingAvatar(false)}
          onSave={handleSavePreset}
          onUpload={() => {
            setChoosingAvatar(false)
            fileRef.current?.click()
          }}
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
              aria-label="昵称"
              data-testid="nickname-input"
            />
            <AsyncButton
              loading={savingNick}
              loadingLabel="保存中…"
              type="button"
              onClick={() => void handleSaveNickname()}
              disabled={savingNick || uploading}
              className="btn-primary w-full shrink-0 px-4 py-2 text-sm sm:w-auto"
              data-testid="nickname-save"
            >
              保存
            </AsyncButton>
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

      {/* 电子邮箱与认证状态 */}
      <div className="border-t border-[var(--color-border)] pt-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-text-muted)]">登录邮箱</span>
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                  user?.emailVerified
                    ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                    : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
                }`}
              >
                {user?.emailVerified ? '已通过验证' : '待验证'}
              </span>
            </div>
            <p className="text-sm font-bold text-[var(--color-text)] mt-0.5 truncate">
              {user?.email || '未绑定邮箱'}
            </p>
          </div>

          {!user?.emailVerified && (
            <AsyncButton
              loading={sendingVerify}
              loadingLabel="发送中…"
              type="button"
              onClick={handleSendVerifyEmail}
              disabled={sendingVerify || verifyCooldown > 0}
              className="max-md:min-h-10 btn-secondary text-xs px-3 py-1.5 shrink-0 self-start sm:self-auto cursor-pointer disabled:opacity-50"
            >
              {verifyCooldown > 0 ? `${verifyCooldown}s 后可重发` : '发送验证邮件'}
            </AsyncButton>
          )}
        </div>
      </div>

      {/* 登录密码修改 */}
      <div className="border-t border-[var(--color-border)] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-[var(--color-text-muted)] mb-0.5">登录密码</p>
            <p className="text-sm font-bold text-[var(--color-text)] tracking-wider">
              ••••••••
            </p>
          </div>
          <button
            type="button"
            onClick={() => setChangingPwd(!changingPwd)}
            disabled={savingPwd}
            className="max-md:min-h-10 btn-secondary text-xs px-3 py-1.5 shrink-0 cursor-pointer"
          >
            {changingPwd ? '收起表单' : '修改密码'}
          </button>
        </div>

        {changingPwd && (
          <form
            onSubmit={handleChangePassword}
            className="flex flex-col gap-2.5 mt-3 border-t border-[var(--color-border)]/50 pt-3 animate-in fade-in-50 duration-200"
          >
            {pwdError && (
              <div id={passwordErrorId} role="alert" className="text-[var(--color-danger)] text-xs font-medium bg-[var(--color-danger)]/10 px-3 py-1.5 rounded-lg">
                {pwdError}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2">
              <input
                type="password"
                placeholder="当前密码"
                aria-label="当前密码"
                autoComplete="current-password"
                aria-describedby={pwdError ? passwordErrorId : undefined}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="input text-xs sm:text-sm py-2"
                disabled={savingPwd}
              />
              <input
                type="password"
                placeholder="新密码（至少 6 位）"
                aria-label="新密码（至少 6 位）"
                autoComplete="new-password"
                aria-describedby={pwdError ? passwordErrorId : undefined}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input text-xs sm:text-sm py-2"
                disabled={savingPwd}
              />
              <input
                type="password"
                placeholder="确认新密码"
                aria-label="确认新密码"
                autoComplete="new-password"
                aria-describedby={pwdError ? passwordErrorId : undefined}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input text-xs sm:text-sm py-2"
                disabled={savingPwd}
              />
            </div>
            <div className="flex justify-end gap-2 mt-1">
              <button
                type="button"
                onClick={() => setChangingPwd(false)}
                disabled={savingPwd}
                className="max-md:min-h-10 btn-secondary text-xs px-3 py-1.5 cursor-pointer"
              >
                取消
              </button>
              <AsyncButton
                loading={savingPwd}
                loadingLabel="提交中…"
                type="submit"
                disabled={savingPwd}
                className="max-md:min-h-10 btn-primary text-xs px-4 py-1.5 cursor-pointer"
              >
                确认修改
              </AsyncButton>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
