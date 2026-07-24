import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'soft'

const STORAGE_KEY = 'theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  setTheme: () => {},
})

// Legacy stored values: 'default' (old light) and anything unknown fall back to light.
function normalizeTheme(raw: string | null): Theme | null {
  if (raw === 'light' || raw === 'dark' || raw === 'soft') return raw
  return null
}

function applyTheme(t: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', t === 'dark')
  if (t === 'soft') {
    root.setAttribute('data-theme', 'soft')
  } else {
    root.removeAttribute('data-theme')
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
