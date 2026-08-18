import { Router } from 'express'
import { validate } from '../../middlewares/validate.js'
import * as controller from './governanceController.js'
import {
  createValuePolicyGovernanceSchema,
  transitionValuePolicyGovernanceSchema,
  valuePolicyIdParamSchema,
} from './governanceSchema.js'

// Mounted inside /api/admin after authenticate → active → admin → MFA.
// Production remains fail-closed in governanceCommandService until the
// separately reviewed production-activation gate is removed.
const router = Router()

router.post('/', validate(createValuePolicyGovernanceSchema), controller.create)
router.post('/:id/approve', validate({ params: valuePolicyIdParamSchema, body: transitionValuePolicyGovernanceSchema }), controller.approve)
router.post('/:id/schedule', validate({ params: valuePolicyIdParamSchema, body: transitionValuePolicyGovernanceSchema }), controller.schedule)
router.post('/:id/activate', validate({ params: valuePolicyIdParamSchema, body: transitionValuePolicyGovernanceSchema }), controller.activate)
router.post('/:id/retire', validate({ params: valuePolicyIdParamSchema, body: transitionValuePolicyGovernanceSchema }), controller.retire)

export { router as valuePolicyGovernanceRoutes }
