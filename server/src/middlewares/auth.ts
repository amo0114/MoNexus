import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { forbidden, unauthenticated } from '../lib/httpError.js'
import { prisma } from '../lib/prisma.js'

export interface AuthPayload {
  userId: number
  role: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    next(unauthenticated('未登录'))
    return
  }

  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload
    req.user = payload
    next()
  } catch {
    next(unauthenticated('Token 已过期，请重新登录'))
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    next(forbidden('需要管理员权限'))
    return
  }
  next()
}

export async function requireMerchant(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'merchant') {
    next(forbidden('需要商家权限'))
    return
  }

  try {
    const merchant = await prisma.merchant.findUnique({
      where: { userId: req.user.userId },
      select: { status: true },
    })

    if (!merchant || merchant.status !== 'active') {
      next(forbidden('需要已激活商家权限'))
      return
    }

    next()
  } catch (err) {
    next(err)
  }
}
