import type { NextFunction, Request, Response } from 'express'
import * as adminService from './adminService.js'
import type {
  PaymentDisputeStatus,
  PaymentEventStatus,
  PaymentProviderName,
  RechargeCurrency,
  RechargeOrderStatus,
  RechargePricePolicyStatus,
  RechargeRefundStatus,
  ReconciliationScopeType,
} from './types.js'

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as {
      page: number
      pageSize: number
      status?: RechargeOrderStatus
      userId?: number
      provider?: PaymentProviderName
    }
    res.json(await adminService.adminListOrders(query))
  } catch (err) {
    next(err)
  }
}

export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminGetOrder(String(req.params.id)))
  } catch (err) {
    next(err)
  }
}

export async function listRefunds(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as {
      page: number
      pageSize: number
      status?: RechargeRefundStatus
      userId?: number
      orderId?: string
      provider?: PaymentProviderName
      from?: string
      to?: string
    }
    res.json(await adminService.adminListRefunds(query))
  } catch (err) {
    next(err)
  }
}

export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as {
      page: number
      pageSize: number
      status?: PaymentEventStatus
      provider?: PaymentProviderName
    }
    res.json(await adminService.adminListEvents(query))
  } catch (err) {
    next(err)
  }
}

export async function retryEvent(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminRetryEvent(String(req.params.id), req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function reconcileOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminReconcileOrder(String(req.params.id), req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function requestRefund(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await adminService.adminRequestRefund(
      String(req.params.id),
      req.user!.userId,
      typeof req.body?.reasonCode === 'string' ? req.body.reasonCode : undefined,
    ))
  } catch (err) {
    next(err)
  }
}

export async function confirmSandboxOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminConfirmSandboxOrder(
      String(req.params.id),
      req.user!.userId,
    ))
  } catch (err) {
    next(err)
  }
}

export async function listReconRuns(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminListReconRuns())
  } catch (err) {
    next(err)
  }
}

export async function createReconRun(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as {
      provider: PaymentProviderName
      providerAccountKey?: string
      scopeType: ReconciliationScopeType
      scopeKey?: string
    }
    res.status(201).json(await adminService.adminCreateReconRun({
      ...body,
      createdByUserId: req.user!.userId,
    }))
  } catch (err) {
    next(err)
  }
}

export async function rerunRecon(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminRerunRecon(String(req.params.id), req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function listDisputes(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as {
      page: number
      pageSize: number
      status?: PaymentDisputeStatus
    }
    res.json(await adminService.adminListDisputes(query))
  } catch (err) {
    next(err)
  }
}

export async function resolveDispute(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminResolveDispute(
      String(req.params.id),
      req.body.outcome as 'won' | 'lost',
      req.user!.userId,
    ))
  } catch (err) {
    next(err)
  }
}

export async function closeRecoveryCase(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminCloseRecoveryCase(
      String(req.params.id),
      req.body.status as 'recovered' | 'written_off' | 'restored',
      req.user!.userId,
      typeof req.body.resolutionReason === 'string' ? req.body.resolutionReason : undefined,
    ))
  } catch (err) {
    next(err)
  }
}

export async function listPricePolicies(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as {
      page: number
      pageSize: number
      currency?: RechargeCurrency
      status?: RechargePricePolicyStatus
      adminSandbox?: 'true' | 'false'
    }
    res.json(await adminService.adminListPricePolicies({
      page: query.page,
      pageSize: query.pageSize,
      currency: query.currency,
      status: query.status,
      adminSandbox: query.adminSandbox === undefined ? undefined : query.adminSandbox === 'true',
    }))
  } catch (err) {
    next(err)
  }
}

export async function createPricePolicy(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await adminService.adminCreatePricePolicy(req.body, req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function patchPricePolicy(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminPatchPricePolicy(String(req.params.id), req.body, req.user!.userId))
  } catch (err) {
    next(err)
  }
}

export async function activatePricePolicy(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await adminService.adminActivatePricePolicy(String(req.params.id), req.user!.userId))
  } catch (err) {
    next(err)
  }
}
