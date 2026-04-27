import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { prisma } from '../modules/auth/service.js'

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

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录' })
    return
  }

  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Token 已过期，请重新登录' })
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' })
    return
  }
  next()
}
