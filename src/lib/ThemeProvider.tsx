import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'soft' | 'ink'

const STORAGE_KEY = 'theme'
const THEME_BACKGROUND: Record<Theme, string> = {
  light: '#F8FAFC',
  dark: '#0A0A14',
  soft: '#FFF8EC',
  ink: '#EEF0EE',
}

/** 品牌素材文件名：ink 主题对应 black 系列（favicon-black-* / mark-black）。 */
const ASSET_VARIANT: Record<Theme, string> = {
  light: 'light',
  dark: 'dark',
  soft: 'soft',
  ink: 'black',
}

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'ink',
  setTheme: () => {},
})

// Legacy stored values: 'default' was the old system's explicit light
// choice, so it maps to light. Unknown values fall back to null and receive
// the product default (ink) in the provider below.
function normalizeTheme(raw: string | null): Theme | null {
  if (raw === 'dark' || raw === 'soft' || raw === 'ink') return raw
  if (raw === 'light' || raw === 'default') return 'light'
  return null
}

function applyTheme(t: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', t === 'dark')
  if (t === 'soft' || t === 'ink') {
    root.setAttribute('data-theme', t)
  } else {
    root.removeAttribute('data-theme')
  }
  const variant = ASSET_VARIANT[t]
  document
    .querySelectorAll<HTMLLinkElement>('link[data-brand-favicon-size]')
    .forEach((link) => {
      const size = link.dataset.brandFaviconSize
      if (size) {
        link.href = '/brand/ledger-knot/favicon-' + variant + '-' + size + '.png'
      }
    })

  const appleTouchIcon = document.getElementById('brand-apple-touch-icon') as HTMLLinkElement | null
  if (appleTouchIcon) {
    appleTouchIcon.href = '/brand/ledger-knot/favicon-' + variant + '-180.png'
  }

  const themeColor = document.getElementById('brand-theme-color') as HTMLMetaElement | null
  if (themeColor) {
    themeColor.content = THEME_BACKGROUND[t]
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'ink'
    // A first visit should present the approved 墨韵 palette consistently,
    // rather than silently varying with the operating-system colour scheme.
    // Existing explicit choices remain untouched.
    return normalizeTheme(localStorage.getItem(STORAGE_KEY)) ?? 'ink'
  })

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Only explicit user choices are persisted. The absence of a preference
  // always resolves to the approved ink default on a later visit too.
  const setTheme = (t: Theme) => {
    setThemeState(t)
    try { localStorage.setItem(STORAGE_KEY, t) } catch {}
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
