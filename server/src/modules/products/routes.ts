import { Router } from 'express'
import * as controller from './controller.js'

const router = Router()

router.get('/', controller.list)
router.get('/:id', controller.detail)

export { router as productRoutes }
