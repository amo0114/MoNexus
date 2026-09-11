import { Router } from 'express'
import { getProductTemplateRegistry } from './registry.js'

const router = Router()

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60')
  res.status(200).json(getProductTemplateRegistry())
})

export { router as productTemplateRoutes }
