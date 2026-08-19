import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { initErrorReporter } from './lib/errorReporter.js'
import { registry } from './lib/metrics.js'
import { metricsMiddleware } from './middlewares/metrics.js'
import { requestLogger } from './middlewares/requestLogger.js'
import { errorHandler } from './middlewares/errorHandler.js'
import healthRoutes from './modules/health/routes.js'
import { authRoutes } from './modules/auth/routes.js'
import { productRoutes } from './modules/products/routes.js'
import { pointRoutes } from './modules/points/routes.js'
import { orderRoutes } from './modules/orders/routes.js'
import { checkoutRoutes } from './modules/checkout/routes.js'
import { valuePolicyRoutes } from './modules/valuePolicy/routes.js'
import { rechargeRoutes } from './modules/recharge/routes.js'
import { adminRoutes } from './modules/admin/routes.js'
import { merchantRoutes } from './modules/merchant/routes.js'
import { dashboardRoutes } from './modules/dashboard/routes.js'
import { leaderboardRoutes } from './modules/leaderboard/routes.js'
import { inviteRoutes } from './modules/invite/routes.js'
import { uploadsRoutes } from './modules/uploads/routes.js'
import { deliveryFileRoutes } from './modules/uploads/deliveryFileRoutes.js'
import { configRoutes } from './modules/config/routes.js'
import { announcementRoutes } from './modules/announcements/routes.js'
import { notificationRoutes } from './modules/notifications/routes.js'
import { portableRestoreBootstrapRoutes } from './modules/portable-backups/bootstrap-routes.js'
import { fakaBridgeRoutes } from './modules/fakaBridge/routes.js'
import { legalRoutes } from './modules/legal/routes.js'
import { publicSponsoredRouter } from './modules/merchandising/promotions/publicRoutes.js'
import { publicEditorialRouter, adminEditorialRouter } from './modules/merchandising/editorial/routes.js'
import { merchantPromotionRouter, adminPromotionRouter } from './modules/merchandising/promotions/routes.js'
import { merchantEntitlementRouter, adminEntitlementRouter } from './modules/merchandising/entitlements/routes.js'
import { merchandisingAdminRouter } from './integrations/cmi/merchandisingAdminRoutes.js'
import { paymentWebhookRoutes } from './modules/payment/webhooks/routes.js'

const app = express()

// Behind nginx in production, express-rate-limit needs the real client IP
// from X-Forwarded-For. Setting trust proxy here makes req.ip reflect the
// client IP (not nginx's internal IP), so per-IP rate limiting actually works.
// `false` disables the behavior (direct connections, e.g. dev/test).
app.set('trust proxy', config.trustProxy)

initErrorReporter()

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.apiRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  // SSE connection admission has a dedicated 60-second limiter and hard
  // connection caps. Do not also charge each connect/reconnect against the
  // general REST budget: the two windows otherwise couple independently
  // bounded stream churn to unrelated API availability.
  skip: req => req.method === 'GET' && req.path === '/notifications/stream',
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    },
  },
})

app.use(requestLogger)
app.use(helmet())
app.use(cors({
  origin: config.frontendOrigin,
  credentials: true,
}))
app.use(cookieParser())

const paymentWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后再试',
    },
  },
})
// Provider webhooks must see the raw body and must not share the generic /api limiter.
app.use('/api/payment/webhooks', paymentWebhookLimiter, paymentWebhookRoutes)

app.use(express.json({ limit: '1mb' }))
app.use(metricsMiddleware)

app.use('/api/health', healthRoutes)

app.get('/api/metrics', async (req, res) => {
  if (config.metricsToken) {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${config.metricsToken}`) {
      res.status(401).type('text/plain').send('unauthorized')
      return
    }
  }

  try {
    res.set('Content-Type', registry.contentType)
    res.send(await registry.metrics())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    res.status(500).type('text/plain').send(`metrics error: ${message}`)
  }
})

app.use('/api', apiLimiter)

app.use('/api/auth', authRoutes)
// Public Merch shelves must precede Product `/:id`, otherwise Express would
// parse `sponsored`/`editorial` as a product id.
app.use('/api/products', publicSponsoredRouter)
app.use('/api/products', publicEditorialRouter)
app.use('/api/products', productRoutes)
app.use('/api/points', pointRoutes)
app.use('/api/leaderboard', leaderboardRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/checkout', checkoutRoutes)
app.use('/api/value-policy', valuePolicyRoutes)
app.use('/api/recharge', rechargeRoutes)
app.use('/api/faka-bridge', fakaBridgeRoutes)
app.use('/api/admin', adminPromotionRouter)
app.use('/api/admin', adminEditorialRouter)
app.use('/api/admin', adminEntitlementRouter)
app.use('/api/admin', merchandisingAdminRouter)
app.use('/api/admin', adminRoutes)
app.use('/api/merchant/dashboard', dashboardRoutes)
// Registration is intentionally outside the merchant-only subtree in
// merchantRoutes; it must reach its own authenticated/value-gate chain before
// the merchandising routers apply requireMerchant.
app.use('/api/merchant', merchantRoutes)
app.use('/api/merchant', merchantPromotionRouter)
app.use('/api/merchant', merchantEntitlementRouter)
// P5：交付文件路由先挂——uploads 里的 GET /:key 是贪婪参数路由，后挂会吞掉
// /delivery-signed/:token。
app.use('/api/uploads', deliveryFileRoutes)
app.use('/api/uploads', uploadsRoutes)
app.use('/api/config', configRoutes)
app.use('/api/legal', legalRoutes)
app.use('/api/announcements', announcementRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/portable-restore/bootstrap', portableRestoreBootstrapRoutes)

app.use(errorHandler)

export { app }
