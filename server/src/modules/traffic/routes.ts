import { Router } from 'express'
import { authenticateIfPresent, requireActiveUserIfPresent } from '../../middlewares/auth.js'
import { validate } from '../../middlewares/validate.js'
import { collect } from './controller.js'
import { trafficEventSchema } from './schema.js'

export const trafficRoutes = Router()
trafficRoutes.post('/events', authenticateIfPresent, requireActiveUserIfPresent, validate(trafficEventSchema), collect)
