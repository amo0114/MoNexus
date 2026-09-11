import DOMPurify from 'dompurify'

/** Spec §5.2 allowlist. `b`/`i` are kept by purify; the server normalizes them. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'blockquote',
  'a',
  'img',
  'b',
  'i',
] as const

const ALLOWED_ATTR = ['href', 'src', 'alt', 'rel'] as const
const IMAGE_ALT_MAX = 200

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'svg', 'link', 'meta']
const FORBID_ATTR = ['style', 'srcset', 'onerror', 'onclick', 'onload', 'target']

export function isAllowedRichTextHref(href: string): boolean {
  const value = href.trim()
  if (!value || value.startsWith('//') || value.includes('\\')) return false
  if (value.startsWith('/')) return true
  if (/[\u0000-\u001F\u007F]/.test(value)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

function isDangerousMediaSrc(src: string): boolean {
  const value = src.trim()
  if (!value || value.startsWith('//')) return true
  return /^(javascript|data|blob|file|vbscript):/i.test(value)
}

/** Renderer allowlist: `/` paths or http(s) without userinfo. Server sanitizer is authoritative. */
export function isAllowedRichTextImageSrc(src: string): boolean {
  if (isDangerousMediaSrc(src)) return false
  const value = src.trim()
  if (value.startsWith('/')) return true
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Paste path: drop remote/data images; do not fetch them. */
export function isAllowedPastedImageSrc(src: string): boolean {
  if (isDangerousMediaSrc(src)) return false
  const value = src.trim()
  if (value.startsWith('/')) return true
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (typeof window === 'undefined' || !window.location?.origin) {
      return url.pathname.startsWith('/uploads/')
    }
    return url.origin === window.location.origin
  } catch {
    return false
  }
}

function remapLegacyHeadings(html: string): string {
  return html
    .replace(/<\s*h1(\s|>)/gi, '<h2$1')
    .replace(/<\s*\/\s*h1\s*>/gi, '</h2>')
    .replace(/<\s*h[4-6](\s|>)/gi, '<h3$1')
    .replace(/<\s*\/\s*h[4-6]\s*>/gi, '</h3>')
}

function postProcessSanitizedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    if (!isAllowedRichTextHref(href)) {
      anchor.replaceWith(...Array.from(anchor.childNodes))
      return
    }
    anchor.setAttribute('rel', 'noopener noreferrer')
    anchor.removeAttribute('target')
  })
  doc.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? ''
    if (!isAllowedRichTextImageSrc(src)) {
      image.remove()
      return
    }
    const alt = (image.getAttribute('alt') ?? '').slice(0, IMAGE_ALT_MAX)
    image.setAttribute('alt', alt)
    for (const attr of Array.from(image.attributes)) {
      if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'srcset') {
        image.removeAttribute(attr.name)
      }
    }
  })
  return doc.body.innerHTML.trim()
}

/** Shared DOMPurify pipeline for preview and product-detail rendering. */
export function sanitizeRichTextHtml(html: string | null | undefined): string {
  if (typeof html !== 'string' || html.trim() === '') return ''
  const purified = DOMPurify.sanitize(remapLegacyHeadings(html), {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  })
  if (!purified.trim()) return ''
  const cleaned = postProcessSanitizedHtml(purified)
  if (!cleaned) return ''
  const probe = new DOMParser().parseFromString(cleaned, 'text/html')
  const hasImage = probe.querySelector('img') != null
  const text = (probe.body.textContent ?? '').replace(/\u00a0/g, ' ').trim()
  if (!hasImage && text === '') return ''
  return cleaned
}

export interface RichTextHtmlProps {
  html: string | null | undefined
  className?: string
}

/**
 * Sanitized HTML renderer for catalog rich descriptions (spec §5.1–5.2).
 * Empty / fully-stripped input renders nothing — no “图文介绍” shell.
 */
export default function RichTextHtml({ html, className }: RichTextHtmlProps) {
  const sanitized = sanitizeRichTextHtml(html)
  if (!sanitized) return null
  return (
    <div
      className={className}
      data-testid="rich-text-html"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  )
}
