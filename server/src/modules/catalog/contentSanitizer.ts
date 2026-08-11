import sanitizeHtml from 'sanitize-html'

/** Server-side allowlist for Xboard rich descriptions. Runtime rendering still
 * applies DOMPurify as a second, independent boundary. */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'a'],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['https'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        rel: 'noopener noreferrer',
      },
    }),
  },
  // `img` is intentionally absent: remote images are never imported in P0.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
}

export function sanitizeCatalogRichContent(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null
  const sanitized = sanitizeHtml(input, RICH_TEXT_OPTIONS).trim()
  return sanitized || null
}

export function catalogPlainTextSummary(input: string | null | undefined, maxLength = 500): string {
  if (typeof input !== 'string' || input.trim() === '') return ''
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
