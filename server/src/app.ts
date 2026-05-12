import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser'
import { config } from './config/index.js'
import { prisma } from './lib/prisma.js'
import { initErrorReporter } from './lib/errorReporter.js'
import { requestLogger } from './middlewares/requestLogger.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { authRoutes } from './modules/auth/routes.js'
import { productRoutes } from './modules/products/routes.js'
import { pointRoutes } from './modules/points/routes.js'
import { orderRoutes } from './modules/orders/routes.js'
import { adminRoutes } from './modules/admin/routes.js'
import { merchantRoutes } from './modules/merchant/routes.js'
import { uploadsRoutes } from './modules/uploads/routes.js'

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
app.use('/api', apiLimiter)

app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/points', pointRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/merchant', merchantRoutes)
app.use('/api/uploads', uploadsRoutes)

app.get('/api/health', async (_req, res) => {
  const time = new Date().toISOString()

  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', db: 'ok', time })
  } catch {
    res.status(503).json({ status: 'fail', db: 'fail', time })
  }
})

app.use(errorHandler)

export { app }
