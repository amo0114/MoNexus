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

/** Only http(s) URLs may leave the app; javascript:/data: would execute attacker content. */
export function assertSafeHttpUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafePaymentUrlError()
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafePaymentUrlError()
  }
  return parsed.toString()
}

export function buildFormPostForm(action: FormPostAction): HTMLFormElement {
  if (action.method !== 'POST') {
    throw new UnsafePaymentUrlError('仅支持 POST 表单提交')
  }
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = assertSafeHttpUrl(action.actionUrl)
  form.acceptCharset = 'UTF-8'
  form.style.display = 'none'
  for (const [name, raw] of Object.entries(action.fields ?? {})) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = typeof raw === 'string' ? raw : String(raw)
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
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
