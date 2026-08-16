import { describe, expect, it } from 'vitest'
import { catalogPlainTextSummary, sanitizeCatalogRichContent } from './contentSanitizer.js'

describe('catalog rich-content sanitizer', () => {
  it('keeps the frozen formatting allowlist and removes executable/remote content', () => {
    const hostile = `
      <h2 onclick="steal()">套餐介绍</h2>
      <script>alert(1)</script><style>body{display:none}</style>
      <p>安全<strong>正文</strong><img src="https://evil.test/a.png" onerror="steal()"></p>
      <a href="javascript:steal()">坏链接</a>
      <a href="data:text/html,bad">数据链接</a>
      <a href="https://safe.example/path" onclick="steal()">安全链接</a>
      <iframe src="https://evil.test"></iframe><form><input></form>
    `
    const sanitized = sanitizeCatalogRichContent(hostile)!
    expect(sanitized).toContain('<h2>套餐介绍</h2>')
    expect(sanitized).toContain('<strong>正文</strong>')
    expect(sanitized).toContain('href="https://safe.example/path"')
    for (const forbidden of ['script', 'style', 'iframe', 'form', '<img', 'onclick', 'onerror', 'javascript:', 'data:']) {
      expect(sanitized.toLowerCase()).not.toContain(forbidden)
    }
    expect(catalogPlainTextSummary(sanitized)).toContain('套餐介绍 安全正文')
  })
})
