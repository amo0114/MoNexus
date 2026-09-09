const PRODUCT_PATH = /^\/product\/(\d+)$/

export function parseSafeProductReturnTo(value: string | null | undefined): string | null {
  if (!value || value.includes('\\') || value.includes('//') || /[\u0000-\u001f]/.test(value)) {
    return null
  }
  try {
    const decoded = decodeURIComponent(value)
    if (decoded !== value && (decoded.includes('\\') || decoded.includes('//'))) return null
    const url = new URL(value, 'https://monexus.invalid')
    if (url.username || url.password || url.hash) return null
    if (!PRODUCT_PATH.test(url.pathname)) return null
    const offerId = url.searchParams.get('offerId')
    if (offerId != null && !/^[1-9]\d*$/.test(offerId)) return null
    if ([...url.searchParams.keys()].some(key => key !== 'offerId')) return null
    return `${url.pathname}${offerId ? `?offerId=${offerId}` : ''}`
  } catch {
    return null
  }
}
