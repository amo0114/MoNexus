/** Escape text for safe inclusion in HTML email bodies. */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escape and convert plain newlines to <br> for simple multi-line blocks. */
export function htmlEscapeMultiline(value: string): string {
  return htmlEscape(value).replace(/\r\n|\r|\n/g, '<br>\n')
}
