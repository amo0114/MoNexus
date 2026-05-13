import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'default' | 'soft'

const STORAGE_KEY = 'theme'

interface ThemeContextValue {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'default',
  setTheme: () => {},
  toggle: () => {},
})

function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'default') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', t)
  }
  if (t === 'soft') {
    root.classList.remove('dark')
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'default'
    return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'default'
  })

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch {}
  }, [theme])

  const setTheme = (t: Theme) => setThemeState(t)
  const toggle = () => setThemeState((prev) => (prev === 'default' ? 'soft' : 'default'))

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
