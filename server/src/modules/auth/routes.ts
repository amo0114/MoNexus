import { Router } from 'express'
import { validate } from '../../middlewares/validate.js'
import { authenticate } from '../../middlewares/auth.js'
import { registerSchema, loginSchema, refreshSchema } from './schema.js'
import * as controller from './controller.js'

const router = Router()

router.post('/register', validate(registerSchema), controller.register)
router.post('/login', validate(loginSchema), controller.login)
router.post('/refresh', validate(refreshSchema), controller.refresh)
router.get('/me', authenticate, controller.me)

export { router as authRoutes }
