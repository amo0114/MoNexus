import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middlewares/validate.js'
import { getRestoreBootstrapStatus, createRestoreBootstrapAdmin } from './bootstrap.js'

const router = Router()

const createBootstrapAdminSchema = z.object({
  token: z.string().min(1).max(512),
  email: z.string().trim().email(),
  password: z.string().min(12, '管理员密码至少 12 个字符').max(256),
}).strict()

router.get('/status', async (_req, res, next) => {
  try {
    res.json(await getRestoreBootstrapStatus())
  } catch (err) {
    next(err)
  }
})

router.post('/admin', validate(createBootstrapAdminSchema), async (req, res, next) => {
  try {
    await createRestoreBootstrapAdmin(req.body.token, req.body.email, req.body.password)
    res.status(201).json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export { router as portableRestoreBootstrapRoutes }
