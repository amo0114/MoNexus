import { purchaseReset } from '../../xboardAccounts/purchase.js'
import { createIntent, confirmReset, resetStatus, resetIntentStatus } from '../../trafficReset/intents.js'
import { processResetOperation } from '../../trafficReset/worker.js'
import { logger } from '../../../lib/logger.js'
import { config } from '../../../config/index.js'
import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../../../lib/prisma.js'
import { abuseLimiter } from '../../../lib/abuseLimiter.js'
import { consumeAbuseBucket } from '../../auth/authProtection.js'
import { forbidden } from '../../../lib/httpError.js'
import { listAccounts, profile, selectDefault } from '../../xboardAccounts/queries.js'

export function handleXboardQuery(action: 'purchase-reset' | 'accounts' | 'profile' | 'select-default' | 'reset-intents' | 'resets' | 'reset-status' | 'reset-intent-status') {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'private, no-store')
    try {
      const { platformId } = req.body
      const binding = await prisma.chatBinding.findUnique({ where: { platform_platformId: { platform: 'qq', platformId } },
        select: { id: true, userId: true, user: { select: { status: true } } } })
      if (!binding) { res.json({ bound: false }); return }
      if (binding.user.status !== '正常') throw forbidden('当前账号不可用')
      await consumeAbuseBucket(() => abuseLimiter.consume({ flow: 'xboard-account-query', dimension: 'user', limit: 10, windowMs: 60_000 }, binding.userId))
      const actor = { userId: binding.userId, bindingId: binding.id, platformId }
      const result = action === 'purchase-reset' ? await purchaseReset(actor, req.body.accountLinkId)
        : action === 'reset-intents' ? await createIntent(actor, req.body)
        : action === 'reset-intent-status' ? await resetIntentStatus(actor, req.body.intentId)
        : action === 'resets' ? await confirmReset(actor, req.body)
          : action === 'reset-status' ? await resetStatus(actor, req.body.operationId)
            : action === 'accounts' ? await listAccounts(actor)
        : action === 'profile' ? await profile(actor, req.body.accountLinkId)
          : await selectDefault(actor, req.body.accountLinkId, req.body.requestId)
      if (action === 'resets') {
        res.status(202).json({ bound: true, ...result })
        if (config.nodeEnv !== 'test' && 'operationId' in result) void processResetOperation(result.operationId).catch(() => logger.warn('initial reset attempt deferred to worker'))
      } else res.json({ bound: true, ...result })
    } catch (error) { next(error) }
  }
}
