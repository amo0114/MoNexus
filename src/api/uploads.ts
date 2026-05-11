import api from './client'

export interface UploadImageResult {
  key: string
  url: string
}

const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export class UploadError extends Error {
  constructor(message: string, public code: string) {
    super(message)
  }
}

// Validates the file client-side before round-tripping to the server.
// Saves a request when the user picks something obviously wrong; the
// server still validates again because client checks are spoofable.
export function validateImageFile(file: File): UploadError | null {
  if (file.size > MAX_FILE_SIZE) {
    return new UploadError('文件大小不能超过 5MB', 'FILE_TOO_LARGE')
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return new UploadError('仅支持 PNG / JPEG / WebP / GIF 图片', 'UNSUPPORTED_MEDIA_TYPE')
  }
  return null
}

export async function uploadImage(file: File): Promise<UploadImageResult> {
  const err = validateImageFile(file)
  if (err) throw err

  const formData = new FormData()
  formData.append('file', file)

  const { data } = await api.post<UploadImageResult>('/uploads/image', formData, {
    // axios sets the multipart boundary automatically when given FormData;
    // don't pre-set Content-Type or the boundary will be missing.
  })
  return data
}
