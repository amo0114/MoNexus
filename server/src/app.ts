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
import { adminRoutes } from './modules/admin/routes.js'
import { merchantRoutes } from './modules/merchant/routes.js'
import { dashboardRoutes } from './modules/dashboard/routes.js'
import { uploadsRoutes } from './modules/uploads/routes.js'
import { configRoutes } from './modules/config/routes.js'

const app = express()
initErrorReporter()

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
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
app.use('/api/products', productRoutes)
app.use('/api/points', pointRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/merchant/dashboard', dashboardRoutes)
app.use('/api/merchant', merchantRoutes)
app.use('/api/uploads', uploadsRoutes)
app.use('/api/config', configRoutes)

app.use(errorHandler)

export { app }
