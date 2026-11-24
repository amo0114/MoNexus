import type { Request, Response, NextFunction } from 'express'
import * as fakaSync from '../catalog/fakaSync.js'
import * as fakaCatalogAdmin from './fakaCatalogAdmin.js'
import * as fakaTaskAdmin from './fakaTaskAdmin.js'
import * as offerAdmin from './fakaOfferAdmin.js'

export async function previewRebindOfferSku(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    res.json(await offerAdmin.previewRebindAdminOfferSku(id, offerId, req.body.sku))
  } catch (err) { next(err) }
}

export async function rebindOfferSku(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, offerId } = req.params as unknown as { id: number; offerId: number }
    if (!req.body.sourceHash) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: '重绑 SKU 需要 sourceHash' } })
      return
    }
    res.json(await offerAdmin.rebindAdminOfferSku(req.user!.userId, id, offerId, {
      sku: req.body.sku,
      sourceHash: req.body.sourceHash,
    }))
  } catch (err) { next(err) }
}

export async function previewFakaSync(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await fakaSync.previewAdminFakaSync(productId))
  } catch (err) { next(err) }
}

export async function confirmFakaSync(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(await fakaSync.confirmAdminFakaSync(
      req.user!.userId,
      productId,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    ))
  } catch (err) { next(err) }
}

export async function setFakaCapacity(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.json(
      await fakaCatalogAdmin.setAdminFakaCapacity(req.user!.userId, productId, {
        offerId: req.body.offerId,
        capacityLimit: req.body.capacityLimit,
      })
    )
  } catch (err) {
    next(err)
  }
}

export async function fakaCatalog(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await fakaCatalogAdmin.listAdminFakaCatalog())
  } catch (err) {
    next(err)
  }
}

export async function importFakaPlan(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await fakaCatalogAdmin.importAdminFakaPlan(
      req.user!.userId,
      req.body,
      req.headers['idempotency-key'] as string | undefined,
    )
    res.status(result.replayed ? 200 : 201).json(result)
  } catch (err) {
    next(err)
  }
}

export async function previewFakaPlan(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await fakaCatalogAdmin.previewAdminFakaPlan(req.body))
  } catch (err) {
    next(err)
  }
}

export async function addFakaOffers(req: Request, res: Response, next: NextFunction) {
  try {
    const productId = req.params.id as unknown as number
    res.status(201).json(
      await fakaCatalogAdmin.addAdminFakaOffers(req.user!.userId, productId, {
        offers: req.body.offers,
      })
    )
  } catch (err) {
    next(err)
  }
}

export async function listFakaTasks(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await fakaTaskAdmin.listFakaBridgeTasks(req.query as any))
  } catch (err) {
    next(err)
  }
}

export async function fakaTaskStats(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await fakaTaskAdmin.getFakaBridgeTaskStats())
  } catch (err) {
    next(err)
  }
}

export async function retryFakaTask(req: Request, res: Response, next: NextFunction) {
  try {
    const taskId = req.params.id as unknown as number
    res.json(await fakaTaskAdmin.retryFakaBridgeTask(req.user!.userId, taskId))
  } catch (err) {
    next(err)
  }
}

export async function forceFakaRevoke(req: Request, res: Response, next: NextFunction) {
  try {
    const taskId = req.params.id as unknown as number
    res.json(await fakaTaskAdmin.forceFakaBridgeRevoke(req.user!.userId, taskId))
  } catch (err) {
    next(err)
  }
}

