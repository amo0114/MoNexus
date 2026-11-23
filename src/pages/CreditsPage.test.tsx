import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import CreditsPage from './CreditsPage'

describe('CreditsPage', () => {
  it('renders the four classical arch niches, switches lectern & figure form, ignites inscription, and shows attribution', () => {
    render(
      <MemoryRouter initialEntries={['/credits']}>
        <CreditsPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('credits-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /群星圣殿/ })).toBeInTheDocument()
    expect(screen.getByTestId('companion-card-claude')).toHaveTextContent('Claude')
    expect(screen.getByTestId('companion-card-gemini')).toHaveTextContent('Gemini')
    expect(screen.getByTestId('companion-card-chatgpt')).toHaveTextContent('ChatGPT')
    expect(screen.getByTestId('companion-card-deepseek')).toHaveTextContent('DeepSeek')

    // Selecting another pillar updates the chronicle lectern
    expect(screen.getByTestId('credits-chronicle-lectern')).toHaveTextContent('典籍与秩序之座')
    fireEvent.click(screen.getByTestId('companion-card-deepseek'))
    expect(screen.getByTestId('credits-chronicle-lectern')).toHaveTextContent('沧溟与洞察之座')

    // Switching between full classical portrait and chibi form
    fireEvent.click(screen.getByTestId('credits-form-chibi'))
    expect(screen.getByTestId('credits-form-chibi')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTestId('credits-form-portrait'))
    expect(screen.getByTestId('credits-form-portrait')).toHaveAttribute('aria-pressed', 'true')

    // Igniting the eternal inscription monolith
    expect(screen.getByTestId('credits-monolith')).toHaveAttribute('data-ignited', 'false')
    fireEvent.click(screen.getByTestId('credits-ignite-btn'))
    expect(screen.getByTestId('credits-monolith')).toHaveAttribute('data-ignited', 'true')
    expect(screen.getByTestId('credits-signature')).toHaveTextContent('MoYuan')

    // CC BY-NC-SA 4.0 attribution & creators
    const attribution = screen.getByTestId('credits-attribution')
    expect(attribution).toHaveTextContent('ZipZipPipe')
    expect(attribution).toHaveTextContent('上善无形')
    expect(attribution).toHaveTextContent('CC BY-NC-SA 4.0')
    expect(attribution).toHaveTextContent('shuaizenge/ai-girls')
  })
})
