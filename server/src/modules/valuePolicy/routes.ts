import { Router } from 'express'
import * as controller from './controller.js'

/**
 * SPEC-VALUE-POLICY-P1-001: current value policy.
 * off → 404 VALUE_POLICY_DISABLED. Never leaks draft/approved/scheduled rows.
 */
const router = Router()

router.get('/current', controller.current)

export { router as valuePolicyRoutes }
