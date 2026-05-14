import { Router } from 'express'
import { checkLiveness, checkReadiness } from './service.js'

const router = Router()

router.get('/live', (_req, res) => {
  res.status(200).json(checkLiveness())
})

router.get('/ready', async (_req, res) => {
  const result = await checkReadiness()
  res.status(result.status === 'ready' ? 200 : 503).json(result)
})

router.get('/', (_req, res) => {
  res.status(200).json(checkLiveness())
})

export default router
