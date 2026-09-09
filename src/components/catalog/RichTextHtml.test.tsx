import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import RichTextHtml from './RichTextHtml'

describe('RichTextHtml (spec §5.2)', () => {
  it('renders nothing for empty or null HTML and does not show a 图文介绍 shell', () => {
    const { container, rerender } = render(<RichTextHtml html={null} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('rich-text-html')).not.toBeInTheDocument()
    expect(screen.queryByText('图文介绍')).not.toBeInTheDocument()

    rerender(<RichTextHtml html="" />)
    expect(container).toBeEmptyDOMElement()

    rerender(<RichTextHtml html="   <p> <br> </p>  " />)
    expect(screen.queryByTestId('rich-text-html')).not.toBeInTheDocument()
    expect(screen.queryByText('图文介绍')).not.toBeInTheDocument()
  })

  it('keeps allowlisted markup and strips script/onerror/external images', () => {
    render(
      <RichTextHtml
        html={`
          <h2>套餐介绍</h2>
          <p>正文<script>alert(1)</script></p>
          <img src="/uploads/local.png" alt="站内图" onerror="alert(2)" style="display:none" />
          <img src="https://evil.example/x.png" onerror="steal()" />
          <a href="javascript:alert(3)">危险链接</a>
          <a href="https://example.com/safe">安全链接</a>
        `}
      />,
    )
    const root = screen.getByTestId('rich-text-html')
    expect(root).toHaveTextContent('套餐介绍')
    expect(root).toHaveTextContent('正文')
    expect(root.innerHTML).not.toMatch(/<script/i)
    expect(root.innerHTML).not.toMatch(/onerror/i)
    expect(root.innerHTML).not.toMatch(/alert/)
    expect(root.innerHTML).not.toMatch(/javascript:/i)
    expect(root.innerHTML).not.toMatch(/style=/i)

    const images = Array.from(root.querySelectorAll('img'))
    expect(images.some((image) => image.getAttribute('src') === '/uploads/local.png')).toBe(true)
    for (const image of images) {
      expect(image.getAttribute('onerror')).toBeNull()
      expect(image.getAttribute('style')).toBeNull()
    }

    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/safe')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
