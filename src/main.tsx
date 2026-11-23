import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import * as Sentry from '@sentry/react'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { ThemeProvider } from './lib/ThemeProvider'
import { initWebVitals } from './lib/webVitals'
import { installChunkRecovery } from './lib/chunkRecovery'

if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual'
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    integrations: [],
  })
}

initWebVitals()
installChunkRecovery()

if (import.meta.env.MODE !== 'test') {
  console.info(
    '%cMONEXUS%c  Co-built by MoYuan with Claude · Gemini · ChatGPT · DeepSeek → /credits',
    'background:#4f46e5;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700;letter-spacing:0.12em',
    'color:#64748b;font-weight:500',
  )
}

if (import.meta.env.DEV) {
  import('./stores/appStore').then(({ useAppStore }) => {
    ;(window as any).__appStore = useAppStore
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
)
