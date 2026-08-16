// CategoryCoverField — category default-cover upload/preview/replace/remove
// widget (SPEC-CMI-UX-001 §5.4; D-UX-10/11/13; AC-UX-009/012/014/016/017).
//
// The admin picks a cover by choosing a local image — never by typing a
// storage path or CDN URL. The upload response `{ key, url }` is used for an
// immediate preview (SafeImage) while the objectKey becomes the write/confirm
// trust anchor (D-UX-13); the client URL is display-only.
//
// - `value` is the current form draft: an upload ref, a static ref, `null`
//   (explicitly removed) or `undefined` (untouched — keep the existing cover).
// - Upload failures keep the rest of the form intact and only surface a
//   local error; keyboard + label + busy + error wiring is accessible.

import { useRef, useState } from 'react'
import { Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import { uploadImage } from '../../api/uploads'
import type { PlatformMediaRef } from '../../types/catalog'
import SafeImage from '../ui/SafeImage'

interface CategoryCoverFieldProps {
  /** Existing canonical URL (category.defaultCoverUrl) for a legacy preview. */
  existingUrl: string | null
  /** Current form-draft cover ref (null = removed, undefined = untouched). */
  value: PlatformMediaRef | null | undefined
  /** Reports the draft ref whenever the user uploads/removes a cover. */
  onChange: (ref: PlatformMediaRef | null) => void
  disabled?: boolean
  /** True for new-category (active) form — cover is mandatory. */
  required?: boolean
  /** Form-level validation error (e.g. "请上传分类默认封面"). */
  error?: string | null
  testId?: string
}

export default function CategoryCoverField({
  existingUrl,
  value,
  onChange,
  disabled = false,
  required = false,
  error = null,
  testId = 'category-cover-field',
}: CategoryCoverFieldProps) {
  const [uploading, setUploading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [draftPreviewUrl, setDraftPreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const previewUrl =
    value?.kind === 'upload'
      ? draftPreviewUrl
      : value?.kind === 'static'
        ? value.path
        : value === null
          ? null
          : existingUrl

  const hasCover = previewUrl != null

  async function handleFile(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setActionError(null)
    try {
      const result = await uploadImage(file)
      setDraftPreviewUrl(result.url)
      onChange({ kind: 'upload', objectKey: result.key })
    } catch (err) {
      setActionError(getApiErrorMessage(err, '封面上传失败'))
    } finally {
      setUploading(false)
    }
  }

  function handleRemove() {
    setDraftPreviewUrl(null)
    onChange(null)
  }

  return (
    <div data-testid={testId}>
      <label htmlFor={`${testId}-file`} className="block text-sm font-semibold mb-1">
        默认封面{required ? ' *' : ''}
      </label>

      {hasCover ? (
        <div className="flex items-start gap-3">
          <SafeImage
            src={previewUrl!}
            alt="分类默认封面预览"
            className="w-24 h-24 object-cover rounded-lg border border-[var(--color-border)] shrink-0"
            data-testid={`${testId}-preview`}
          />
          <div className="flex flex-col gap-2">
            <label className="btn-secondary inline-flex items-center gap-2 cursor-pointer text-sm w-fit">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {uploading ? '上传中…' : '替换图片'}
              <input
                id={`${testId}-file`}
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={disabled || uploading}
                aria-busy={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  void handleFile(file)
                }}
              />
            </label>
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2 text-sm w-fit"
              disabled={disabled || uploading}
              onClick={handleRemove}
            >
              <Trash2 className="w-4 h-4" /> 移除封面
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 flex flex-col items-center gap-2">
          <label className="btn-secondary inline-flex items-center gap-2 cursor-pointer text-sm">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? '上传中…' : '上传图片'}
            <input
              id={`${testId}-file`}
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={disabled || uploading}
              aria-busy={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void handleFile(file)
              }}
            />
          </label>
          <p className="text-xs text-[var(--color-text-muted)]">PNG / JPEG / WebP / GIF，最大 5MB</p>
        </div>
      )}

      {actionError && (
        <p role="alert" className="text-xs text-[var(--color-danger)] mt-1" data-testid={`${testId}-action-error`}>
          {actionError}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--color-danger)] mt-1">
          {error}
        </p>
      )}
    </div>
  )
}
