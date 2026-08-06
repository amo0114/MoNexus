import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Loader2, Star, Trash2, Upload } from 'lucide-react'
import { uploadImage, UploadError } from '../../api/uploads'
import { useAppStore } from '../../stores/appStore'
import { fileToObjectUrl } from '../../utils/cropImage'
import ImageCropDialog from '../ui/ImageCropDialog'
import SafeImage from '../ui/SafeImage'

const MAX_IMAGES = 6

type PendingCrop = {
  src: string
  revokeUrl?: string
  isCover: boolean
  queue?: File[]
  /** After 1:1 re-crop, replace this index as cover (upload new, remove old). */
  replaceAsCoverFromIndex?: number
}

type ProductImageUploaderProps = {
  images: string[]
  onChange: Dispatch<SetStateAction<string[]>>
  disabled?: boolean
}

/**
 * Merchant product images: local upload goes through crop; URL may crop or skip.
 * Cover forces 1:1; secondary allows free aspect.
 */
export default function ProductImageUploader({
  images,
  onChange,
  disabled = false,
}: ProductImageUploaderProps) {
  const showToast = useAppStore((s) => s.showToast)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [pending, setPending] = useState<PendingCrop | null>(null)

  function revokePending(p: PendingCrop | null = pending) {
    if (p?.revokeUrl) URL.revokeObjectURL(p.revokeUrl)
  }

  function closeCrop() {
    revokePending()
    setPending(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function openFileCrop(file: File, queue: File[], isCover: boolean) {
    const url = fileToObjectUrl(file)
    setPending({ src: url, revokeUrl: url, isCover, queue })
  }

  function normalizeUrl(url: string) {
    if (url.startsWith('/') && typeof window !== 'undefined') {
      return `${window.location.origin}${url}`
    }
    return url
  }

  function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0 || disabled) return
    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`, 'error')
      return
    }
    const selected = Array.from(files).slice(0, remaining)
    if (selected.length < files.length) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片，已忽略多余文件`, 'error')
    }
    const [first, ...rest] = selected
    openFileCrop(first, rest, images.length === 0)
  }

  async function uploadBlob(blob: Blob): Promise<string | null> {
    const file = new File([blob], `product-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })
    setUploading(true)
    try {
      const result = await uploadImage(file)
      return result.url
    } catch (err) {
      const msg =
        err instanceof UploadError
          ? err.message
          : (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
              ?.error?.message || '图片上传失败'
      showToast(msg, 'error')
      return null
    } finally {
      setUploading(false)
    }
  }

  async function handleCropConfirm(blob: Blob) {
    const current = pending
    const queue = current?.queue ?? []
    const replaceIdx = current?.replaceAsCoverFromIndex
    const url = await uploadBlob(blob)
    revokePending(current)
    setPending(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!url) {
      if (queue.length > 0) showToast('上传失败，后续文件已取消', 'error')
      return
    }

    if (typeof replaceIdx === 'number') {
      onChange((prev) => {
        const next = prev.filter((_, i) => i !== replaceIdx)
        return [url, ...next].slice(0, MAX_IMAGES)
      })
      showToast('封面已更新（1:1）')
      return
    }

    onChange((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, url]))
    showToast('图片上传成功')

    if (queue.length > 0) {
      const [next, ...rest] = queue
      openFileCrop(next, rest, false)
    }
  }

  function addImageUrl(opts?: { skipCrop?: boolean }) {
    if (disabled || uploading) return
    const raw = imageUrlInput.trim()
    if (!raw) return
    if (!/^https?:\/\//.test(raw) && !raw.startsWith('/')) {
      showToast('图片地址必须是 http(s) 绝对 URL 或以 / 开头的路径', 'error')
      return
    }
    if (images.length >= MAX_IMAGES) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`, 'error')
      return
    }
    if (opts?.skipCrop) {
      onChange((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, raw]))
      setImageUrlInput('')
      showToast(
        images.length === 0
          ? '已添加外链封面（未裁剪；建议改用本地上传 1:1）'
          : '已添加外链图片（未裁剪）',
      )
      return
    }
    setPending({ src: normalizeUrl(raw), isCover: images.length === 0 })
    setImageUrlInput('')
  }

  function removeImage(index: number) {
    onChange((prev) => prev.filter((_, i) => i !== index))
  }

  function setAsCover(index: number) {
    if (index === 0) return
    const url = images[index]
    if (!url) return
    const ok = window.confirm(
      '设为封面需要按 1:1 重新裁剪并上传新图。确定后将打开裁剪框；取消则保持不变。',
    )
    if (!ok) return
    setPending({
      src: normalizeUrl(url),
      isCover: true,
      replaceAsCoverFromIndex: index,
    })
  }

  const busy = uploading || disabled

  return (
    <div data-testid="product-images-uploader">
      <label className="block text-sm font-semibold text-[var(--color-text)] mb-1">
        商品图片（最多 {MAX_IMAGES} 张，第一张为封面）
      </label>
      <p className="text-xs text-[var(--color-text-muted)] mb-2 leading-relaxed">
        <strong className="font-semibold text-[var(--color-text)]">封面</strong>须裁成{' '}
        <strong className="font-semibold text-[var(--color-text)]">1:1</strong>
        ，主体约占 80%–85%。辅图可选 1:1 或自由比例。本地上传经裁剪后存为本站图；
        外链可「裁剪后上传」或「直接添加外链」。导出为静态 JPEG（GIF 将失去动画）。
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          className="input flex-1 min-w-[12rem]"
          placeholder="粘贴图片 URL"
          value={imageUrlInput}
          onChange={(e) => setImageUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addImageUrl()
            }
          }}
          disabled={busy || images.length >= MAX_IMAGES}
          data-testid="product-image-url-input"
        />
        <button
          type="button"
          onClick={() => addImageUrl()}
          disabled={busy || images.length >= MAX_IMAGES}
          className="btn-secondary px-3 py-2 text-sm whitespace-nowrap"
          data-testid="product-image-url-add"
          title="打开裁剪后上传到本站"
        >
          裁剪添加
        </button>
        <button
          type="button"
          onClick={() => addImageUrl({ skipCrop: true })}
          disabled={busy || images.length >= MAX_IMAGES}
          className="btn-secondary px-3 py-2 text-sm whitespace-nowrap"
          data-testid="product-image-url-hotlink"
          title="不裁剪，直接引用 URL（CORS/跨域场景）"
        >
          直接外链
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || images.length >= MAX_IMAGES}
          className="btn-secondary px-4 py-2 text-sm whitespace-nowrap"
          data-testid="product-image-upload-button"
        >
          {uploading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> 上传中
            </>
          ) : (
            <>
              <Upload className="w-4 h-4" /> 本地上传
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => handleFilesSelected(e.target.files)}
        />
      </div>

      {images.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-3" data-testid="product-images-list">
          {images.map((url, index) => (
            <div
              key={`${url}-${index}`}
              className="relative group rounded-lg border border-[var(--color-border)] overflow-hidden"
            >
              <SafeImage src={url} alt={`商品图 ${index + 1}`} className="w-full h-20 object-cover" />
              {index === 0 && (
                <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-xs font-bold bg-[var(--color-cta)] text-white">
                  封面
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 p-1 bg-black/40 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                {index !== 0 && (
                  <button
                    type="button"
                    title="设为封面（需 1:1 重裁）"
                    aria-label={`将第 ${index + 1} 张设为封面`}
                    onClick={() => setAsCover(index)}
                    className="icon-btn p-1 rounded bg-white/90 text-[var(--color-text)] hover:bg-white cursor-pointer"
                  >
                    <Star className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  title="删除"
                  aria-label={`删除第 ${index + 1} 张`}
                  onClick={() => removeImage(index)}
                  className="icon-btn p-1 rounded bg-white/90 text-red-600 hover:bg-white cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ImageCropDialog
        key={pending ? `${pending.src}-${pending.isCover}-${pending.replaceAsCoverFromIndex ?? ''}` : 'closed'}
        open={Boolean(pending)}
        imageSrc={pending?.src ?? null}
        defaultAspect={pending?.isCover ? '1:1' : 'free'}
        allowAspectToggle={pending ? !pending.isCover : false}
        title={pending?.isCover ? '裁剪封面（1:1）' : '裁剪商品图'}
        onCancel={closeCrop}
        onConfirm={handleCropConfirm}
      />
    </div>
  )
}

export { MAX_IMAGES }
