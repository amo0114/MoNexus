export type RedirectAction = {
  type: 'redirect'
  url: string
  expiresAt?: string
}

export type QrCodeAction = {
  type: 'qr_code'
  content: string
  display: 'text' | 'image_url'
  expiresAt?: string
}

export type ClientSecretAction = {
  type: 'client_secret'
  clientSecret: string
  expiresAt?: string
}

export type FormPostAction = {
  type: 'form_post'
  actionUrl: string
  method: 'POST'
  fields: Record<string, string>
  expiresAt?: string
}

export type NoneAction = {
  type: 'none'
}

export type PublicPaymentAction =
  | RedirectAction
  | QrCodeAction
  | ClientSecretAction
  | FormPostAction
  | NoneAction
  | null

export class UnsafePaymentUrlError extends Error {
  readonly code = 'UNSAFE_PAYMENT_URL'
  constructor(message = '支付跳转地址不安全') {
    super(message)
    this.name = 'UnsafePaymentUrlError'
  }
}

/** Match server form_post field bounds (providers/formPost.ts). */
export const FORM_POST_MAX_FIELDS = 32
export const FORM_POST_MAX_NAME_LENGTH = 64
export const FORM_POST_MAX_VALUE_LENGTH = 1024
export const FORM_POST_FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/

/** Redirect/form action URLs must be HTTPS; javascript:/data:/http: are not allowed. */
export function assertSafeHttpUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafePaymentUrlError()
  }
  if (parsed.protocol !== 'https:') {
    throw new UnsafePaymentUrlError()
  }
  return parsed.toString()
}

export function buildFormPostForm(action: FormPostAction): HTMLFormElement {
  if (action.method !== 'POST') {
    throw new UnsafePaymentUrlError('仅支持 POST 表单提交')
  }
  const fields = action.fields ?? {}
  const keys = Object.keys(fields)
  if (keys.length > FORM_POST_MAX_FIELDS) {
    throw new UnsafePaymentUrlError('支付表单字段过多')
  }
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = assertSafeHttpUrl(action.actionUrl)
  form.acceptCharset = 'UTF-8'
  form.style.display = 'none'
  for (const name of keys) {
    if (name.length > FORM_POST_MAX_NAME_LENGTH || !FORM_POST_FIELD_NAME.test(name)) {
      throw new UnsafePaymentUrlError('支付表单字段名不合法')
    }
    const raw = fields[name]
    const value = typeof raw === 'string' ? raw : String(raw)
    if (value.length > FORM_POST_MAX_VALUE_LENGTH) {
      throw new UnsafePaymentUrlError('支付表单字段过长')
    }
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  return form
}

export function submitFormPost(action: FormPostAction): void {
  const form = buildFormPostForm(action)
  document.body.appendChild(form)
  form.submit()
}

export function goToRedirect(url: string): void {
  window.location.assign(assertSafeHttpUrl(url))
}

export function isHttpsImageUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
