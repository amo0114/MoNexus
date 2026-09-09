import sanitizeHtml from 'sanitize-html'

/** Server-side allowlist for Xboard rich descriptions. Runtime rendering still
 * applies DOMPurify as a second, independent boundary. */
const BASE_ALLOWED_TAGS = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'a'] as const

const LINK_TRANSFORM: NonNullable<sanitizeHtml.IOptions['transformTags']> = {
  a: (_tagName, attribs) => ({
    tagName: 'a',
    attribs: {
      ...(attribs.href ? { href: attribs.href } : {}),
      rel: 'noopener noreferrer',
    },
  }),
}

const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...BASE_ALLOWED_TAGS],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['https'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: LINK_TRANSFORM,
  // `img` is intentionally absent: remote images are never imported in P0.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
}

export type ProductRichImageAllowlistItem = {
  src: string
  ref: {
    kind: string
    objectKey?: string
    path?: string
  }
}

export type ProductDescriptionImage = {
  src: string
  ref:
    | { kind: 'upload'; objectKey: string }
    | { kind: 'static'; path: string }
}

function isAllowlistedImageRef(ref: ProductRichImageAllowlistItem['ref']): boolean {
  if (ref.kind === 'upload') {
    return typeof ref.objectKey === 'string' && ref.objectKey.length > 0
  }
  if (ref.kind === 'static') {
    return typeof ref.path === 'string' && /^\/assets\//.test(ref.path)
  }
  return false
}

function allowedImageSrcSet(allowedImages: ProductRichImageAllowlistItem[]): Set<string> {
  const allowed = new Set<string>()
  for (const image of allowedImages) {
    if (typeof image.src !== 'string' || image.src.length === 0) continue
    if (!isAllowlistedImageRef(image.ref)) continue
    allowed.add(image.src)
  }
  return allowed
}

export function sanitizeCatalogRichContent(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const sanitized = sanitizeHtml(input, RICH_TEXT_OPTIONS).trim()
  return sanitized || null
}

/** Local product editor sanitizer: same formatting tags as Xboard, plus img
 * whose src is in the descriptionImages allowlist with an upload/static ref. */
export function sanitizeProductRichContent(
  input: string | null | undefined,
  allowedImages: ProductRichImageAllowlistItem[] = [],
): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const allowedSrc = allowedImageSrcSet(allowedImages)
  const sanitized = sanitizeHtml(input, {
    allowedTags: [...BASE_ALLOWED_TAGS, 'img'],
    allowedAttributes: { a: ['href', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['https'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      ...LINK_TRANSFORM,
      img: (_tagName, attribs) => {
        const src = attribs.src
        const alt = attribs.alt
        return {
          tagName: 'img',
          attribs: {
            ...(src ? { src } : {}),
            ...(typeof alt === 'string' && alt.length > 0 ? { alt: alt.slice(0, 200) } : {}),
          },
        }
      },
    },
    exclusiveFilter: frame => {
      if (frame.tag !== 'img') return false
      const src = frame.attribs?.src
      return !src || !allowedSrc.has(src)
    },
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  }).trim()
  return sanitized || null
}

function refFromPersistedSrc(src: string): ProductDescriptionImage['ref'] | null {
  if (src.startsWith('/assets/')) return { kind: 'static', path: src }
  const upload = src.match(/\/uploads\/([A-Za-z0-9._~+-]+)$/)
  if (upload) return { kind: 'upload', objectKey: upload[1] }
  return null
}

/** Rebuild the write-side descriptionImages mapping from persisted HTML. */
export function listPersistedDescriptionImages(
  input: string | null | undefined,
): ProductDescriptionImage[] {
  if (typeof input !== 'string' || input.trim() === '') return []
  const images: ProductDescriptionImage[] = []
  const seen = new Set<string>()
  sanitizeHtml(input, {
    allowedTags: ['img'],
    allowedAttributes: { img: ['src'] },
    exclusiveFilter: frame => {
      const src = frame.attribs?.src
      if (frame.tag === 'img' && src && !seen.has(src)) {
        seen.add(src)
        const ref = refFromPersistedSrc(src)
        if (ref) images.push({ src, ref })
      }
      return true
    },
  })
  return images.slice(0, 12)
}

export function catalogPlainTextSummary(input: string | null | undefined, maxLength = 500): string {
  if (typeof input !== 'string' || input.trim() === '') return ''
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
