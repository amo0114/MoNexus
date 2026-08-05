import { htmlEscape } from './escape.js'
import { MAIL_COLORS, type MailBrandContext } from './tokens.js'

const C = MAIL_COLORS
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

/**
 * Alignment rules (transactional email):
 *
 * | Region              | Align  | Why                                      |
 * |---------------------|--------|------------------------------------------|
 * | Brand (logo+name)   | center | Identity lockup                          |
 * | Title (H1)          | center | Visual focus                             |
 * | Short lead (≤1–2行) | center | Paired with title on action mails        |
 * | Long body / tips    | left   | Multi-line readability                   |
 * | Primary CTA         | center | Action focus                             |
 * | OTP block           | center | Numeric focus                            |
 * | Key-value table     | left   | Scan label → value                       |
 * | Fallback long URL   | left   | Break/select friendly                    |
 * | Warning banner      | left   | Alert reading                            |
 * | Footer legal/sys    | center | Secondary, balanced close                |
 */
export type MailTextAlign = 'left' | 'center'

export interface HtmlLayoutInput {
  brand: MailBrandContext
  /** Pre-escaped or trusted HTML fragment for the card body. */
  bodyHtml: string
  /** Optional preheader (hidden inbox preview text). */
  preheader?: string
}

/**
 * Table-based HTML shell for email clients. `bodyHtml` is inserted as trusted
 * markup produced by kind templates (dynamic values must already be escaped).
 */
export function wrapHtml(input: HtmlLayoutInput): string {
  const { brand, bodyHtml, preheader } = input
  const site = htmlEscape(brand.siteName)
  const logoUrl = htmlEscape(brand.logoUrl)
  const pre =
    preheader != null && preheader.length > 0
      ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${htmlEscape(preheader)}</div>`
      : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${site}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.bg};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;background-color:${C.surface};border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <!-- Brand lockup: roomy vertical lockup, centered mark + wordmark -->
        <tr>
          <td align="center" style="padding:48px 28px 36px 28px;background-color:${C.surface};border-bottom:1px solid ${C.border};">
            <img src="${logoUrl}" width="72" height="72" alt="${site}" style="display:block;margin:0 auto 16px auto;border:0;outline:none;text-decoration:none;width:72px;height:72px;">
            <div style="font-family:${FONT};font-size:22px;font-weight:700;line-height:1.25;color:${C.text};letter-spacing:0.06em;">${site}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px 16px 28px;font-family:${FONT};color:${C.text};font-size:15px;line-height:1.65;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:18px 28px 28px 28px;font-family:${FONT};font-size:12px;line-height:1.55;color:${C.muted};border-top:1px solid ${C.border};">
            本邮件由 ${site} 自动发送，请勿直接回复。<br>
            如非本人操作，请忽略本邮件。
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

function alignStyle(align: MailTextAlign): string {
  return align === 'center' ? 'text-align:center;' : 'text-align:left;'
}

/** Main title — default center. */
export function headingHtml(title: string, align: MailTextAlign = 'center'): string {
  return `<h1 style="margin:0 0 14px 0;font-size:20px;font-weight:700;line-height:1.35;color:${C.text};${alignStyle(align)}">${htmlEscape(title)}</h1>`
}

/** Body paragraph — default left (long copy). */
export function paragraphHtml(text: string, align: MailTextAlign = 'left'): string {
  return `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.65;color:${C.text};${alignStyle(align)}">${htmlEscape(text)}</p>`
}

/** Muted secondary note — default left. */
export function mutedParagraphHtml(text: string, align: MailTextAlign = 'left'): string {
  return `<p style="margin:0 0 14px 0;font-size:13px;line-height:1.55;color:${C.muted};${alignStyle(align)}">${htmlEscape(text)}</p>`
}

/** Primary CTA button — always centered. */
export function ctaButtonHtml(label: string, href: string): string {
  const safeHref = htmlEscape(href)
  const safeLabel = htmlEscape(label)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 20px 0;border-collapse:collapse;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td align="center" bgcolor="${C.cta}" style="border-radius:8px;background-color:${C.cta};">
            <a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:15px;font-weight:600;color:${C.onPrimary};text-decoration:none;border-radius:8px;">${safeLabel}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`
}

/** Long fallback URL — left-aligned for select/copy. */
export function linkFallbackHtml(href: string): string {
  const safe = htmlEscape(href)
  return `<p style="margin:0 0 14px 0;font-size:13px;line-height:1.55;color:${C.muted};text-align:left;word-break:break-all;">若按钮无法点击，请复制以下链接到浏览器打开：<br><a href="${safe}" style="color:${C.primary};text-decoration:underline;">${safe}</a></p>`
}

/**
 * Detail fields — stacked label-above-value (not a two-column grid table).
 * Modern receipt / meta-card pattern that stays readable in major clients.
 */
export function kvTableHtml(rows: Array<{ label: string; value: string }>): string {
  if (rows.length === 0) return ''

  const blocks = rows
    .map((row, index) => {
      const isLast = index === rows.length - 1
      const padTop = index === 0 ? '0' : '14px'
      const padBottom = isLast ? '0' : '14px'
      const border = isLast ? 'none' : `1px solid ${C.border}`
      return `<tr>
      <td style="padding:${padTop} 0 ${padBottom} 0;border-bottom:${border};">
        <div style="font-family:${FONT};font-size:12px;line-height:1.4;letter-spacing:0.03em;color:${C.muted};margin:0 0 5px 0;">${htmlEscape(row.label)}</div>
        <div style="font-family:${FONT};font-size:16px;font-weight:600;line-height:1.45;color:${C.text};word-break:break-word;">${htmlEscape(row.value)}</div>
      </td>
    </tr>`
    })
    .join('')

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;border-collapse:separate;border-spacing:0;background-color:${C.bg};border:1px solid ${C.border};border-radius:12px;">
  <tr>
    <td style="padding:20px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        ${blocks}
      </table>
    </td>
  </tr>
</table>`
}

/** OTP — always centered. */
export function otpCodeHtml(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 22px 0;border-collapse:separate;border-spacing:0;">
  <tr>
    <td align="center" style="padding:28px 20px;background-color:${C.codeBg};border:1px solid ${C.border};border-radius:12px;">
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:0.32em;color:${C.primary};">${htmlEscape(code)}</span>
    </td>
  </tr>
</table>`
}

/** Warning banner — left-aligned alert copy. */
export function warningBannerHtml(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:collapse;">
  <tr>
    <td style="padding:12px 14px;background-color:${C.warningBg};border:1px solid ${C.warningBorder};border-left:4px solid ${C.warning};border-radius:6px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.warningText};text-align:left;">
      ${htmlEscape(text)}
    </td>
  </tr>
</table>`
}

/** Join non-empty plain-text paragraphs with blank lines. */
export function joinText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join('\n\n')
}
