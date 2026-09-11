import sanitizeHtml from 'sanitize-html'
import { prisma } from '../../lib/prisma.js'
import {
  MediaRefResolutionError,
  resolveLegacyPlatformImageUrl,
  type MediaDb,
} from './platformMedia.js'

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

export type ProductDescriptionImage = {
  src: string
  ref:
    | { kind: 'upload'; objectKey: string }
    | { kind: 'static'; path: string }
}

function allowedImageSrcSet(allowedCanonicalSrcs: readonly string[]): Set<string> {
  const allowed = new Set<string>()
  for (const src of allowedCanonicalSrcs) {
    if (typeof src === 'string' && src.length > 0) allowed.add(src)
  }
  return allowed
}

export function sanitizeCatalogRichContent(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const sanitized = sanitizeHtml(input, RICH_TEXT_OPTIONS).trim()
  return sanitized || null
}

/** Local product editor sanitizer: same formatting tags as Xboard, plus img
 * whose src is an already-resolved canonical URL. Callers must resolve
 * descriptionImages via StoredObject/static resolver before invoking. */
export function sanitizeProductRichContent(
  input: string | null | undefined,
  allowedCanonicalSrcs: readonly string[] = [],
  srcRewrites: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const allowedSrc = allowedImageSrcSet(allowedCanonicalSrcs)
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
        const rawSrc = attribs.src
        const src = rawSrc && srcRewrites.has(rawSrc) ? srcRewrites.get(rawSrc) : rawSrc
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

function extractPersistedImageSrcs(input: string | null | undefined): string[] {
  if (typeof input !== 'string' || input.trim() === '') return []
  const srcs: string[] = []
  const seen = new Set<string>()
  sanitizeHtml(input, {
    allowedTags: ['img'],
    allowedAttributes: { img: ['src'] },
    exclusiveFilter: frame => {
      const src = frame.attribs?.src
      if (frame.tag === 'img' && src && !seen.has(src)) {
        seen.add(src)
        srcs.push(src)
      }
      return true
    },
  })
  return srcs.slice(0, 12)
}

function descriptionImageFromResolved(
  resolved: Awaited<ReturnType<typeof resolveLegacyPlatformImageUrl>>,
): ProductDescriptionImage | null {
  if (resolved.source === 'static_asset') {
    return { src: resolved.canonicalUrl, ref: { kind: 'static', path: resolved.canonicalUrl } }
  }
  if (resolved.source === 'upload_image' && resolved.objectKey) {
    return { src: resolved.canonicalUrl, ref: { kind: 'upload', objectKey: resolved.objectKey } }
  }
  return null
}

/** Rebuild the write-side descriptionImages mapping from persisted HTML.
 * Absolute CDN URLs go through the platform resolver; unresolved remotes are dropped. */
export async function listPersistedDescriptionImages(
  input: string | null | undefined,
  db: MediaDb = prisma,
): Promise<ProductDescriptionImage[]> {
  const images: ProductDescriptionImage[] = []
  for (const src of extractPersistedImageSrcs(input)) {
    try {
      const mapped = descriptionImageFromResolved(await resolveLegacyPlatformImageUrl(src, db))
      if (mapped) images.push(mapped)
    } catch (err) {
      if (err instanceof MediaRefResolutionError) continue
      throw err
    }
  }
  return images
}

export function catalogPlainTextSummary(input: string | null | undefined, maxLength = 500): string {
  if (typeof input !== 'string' || input.trim() === '') return ''
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
