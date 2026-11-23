import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import CreditsPage from './CreditsPage'

describe('CreditsPage', () => {
  it('renders all four AI companion cards, switches to capability overview, and shows MoYuan signature', () => {
    render(
      <MemoryRouter initialEntries={['/credits']}>
        <CreditsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('credits-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /与我的 AI 伙伴们/ })).toBeInTheDocument()
    expect(screen.getByTestId('companion-card-claude')).toHaveTextContent('Claude')
    expect(screen.getByTestId('companion-card-gemini')).toHaveTextContent('Gemini')
    expect(screen.getByTestId('companion-card-chatgpt')).toHaveTextContent('ChatGPT')
    expect(screen.getByTestId('companion-card-deepseek')).toHaveTextContent('DeepSeek')
    expect(screen.getByTestId('credits-signature')).toHaveTextContent('MoYuan')

    fireEvent.click(screen.getByTestId('credits-view-overview'))
    expect(screen.getByTestId('credits-capability-overview')).toBeInTheDocument()
    expect(screen.queryByTestId('companion-card-claude')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('credits-view-cards'))
    expect(screen.getByTestId('companion-card-claude')).toBeInTheDocument()
  })
})
