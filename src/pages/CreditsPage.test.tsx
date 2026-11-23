import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import CreditsPage from './CreditsPage'

describe('CreditsPage', () => {
  it('renders all four AI companions and the author signature', () => {
    render(
      <MemoryRouter initialEntries={['/credits']}>
        <CreditsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('credits-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '致谢一路同行的伙伴' })).toBeInTheDocument()
    expect(screen.getByTestId('companion-card-claude')).toHaveTextContent('Claude')
    expect(screen.getByTestId('companion-card-gemini')).toHaveTextContent('Gemini')
    expect(screen.getByTestId('companion-card-chatgpt')).toHaveTextContent('ChatGPT')
    expect(screen.getByTestId('companion-card-deepseek')).toHaveTextContent('DeepSeek')
    expect(screen.getByTestId('credits-signature')).toHaveTextContent('MoYuan')
  })
})
