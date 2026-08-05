/**
 * Email brand tokens — product default **墨韵 (ink)** palette from
 * `src/index.css` `:root[data-theme="ink"]` (email-safe solid hex only).
 */
export const MAIL_COLORS = {
  /** 花青 — links, OTP, brand accent */
  primary: '#34507A',
  primaryHover: '#2A4266',
  /** 淡花青 */
  secondary: '#6B86A8',
  /** 松绿 — primary CTA */
  cta: '#3D7257',
  ctaHover: '#315C46',
  /** 松烟墨 */
  text: '#22262C',
  /** 淡墨 */
  muted: '#666E77',
  /** 冷白宣纸 */
  bg: '#EEF0EE',
  /** 卡纸 */
  surface: '#F8F9F7',
  /** 绫绢灰边 */
  border: '#D9DDD9',
  /** 苔黄警示 */
  warning: '#677220',
  warningBg: '#EFF0DC',
  warningBorder: '#D6D9B4',
  warningText: '#4C541A',
  /** 花青浅洗 — OTP / 信息底 */
  codeBg: '#E8EDF2',
  /** 白字 on 花青/松绿 */
  onPrimary: '#FFFFFF',
} as const

export const MAIL_SITE_NAME = 'MoNexus'

/**
 * Ink-theme brand mark (black ledger-knot). No light/indigo variant in mail.
 * Path is under the public origin served by the frontend.
 */
export const MAIL_LOGO_PATH = '/brand/ledger-knot/mark-black.png'

export interface MailBrandContext {
  siteName: string
  appBaseUrl: string
  logoUrl: string
}

/**
 * Default public origin for logo/link bases.
 * Mirrors `config.appBaseUrl` (APP_BASE_URL ?? FRONTEND_ORIGIN) without importing
 * the full config module, so template rendering / preview scripts stay free of
 * DATABASE_URL and other boot-time secrets.
 */
function defaultAppBaseUrl(): string {
  const fromEnv = process.env.APP_BASE_URL || process.env.FRONTEND_ORIGIN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return 'http://localhost:5173'
}

/**
 * Resolve brand context for templates.
 * Trailing slashes on `appBaseUrl` are stripped.
 */
export function resolveMailBrand(overrides?: Partial<MailBrandContext>): MailBrandContext {
  const siteName = overrides?.siteName ?? MAIL_SITE_NAME
  const appBaseUrl = (overrides?.appBaseUrl ?? defaultAppBaseUrl()).replace(/\/+$/, '')
  const logoUrl = overrides?.logoUrl ?? `${appBaseUrl}${MAIL_LOGO_PATH}`
  return { siteName, appBaseUrl, logoUrl }
}
