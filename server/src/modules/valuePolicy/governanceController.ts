import type { NextFunction, Request, Response } from 'express'
import {
  createPolicyCommand,
  transitionPolicyCommand,
} from './governanceCommandService.js'
import {
  validateValuePolicyIdempotencyKey,
  type CreateValuePolicyGovernanceInput,
  type TransitionValuePolicyGovernanceInput,
} from './governanceSchema.js'

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const key = validateValuePolicyIdempotencyKey(req.get('Idempotency-Key'))
    const result = await createPolicyCommand(
      req.user!.userId,
      key,
      req.body as CreateValuePolicyGovernanceInput,
    )
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    next(error)
  }
}

function transition(action: 'approve' | 'schedule' | 'activate' | 'retire') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = validateValuePolicyIdempotencyKey(req.get('Idempotency-Key'))
      const result = await transitionPolicyCommand(
        action,
        req.params.id as string,
        req.user!.userId,
        key,
        req.body as TransitionValuePolicyGovernanceInput,
      )
      res.json(result)
    } catch (error) {
      next(error)
    }
  }
}

export const approve = transition('approve')
export const schedule = transition('schedule')
export const activate = transition('activate')
export const retire = transition('retire')
