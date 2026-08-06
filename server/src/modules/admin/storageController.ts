import { Request, Response, NextFunction } from 'express'
import * as storageService from './storageService.js'

export async function storageStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await storageService.getStorageStatus())
  } catch (err) {
    next(err)
  }
}

export async function listStorageProviders(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await storageService.listStorageProviders())
  } catch (err) {
    next(err)
  }
}

export async function createStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await storageService.createStorageProvider(req.user!.userId, req.body))
  } catch (err) {
    next(err)
  }
}

export async function updateStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await storageService.updateStorageProvider(req.user!.userId, id, req.body))
  } catch (err) {
    next(err)
  }
}

export async function testStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await storageService.testStorageProvider(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function activateStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await storageService.activateStorageProvider(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function rollbackStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await storageService.rollbackStorageProvider(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function disableStorageProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await storageService.disableStorageProvider(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}
