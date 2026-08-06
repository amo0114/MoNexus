import { useCallback, useState } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './Dialog'
import { getCroppedBlob } from '../../utils/cropImage'

export type CropAspectMode = '1:1' | 'free'

type ImageCropDialogProps = {
  open: boolean
  imageSrc: string | null
  /** Default aspect; cover should pass 1:1 */
  defaultAspect?: CropAspectMode
  /** When true, user can switch between 1:1 and free (secondary images) */
  allowAspectToggle?: boolean
  title?: string
  hint?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (blob: Blob) => void | Promise<void>
}

/**
 * Modal cropper for merchant product images (Taobao/Amazon-style square main image).
 */
export default function ImageCropDialog({
  open,
  imageSrc,
  defaultAspect = '1:1',
  allowAspectToggle = false,
  title = '裁剪图片',
  hint,
  confirmLabel = '确认并上传',
  onCancel,
  onConfirm,
}: ImageCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [aspectMode, setAspectMode] = useState<CropAspectMode>(defaultAspect)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onCropComplete = useCallback((_area: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels)
  }, [])

  // Reset when a new source opens
  const handleOpenChange = (next: boolean) => {
    if (!next && !busy) onCancel()
  }

  async function handleConfirm() {
    if (!imageSrc || !croppedAreaPixels || busy) return
    setBusy(true)
    setError(null)
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels, {
        maxEdge: 2000,
        mimeType: 'image/jpeg',
        quality: 0.9,
      })
      await onConfirm(blob)
    } catch (err) {
      setError(err instanceof Error ? err.message : '裁剪失败')
    } finally {
      setBusy(false)
    }
  }

  const aspect = aspectMode === '1:1' ? 1 : undefined
  const defaultHint =
    aspectMode === '1:1'
      ? '请将商品主体置于框内，约占画面 80%–85%。确认后按最长边 ≤2000px 导出 JPEG。'
      : '自由比例：适合辅图/场景图。列表缩略仍可能裁切，重要信息请放在画面中心。'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg w-[min(100vw-1.5rem,32rem)] p-0 overflow-hidden max-md:p-0 z-[60]"
        hideClose
        data-testid="image-crop-dialog"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <div className="min-w-0">
            <DialogTitle className="text-base font-bold text-[var(--color-text)] truncate">
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">裁剪商品图片后上传</DialogDescription>
          </div>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-background)] cursor-pointer"
            onClick={() => !busy && onCancel()}
            aria-label="关闭裁剪"
            disabled={busy}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative w-full h-[min(55vh,22rem)] bg-black">
          {imageSrc ? (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="contain"
              showGrid
            />
          ) : null}
        </div>

        <div className="px-4 py-3 space-y-3 border-t border-[var(--color-border)]">
          {allowAspectToggle && (
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn-sm px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                  aspectMode === '1:1'
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
                onClick={() => setAspectMode('1:1')}
                disabled={busy}
                data-testid="crop-aspect-1-1"
              >
                1:1 方图
              </button>
              <button
                type="button"
                className={`btn-sm px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                  aspectMode === 'free'
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
                onClick={() => setAspectMode('free')}
                disabled={busy}
                data-testid="crop-aspect-free"
              >
                自由比例
              </button>
            </div>
          )}

          <label className="flex items-center gap-3 text-sm text-[var(--color-text)]">
            <span className="shrink-0 text-[var(--color-text-muted)] w-10">缩放</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1 accent-[var(--color-primary)]"
              disabled={busy}
              data-testid="crop-zoom"
            />
          </label>

          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
            {hint ?? defaultHint}
          </p>
          {error && (
            <p className="text-xs text-[var(--color-danger)]" data-testid="crop-error">
              {error}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => !busy && onCancel()}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-2"
              onClick={() => void handleConfirm()}
              disabled={busy || !croppedAreaPixels}
              data-testid="crop-confirm"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {busy ? '处理中…' : confirmLabel}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
