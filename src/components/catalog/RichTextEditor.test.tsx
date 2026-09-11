import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import RichTextEditor, { sanitizePastedHtml } from './RichTextEditor'

const TOOLBAR_LABELS = [
  '撤销',
  '重做',
  '段落',
  '二级标题',
  '三级标题',
  '加粗',
  '斜体',
  '无序列表',
  '有序列表',
  '引用',
  '链接',
  '清除格式',
] as const

describe('RichTextEditor (spec §5.1)', () => {
  it('renders the frozen visual toolbar labels', () => {
    render(<RichTextEditor value={null} onChange={vi.fn()} />)
    expect(screen.getByRole('toolbar', { name: '图文编辑工具栏' })).toBeInTheDocument()
    for (const label of TOOLBAR_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('hides insert-image until the parent supplies onInsertImage', () => {
    const { rerender } = render(<RichTextEditor value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '插入图片' })).not.toBeInTheDocument()
    rerender(<RichTextEditor value={null} onChange={vi.fn()} onInsertImage={vi.fn()} />)
    expect(screen.getByRole('button', { name: '插入图片' })).toBeInTheDocument()
  })

  it('does not provide a Markdown or HTML source mode toggle', () => {
    render(<RichTextEditor value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Markdown' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'HTML' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Markdown|HTML|源码/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /Markdown|HTML|源码/i })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Markdown/)
  })

  it('strips scripts, styles, and external images from pasted HTML', () => {
    const pasted = sanitizePastedHtml(`
      <p style="color:red">正文<script>alert(1)</script></p>
      <img src="https://evil.example/remote.png" onerror="alert(2)" />
      <img src="/uploads/local.png" alt="站内" />
      <img src="data:image/png;base64,aaaa" />
    `)
    expect(pasted).toContain('正文')
    expect(pasted).not.toMatch(/script/i)
    expect(pasted).not.toMatch(/style=/i)
    expect(pasted).not.toMatch(/onerror/i)
    expect(pasted).not.toMatch(/evil\.example/)
    expect(pasted).not.toMatch(/data:image/)
    expect(pasted).toContain('/uploads/local.png')
  })
})
