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
  // 高风险订单二次验证（P3）：触发阈值但请求缺少登录密码 / 密码错误 /
  // 验证失败次数过多。前端保持弹窗打开、聚焦密码框，幂等键不轮换。
  | 'VERIFICATION_REQUIRED'
  | 'VERIFICATION_FAILED'
  | 'TOO_MANY_ATTEMPTS'
  // Upload-specific (P0-C) — let the frontend distinguish failure modes
  // for a precise error toast instead of a generic "bad request".
  | 'NO_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  // P5 受控文件交付：403 细分——争议暂停 / 退款或吊销 / 窗口过期。
  // 404（订单不存在/越权/无文件交付）沿用 NOT_FOUND 防枚举。
  | 'FILE_ACCESS_SUSPENDED'
  | 'FILE_ACCESS_REVOKED'
  | 'FILE_WINDOW_EXPIRED'
  // P6a 订阅到期：买家订阅已过期时文件发放拒绝（与下载窗口取较严者）。
  | 'FILE_SUBSCRIPTION_EXPIRED'
  // P6a 手动续费预检/下单校验：
  // - RENEW_NOT_SUBSCRIPTION：订单没有到期时刻（非订阅交付），无从续费；
  // - RENEW_OFFER_UNAVAILABLE：原规格已下架/商品下架/不再可购买；
  // - RENEW_INVALID：下单携带的 renewalOfOrderId 关联校验失败。
  | 'RENEW_NOT_SUBSCRIPTION'
  | 'RENEW_OFFER_UNAVAILABLE'
  | 'RENEW_INVALID'

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
