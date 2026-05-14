import * as Sentry from '@sentry/react'
import { onCLS, onLCP, onINP, onFCP, onTTFB, type Metric } from 'web-vitals'

function reportToSentry(metric: Metric) {
  // Client may be undefined if Sentry isn't initialized (no DSN); guard.
  const client = Sentry.getClient?.()
  if (!client) return

  // Use addBreadcrumb for low-noise visibility in the regular issue view…
  Sentry.addBreadcrumb({
    category: 'web-vitals',
    message: metric.name,
    level: 'info',
    data: {
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
      navigationType: metric.navigationType,
    },
  })

  // …and a measurement on the current scope's transaction (if any) so the
  // numeric value lands in Performance dashboards.
  Sentry.setMeasurement(metric.name, metric.value, metric.name === 'CLS' ? '' : 'millisecond')

  // Also fire a low-cardinality tag for quick filtering in Issues.
  Sentry.setTag(`webvital.${metric.name.toLowerCase()}.rating`, metric.rating)
}

export function initWebVitals() {
  // Production-only. Dev mode generates noisy / unreliable metrics under
  // Vite HMR and would pollute the Sentry quota.
  if (!import.meta.env.PROD) return

  // No-op if Sentry isn't wired up (missing DSN). The reportToSentry guard
  // handles this defensively, but we also avoid registering listeners at all.
  if (!import.meta.env.VITE_SENTRY_DSN) return

  onCLS(reportToSentry)
  onLCP(reportToSentry)
  onINP(reportToSentry)
  onFCP(reportToSentry)
  onTTFB(reportToSentry)
}
