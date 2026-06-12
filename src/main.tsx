import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import * as Sentry from '@sentry/react'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { ThemeProvider } from './lib/ThemeProvider'
import { initWebVitals } from './lib/webVitals'

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
)
