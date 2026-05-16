import { Router } from 'express'
import * as controller from './controller.js'

const router = Router()

// Public read-only metadata for UI labels, tones, and operational display defaults.
router.get('/registry', controller.registry)

export { router as configRoutes }
