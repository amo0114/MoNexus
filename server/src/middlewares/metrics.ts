import type { NextFunction, Request, Response } from 'express'
import { httpRequestDuration, httpRequestsTotal } from '../lib/metrics.js'

function routeLabel(req: Request) {
  if (!req.route) return 'unknown'

  const routePath = Array.isArray(req.route.path)
    ? req.route.path.join('|')
    : String(req.route.path)

  if (!req.baseUrl) return routePath
  if (routePath === '/') return req.baseUrl
  return `${req.baseUrl}${routePath}`
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/api/metrics') {
    next()
    return
  }

  const startNs = process.hrtime.bigint()

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    }

    httpRequestsTotal.inc(labels)
    httpRequestDuration.observe(labels, durationSec)
  })

  next()
}
