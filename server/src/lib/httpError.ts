export type ErrorCode =
  | 'VALIDATION_ERROR'
  // SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：客户端试图写受控字段（如
  // Product.isHot）时稳定返回，与普通校验失败（VALIDATION_ERROR）区分开。
  | 'FIELD_NOT_WRITABLE'
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
  // P6a 订阅到期：买家订阅已过期时文件发放拒绝（订阅交付豁免平台下载
  // 窗口，只受自身有效期约束——见 fileAccess.ts）。
  | 'FILE_SUBSCRIPTION_EXPIRED'
  // P6a 手动续费预检/下单校验：
  // - RENEW_NOT_SUBSCRIPTION：订单没有到期时刻（非订阅交付），无从续费；
  // - RENEW_OFFER_UNAVAILABLE：原规格已下架/商品下架/不再可购买；
  // - RENEW_INVALID：下单携带的 renewalOfOrderId 关联校验失败；
  // - RENEW_ALREADY_RENEWED：原单已有未退款的续费单——续费必须在链尾
  //   （最新订单）发起，否则两次续费自同一到期顺延 = 花两份钱只延一份时长。
  | 'RENEW_NOT_SUBSCRIPTION'
  | 'RENEW_OFFER_UNAVAILABLE'
  | 'RENEW_INVALID'
  | 'RENEW_ALREADY_RENEWED'
  // P6b 履约进度更新：单订单每小时进度条数超限（审计表即计数器，
  // 语义同 RATE_LIMITED，细分 code 便于前端提示"进度发太频繁"）。
  | 'PROGRESS_RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_EXPIRED'
  // M3 identity security: an MFA pre-authentication challenge is invalid,
  // its factor did not verify, or it exhausted its fixed attempt budget.
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_VERIFICATION_FAILED'
  | 'MFA_TOO_MANY_ATTEMPTS'
  | 'MFA_REQUIRED'
  | 'SESSION_REVOKED'
  // A session-management caller tried to delete its own active family. The
  // existing logout endpoint is the only current-session revocation path.
  | 'CURRENT_SESSION_REQUIRES_LOGOUT'
  // P7b 自动开通：下单事务内冻结商家 webhook 配置失败（规格开着
  // autoProvision 但商家已无 active 配置）。语义同 CHECKOUT_CHANGED——
  // 整单安全失败让买家重新确认，绝不静默转普通人工单（硬验收 ⑤）。
  | 'AUTO_PROVISION_UNAVAILABLE'
  // FakaBridge：开通邮箱未完成归属验证（防冒用他人 Xboard 账号）。
  | 'PROVISION_EMAIL_UNVERIFIED'
  // SPEC-OPS-REGMAIL-001：运营开关关闭了公开注册。与 FORBIDDEN 分开是因为
  // 前端要据此把注册表单切回登录态（而不是当成权限错误提示"需要管理员权限"）。
  | 'REGISTRATION_DISABLED'
  // 同上：当前进程只有 console 兜底 mailer，测试发送必须明确拒绝而不是
  // 假装"已发送"（MAIL-03）。
  | 'MAILER_NOT_CONFIGURED'
  // SPEC-RAP-001：高价值写操作要求当前数据库中的邮箱已验证；注册和
  // 邮件防滥用路径则区分缺 challenge、challenge 失败和依赖不可用。
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'HUMAN_VERIFICATION_REQUIRED'
  | 'HUMAN_VERIFICATION_FAILED'
  | 'HUMAN_VERIFICATION_UNAVAILABLE'
  | 'ABUSE_PROTECTION_UNAVAILABLE'
  // SPEC-LEGAL-001：注册/下单的协议确认。REQUIRED = 强制模式下未携带必备
  // 协议版本（400）；STALE = 携带的版本落后于注册表当前版本（409，语义同
  // PRICE_CHANGED——前端重新拉取预览/注册状态拿新版本，换新幂等键重试）。
  | 'LEGAL_AGREEMENT_REQUIRED'
  | 'LEGAL_AGREEMENT_STALE'
  // SPEC-VALUE-POLICY-P1-001: CNY reference-value policy.
  | 'VALUE_POLICY_DISABLED'
  | 'VALUE_POLICY_REQUIRED'
  | 'VALUE_POLICY_CHANGED'
  | 'VALUE_POLICY_UNAVAILABLE'
  | 'VALUE_POLICY_DATA_INVALID'
  | 'VALUE_POLICY_GOVERNANCE_DISABLED'
  | 'VALUE_POLICY_GOVERNANCE_NOT_FOUND'
  | 'VALUE_POLICY_GOVERNANCE_CONFLICT'
  | 'VALUE_POLICY_MAKER_CHECKER_REQUIRED'
  | 'VALUE_POLICY_IDEMPOTENCY_KEY_REQUIRED'
  | 'VALUE_POLICY_IDEMPOTENCY_KEY_INVALID'
  | 'VALUE_POLICY_IDEMPOTENCY_CONFLICT'
  | 'VALUE_POLICY_EFFECTIVE_AT_INVALID'
  // Ledger mutation failures the client can distinguish from generic BAD_REQUEST.
  | 'POINT_BALANCE_HARD_CAP'
  | 'POINT_INSUFFICIENT'
  | 'POINT_BALANCE_CONFLICT'
  // SPEC-RECHARGE-PAYMENT-V1.2 user API (7.1).
  | 'RECHARGE_DISABLED'
  | 'RECHARGE_CURRENCY_DISABLED'
  | 'RECHARGE_AMOUNT_BELOW_MINIMUM'
  | 'RECHARGE_AMOUNT_ABOVE_MAXIMUM'
  | 'RECHARGE_AMOUNT_STEP_INVALID'
  | 'RECHARGE_LIMIT_EXCEEDED'
  | 'RECHARGE_QUOTE_EXPIRED'
  | 'RECHARGE_QUOTE_CHANGED'
  | 'PAYMENT_PROVIDER_UNAVAILABLE'
  | 'PAYMENT_METHOD_UNAVAILABLE'
  | 'PAYMENT_ALREADY_IN_PROGRESS'
  | 'PAYMENT_STATE_UNKNOWN'
  | 'PAYMENT_COMPLETION_NOT_SUPPORTED'
  | 'PAYMENT_REFUND_NOT_SUPPORTED'
  | 'FAKA_ACTION_NOT_IN_DIFF'
  | 'DEFAULT_OFFER_REQUIRES_ACTIVE'
  | 'REFUND_BALANCE_INSUFFICIENT'
  | 'REFUND_REQUIRES_REVIEW'
  | 'ACCOUNT_SPENDING_RESTRICTED'

