export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'INTERNAL_SERVER_ERROR'
  | 'RATE_LIMITED'
  // Upload-specific (P0-C) — let the frontend distinguish failure modes
  // for a precise error toast instead of a generic "bad request".
  | 'NO_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'

export interface ErrorDetail {
  field: string
  message: string
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: ErrorDetail[]
  ) {
    super(message)
  }
}

export function badRequest(message: string): HttpError
export function badRequest(message: string, code: ErrorCode): HttpError
export function badRequest(message: string, details: ErrorDetail[]): HttpError
export function badRequest(message: string, codeOrDetails?: ErrorCode | ErrorDetail[]) {
  if (Array.isArray(codeOrDetails)) {
    return new HttpError(400, 'BAD_REQUEST', message, codeOrDetails)
  }
  return new HttpError(400, codeOrDetails ?? 'BAD_REQUEST', message)
}

export function unauthenticated(message = '未登录') {
  return new HttpError(401, 'UNAUTHENTICATED', message)
}

export function forbidden(message = '需要管理员权限') {
  return new HttpError(403, 'FORBIDDEN', message)
}

export function notFound(message = '资源不存在') {
  return new HttpError(404, 'NOT_FOUND', message)
}

export function conflict(message: string) {
  return new HttpError(409, 'CONFLICT', message)
}
