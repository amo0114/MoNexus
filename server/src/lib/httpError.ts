export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  // 下单价格确认失败：前端携带的 expectedPrice 与服务端当前价不一致，
  // 前端应重新拉取结算预览并让用户再次确认，禁止静默按新价格成交。
  | 'PRICE_CHANGED'
  // 结算内容（购买前表单定义）在预览后被商家改动：前端需重新拉取预览、
  // 换新幂等键并让用户针对新表单再次确认。
  | 'CHECKOUT_CHANGED'
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
