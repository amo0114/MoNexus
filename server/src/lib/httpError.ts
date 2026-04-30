export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'INTERNAL_SERVER_ERROR'
  | 'RATE_LIMITED'

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

export function badRequest(message: string, details?: ErrorDetail[]) {
  return new HttpError(400, 'BAD_REQUEST', message, details)
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
