import { Request, Response, NextFunction } from 'express'
import * as configService from './service.js'

export async function registry(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await configService.getConfigRegistry())
  } catch (err) {
    next(err)
  }
}
