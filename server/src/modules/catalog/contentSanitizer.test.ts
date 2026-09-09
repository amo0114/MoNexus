import { describe, expect, it } from 'vitest'
import {
  catalogPlainTextSummary,
  listPersistedDescriptionImages,
  sanitizeCatalogRichContent,
  sanitizeProductRichContent,
} from './contentSanitizer.js'

const hostile = `
  <h2 onclick="steal()">套餐介绍</h2>
  <script>alert(1)</script><style>body{display:none}</style>
  <p>安全<strong>正文</strong><img src="https://evil.test/a.png" onerror="steal()"></p>
  <a href="javascript:steal()">坏链接</a>
  <a href="data:text/html,bad">数据链接</a>
  <a href="https://safe.example/path" onclick="steal()">安全链接</a>
  <iframe src="https://evil.test"></iframe><form><input></form>
`

describe('catalog rich-content sanitizer', () => {
  it('keeps the frozen formatting allowlist and removes executable/remote content', () => {
    const sanitized = sanitizeCatalogRichContent(hostile)!
    expect(sanitized).toContain('<h2>套餐介绍</h2>')
    expect(sanitized).toContain('<strong>正文</strong>')
    expect(sanitized).toContain('href="https://safe.example/path"')
    for (const forbidden of ['script', 'style', 'iframe', 'form', '<img', 'onclick', 'onerror', 'javascript:', 'data:']) {
      expect(sanitized.toLowerCase()).not.toContain(forbidden)
    }
    expect(catalogPlainTextSummary(sanitized)).toContain('套餐介绍 安全正文')
  })

  it('still strips img even when the HTML only contains a local upload image', () => {
    const sanitized = sanitizeCatalogRichContent(
      '<p>介绍<img src="/uploads/local.webp" alt="图"></p>',
    )!
    expect(sanitized).toContain('<p>介绍</p>')
    expect(sanitized.toLowerCase()).not.toContain('<img')
  })
})

describe('product rich-content sanitizer', () => {
  const localSrc = '/uploads/catalog-local.webp'
  const allowlist = [{
    src: localSrc,
    ref: { kind: 'upload' as const, objectKey: 'catalog-local.webp' },
  }]

  it('keeps a local upload img that matches the descriptionImages allowlist', () => {
    const sanitized = sanitizeProductRichContent(
      `<p>介绍<img src="${localSrc}" alt="样图" onclick="steal()"></p>`,
      allowlist,
    )!
    expect(sanitized).toContain(`<img src="${localSrc}" alt="样图"`)
    expect(sanitized.toLowerCase()).not.toContain('onclick')
  })

  it('keeps a static /assets/ img whose ref path is under /assets/', () => {
    const src = '/assets/catalog/sample.png'
    const sanitized = sanitizeProductRichContent(
      `<p><img src="${src}" alt=""></p>`,
      [{ src, ref: { kind: 'static', path: src } }],
    )!
    expect(sanitized).toContain(`<img src="${src}"`)
  })

  it('strips remote evil img that is not in the allowlist', () => {
    const sanitized = sanitizeProductRichContent(
      `<p>介绍<img src="${localSrc}" alt="样图"><img src="https://evil.test/a.png" onerror="steal()"></p>`,
      allowlist,
    )!
    expect(sanitized).toContain(`<img src="${localSrc}"`)
    expect(sanitized.toLowerCase()).not.toContain('evil.test')
    expect(sanitized.toLowerCase()).not.toContain('onerror')
  })

  it('drops an img whose src is listed but whose ref is not upload/static', () => {
    const sanitized = sanitizeProductRichContent(
      `<p><img src="${localSrc}"></p>`,
      [{ src: localSrc, ref: { kind: 'remote', objectKey: 'catalog-local.webp' } }],
    )
    expect(sanitized ?? '').not.toContain('<img')
  })

  it('rebuilds descriptionImages from persisted local srcs', () => {
    expect(listPersistedDescriptionImages(
      `<p><img src="${localSrc}" alt="样图"><img src="/assets/catalog/sample.png"></p>`,
    )).toEqual([
      { src: localSrc, ref: { kind: 'upload', objectKey: 'catalog-local.webp' } },
      { src: '/assets/catalog/sample.png', ref: { kind: 'static', path: '/assets/catalog/sample.png' } },
    ])
  })
})
