import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider, useTheme, type Theme } from './ThemeProvider'

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  return (
    <div>
      <span data-testid="active-theme">{theme}</span>
      {(['ink', 'light', 'dark', 'soft'] as Theme[]).map((t) => (
        <button key={t} type="button" onClick={() => setTheme(t)}>
          {t}
        </button>
      ))}
    </div>
  )
}

function mountFaviconHead() {
  document.head.innerHTML = `
    <link id="brand-favicon-ico" rel="shortcut icon" type="image/x-icon" href="/brand/ledger-knot/favicon-light.ico" />
    <link id="brand-favicon-16" rel="icon" type="image/png" sizes="16x16" href="/brand/ledger-knot/favicon-light-16.png" data-brand-favicon-size="16" />
    <link id="brand-favicon-32" rel="icon" type="image/png" sizes="32x32" href="/brand/ledger-knot/favicon-light-32.png" data-brand-favicon-size="32" />
    <link id="brand-favicon-48" rel="icon" type="image/png" sizes="48x48" href="/brand/ledger-knot/favicon-light-48.png" data-brand-favicon-size="48" />
    <link id="brand-apple-touch-icon" rel="apple-touch-icon" sizes="180x180" href="/brand/ledger-knot/favicon-light-180.png" />
    <meta id="brand-theme-color" name="theme-color" content="#F8FAFC" />
  `
}

describe('ThemeProvider favicon synchronization', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    mountFaviconHead()
  })

  afterEach(() => {
    document.head.innerHTML = ''
  })

  it('updates shortcut icon (.ico), PNG favicons, apple-touch-icon and theme-color across all themes', () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>,
    )

    const cases: Array<{ theme: Theme; asset: string; bg: string }> = [
      { theme: 'ink', asset: 'black', bg: '#EEF0EE' },
      { theme: 'soft', asset: 'soft', bg: '#FFF8EC' },
      { theme: 'dark', asset: 'dark', bg: '#0A0A14' },
      { theme: 'light', asset: 'light', bg: '#F8FAFC' },
    ]

    for (const { theme, asset, bg } of cases) {
      fireEvent.click(screen.getByRole('button', { name: theme }))
      expect(screen.getByTestId('active-theme')).toHaveTextContent(theme)
      expect(document.getElementById('brand-favicon-ico')?.getAttribute('href')).toBe(
        `/brand/ledger-knot/favicon-${asset}.ico`,
      )
      expect(document.getElementById('brand-favicon-16')?.getAttribute('href')).toBe(
        `/brand/ledger-knot/favicon-${asset}-16.png`,
      )
      expect(document.getElementById('brand-favicon-32')?.getAttribute('href')).toBe(
        `/brand/ledger-knot/favicon-${asset}-32.png`,
      )
      expect(document.getElementById('brand-favicon-48')?.getAttribute('href')).toBe(
        `/brand/ledger-knot/favicon-${asset}-48.png`,
      )
      expect(document.getElementById('brand-apple-touch-icon')?.getAttribute('href')).toBe(
        `/brand/ledger-knot/favicon-${asset}-180.png`,
      )
      expect(document.getElementById('brand-theme-color')?.getAttribute('content')).toBe(bg)
    }
  })
})
