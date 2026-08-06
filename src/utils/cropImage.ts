import type { Area } from 'react-easy-crop'

const DEFAULT_MAX_EDGE = 2000

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Needed so canvas export works for same-origin and CORS-enabled remote URLs.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败，请检查地址或改用本地上传'))
    img.src = src
  })
}

/**
 * Draw the crop rectangle from react-easy-crop into a blob.
 * Downscales so the longest edge ≤ maxEdge (default 2000) before encode.
 */
export async function getCroppedBlob(
  imageSrc: string,
  pixelCrop: Area,
  options?: {
    maxEdge?: number
    mimeType?: 'image/jpeg' | 'image/webp' | 'image/png'
    quality?: number
  },
): Promise<Blob> {
  const image = await loadImage(imageSrc)
  const maxEdge = options?.maxEdge ?? DEFAULT_MAX_EDGE
  const mimeType = options?.mimeType ?? 'image/jpeg'
  const quality = options?.quality ?? 0.9

  const cropW = Math.max(1, Math.round(pixelCrop.width))
  const cropH = Math.max(1, Math.round(pixelCrop.height))
  const scale = Math.min(1, maxEdge / Math.max(cropW, cropH))
  const outW = Math.max(1, Math.round(cropW * scale))
  const outH = Math.max(1, Math.round(cropH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    cropW,
    cropH,
    0,
    0,
    outW,
    outH,
  )

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality)
  })
  if (!blob) throw new Error('图片导出失败')
  return blob
}

/** File → object URL for the crop dialog (caller must revoke). */
export function fileToObjectUrl(file: File): string {
  return URL.createObjectURL(file)
}
