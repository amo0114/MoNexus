import { Router } from 'express'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { candidates } from './controller.js'
import { candidatesQuerySchema } from './schema.js'

export const storefrontRoutes = Router()
storefrontRoutes.get('/candidates', authenticateIfPresent, requireActiveUserIfPresent,
  validate({ query: candidatesQuerySchema }), candidates)
