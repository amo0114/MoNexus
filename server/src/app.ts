import express from 'express'
import cors from 'cors'
import { errorHandler } from './middlewares/errorHandler.js'
import { authRoutes } from './modules/auth/routes.js'
import { productRoutes } from './modules/products/routes.js'
import { pointRoutes } from './modules/points/routes.js'
import { orderRoutes } from './modules/orders/routes.js'
import { adminRoutes } from './modules/admin/routes.js'

const app = express()

app.use(cors())
app.use(express.json())

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/points', pointRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/admin', adminRoutes)

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// Global error handler
app.use(errorHandler)

export { app }