export interface ErrorDetail {
  field: string
  message: string
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: ErrorDetail[],
    /** Safe, rounded seconds for a caller-facing Retry-After header. */
    public retryAfterSeconds?: number,
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

export function mfaChallengeInvalid(message = 'MFA 验证请求无效或已过期') {
  return new HttpError(400, 'MFA_CHALLENGE_INVALID', message)
}

export function mfaVerificationFailed(message = 'MFA 验证失败') {
  return new HttpError(401, 'MFA_VERIFICATION_FAILED', message)
}

export function mfaTooManyAttempts(message = 'MFA 验证次数过多，请重新登录') {
  return new HttpError(429, 'MFA_TOO_MANY_ATTEMPTS', message)
}

export function mfaRequired(message = '管理员需要完成多因素验证') {
  return new HttpError(403, 'MFA_REQUIRED', message)
}

export function sessionRevoked(message = '登录会话已失效，请重新登录') {
  return new HttpError(401, 'SESSION_REVOKED', message)
}

export function tooManyRequests(message = '请求过于频繁，请稍后再试', retryAfterSeconds?: number) {
  const retryAfter = retryAfterSeconds === undefined
    ? undefined
    : Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : undefined
  return new HttpError(429, 'RATE_LIMITED', message, undefined, retryAfter)
}

export function provisionEmailUnverified(
  message = '请先完成 Xboard 开通邮箱验证'
) {
  return new HttpError(400, 'PROVISION_EMAIL_UNVERIFIED', message)
}

/** REG-03：注册开关关闭时的统一拒绝，必须在写任何注册数据之前抛出。 */
export function registrationDisabled(message = '当前已关闭新用户注册') {
  return new HttpError(403, 'REGISTRATION_DISABLED', message)
}

/** MAIL-03：console 兜底 mailer 下的测试发送拒绝（不是权限问题，用 409）。 */
export function mailerNotConfigured(
  message = '尚未配置真实 SMTP，无法发送测试邮件'
) {
  return new HttpError(409, 'MAILER_NOT_CONFIGURED', message)
}

/** SPEC-RAP-001：受限账户访问高价值写操作时的服务端资格拒绝。 */
export function emailVerificationRequired(message = '请先完成邮箱验证后再继续操作') {
  return new HttpError(403, 'EMAIL_VERIFICATION_REQUIRED', message)
}

/** SPEC-RAP-001：公开注册在保护启用时未提交人机验证证明。 */
export function humanVerificationRequired(message = '请先完成安全验证后重试') {
  return new HttpError(400, 'HUMAN_VERIFICATION_REQUIRED', message)
}

/** SPEC-RAP-001：提交的人机验证证明无效、过期或与当前站点不匹配。 */
export function humanVerificationFailed(message = '安全验证未通过，请刷新后重试') {
  return new HttpError(403, 'HUMAN_VERIFICATION_FAILED', message)
}

/** SPEC-RAP-001：Turnstile 或其本地配置暂不可用，必须安全失败。 */
export function humanVerificationUnavailable(message = '安全验证服务暂不可用，请稍后重试') {
  return new HttpError(503, 'HUMAN_VERIFICATION_UNAVAILABLE', message)
}

/** SPEC-RAP-001：Redis 反滥用保护不可用时绝不继续注册或发信副作用。 */
export function abuseProtectionUnavailable(message = '请求保护服务暂不可用，请稍后重试') {
  return new HttpError(503, 'ABUSE_PROTECTION_UNAVAILABLE', message)
}

/** SPEC-LEGAL-001：强制模式下注册/下单缺少必备协议确认。 */
export function legalAgreementRequired(message = '请先阅读并同意相关协议后再继续') {
  return new HttpError(400, 'LEGAL_AGREEMENT_REQUIRED', message)
}

/**
 * SPEC-LEGAL-001：客户端确认的协议版本落后于当前版本。details 携带每份
 * 必备文档的当前版本，前端据此重新拉取并让用户再次确认（同 PRICE_CHANGED
 * 的重确认语义，禁止静默按新版本落证）。
 */
export function legalAgreementStale(
  required: ReadonlyArray<{ document: string; version: string }>,
  message = '协议版本已更新，请重新阅读并确认',
) {
  return new HttpError(
    409,
    'LEGAL_AGREEMENT_STALE',
    message,
    required.map(r => ({ field: `agreements.${r.document}`, message: `当前版本：${r.version}` })),
  )
}

export function valuePolicyDisabled(message = '价值政策未启用') {
  return new HttpError(404, 'VALUE_POLICY_DISABLED', message)
}

export function valuePolicyRequired(message = '请确认当前价值政策后再下单') {
  return new HttpError(400, 'VALUE_POLICY_REQUIRED', message)
}

export function valuePolicyChanged(message = '价值政策已变化，请重新确认') {
  return new HttpError(409, 'VALUE_POLICY_CHANGED', message)
}

export function valuePolicyUnavailable(message = '价值政策暂不可用，请稍后重试') {
  return new HttpError(503, 'VALUE_POLICY_UNAVAILABLE', message)
}

export function valuePolicyDataInvalid(message = '价值政策数据不合法') {
  return new HttpError(500, 'VALUE_POLICY_DATA_INVALID', message)
}

export function pointInsufficient(message = '积分不足') {
  return new HttpError(400, 'POINT_INSUFFICIENT', message)
}

export function pointBalanceHardCap(message = '积分余额已达上限') {
  return new HttpError(400, 'POINT_BALANCE_HARD_CAP', message)
}

export function pointBalanceConflict(message = '积分账户正在变更，请重试') {
  return new HttpError(409, 'POINT_BALANCE_CONFLICT', message)
}

export function rechargeDisabled(message = '充值功能未开放') {
  return new HttpError(404, 'RECHARGE_DISABLED', message)
}

export function rechargeUnavailable(message = '充值服务暂不可用') {
  return new HttpError(503, 'RECHARGE_DISABLED', message)
}

export function rechargeCurrencyDisabled(message = '当前币种未开放充值') {
  return new HttpError(409, 'RECHARGE_CURRENCY_DISABLED', message)
}

export function rechargeAmountBelowMinimum(message = '充值金额低于最低限额') {
  return new HttpError(400, 'RECHARGE_AMOUNT_BELOW_MINIMUM', message)
}

export function rechargeAmountAboveMaximum(message = '充值金额超过最高限额') {
  return new HttpError(400, 'RECHARGE_AMOUNT_ABOVE_MAXIMUM', message)
}

export function rechargeAmountStepInvalid(message = '充值金额不符合步进要求') {
  return new HttpError(400, 'RECHARGE_AMOUNT_STEP_INVALID', message)
}

export function rechargeLimitExceeded(message = '已超过当日或当月充值限额') {
  return new HttpError(409, 'RECHARGE_LIMIT_EXCEEDED', message)
}

export function rechargeQuoteExpired(message = '充值报价已过期，请重新获取') {
  return new HttpError(409, 'RECHARGE_QUOTE_EXPIRED', message)
}

export function rechargeQuoteChanged(message = '充值报价已变化，请重新确认') {
  return new HttpError(409, 'RECHARGE_QUOTE_CHANGED', message)
}

export function paymentProviderUnavailable(message = '支付渠道暂不可用') {
  return new HttpError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', message)
}

export function paymentMethodUnavailable(message = '当前支付方式不可用') {
  return new HttpError(409, 'PAYMENT_METHOD_UNAVAILABLE', message)
}

export function paymentAlreadyInProgress(message = '该充值订单已有进行中的支付') {
  return new HttpError(409, 'PAYMENT_ALREADY_IN_PROGRESS', message)
}

export function paymentStateUnknown(message = '支付状态未知，请稍后查询') {
  return new HttpError(409, 'PAYMENT_STATE_UNKNOWN', message)
}

export function paymentCompletionNotSupported(message = '当前支付方式不支持服务端完成') {
  return new HttpError(409, 'PAYMENT_COMPLETION_NOT_SUPPORTED', message)
}

export function paymentRefundNotSupported(message = '当前支付渠道不支持自动退款') {
  return new HttpError(409, 'PAYMENT_REFUND_NOT_SUPPORTED', message)
}

export function refundBalanceInsufficient(message = '可用积分不足，无法退款') {
  return new HttpError(409, 'REFUND_BALANCE_INSUFFICIENT', message)
}

export function refundRequiresReview(message = '退款需要人工审核') {
  return new HttpError(409, 'REFUND_REQUIRES_REVIEW', message)
}

export function accountSpendingRestricted(message = '当前账户暂不可消费积分') {
  return new HttpError(403, 'ACCOUNT_SPENDING_RESTRICTED', message)
}
