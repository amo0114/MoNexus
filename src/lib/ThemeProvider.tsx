import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'soft' | 'ink'

const STORAGE_KEY = 'theme'
const THEME_BACKGROUND: Record<Theme, string> = {
  light: '#F8FAFC',
  dark: '#0A0A14',
  soft: '#FFF8EC',
  ink: '#F4F1E9',
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
  theme: 'light',
  setTheme: () => {},
})

// Legacy stored values: 'default' was the old system's explicit light
// choice, so it maps to light (NOT to system preference) — this keeps it
// consistent with the index.html boot script, which treats any stored
// non-dark/non-soft value as light. Unknown values fall back to null
// (caller then follows the OS).
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

function systemPreference(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light'
    return normalizeTheme(localStorage.getItem(STORAGE_KEY)) ?? systemPreference()
  })

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Follow live OS theme changes only while the user has not made an
  // explicit choice (nothing stored). Once setTheme persists a value,
  // the stored choice wins and OS changes are ignored.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      try {
        if (!localStorage.getItem(STORAGE_KEY)) {
          setThemeState(systemPreference())
        }
      } catch {}
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Only persist explicit user choices; OS-derived defaults stay unpersisted
  // so the app keeps following the OS until the user picks a theme.
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
