import { Request, Response, NextFunction } from 'express'
import * as authService from './service.js'

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, inviteCode } = req.body
    const result = await authService.registerUser(
      email, password, inviteCode,
      req.ip, req.headers['user-agent']
    )
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body
    const result = await authService.loginUser(
      email, password,
      req.ip, req.headers['user-agent']
    )
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body
    const result = await authService.refreshAccessToken(refreshToken)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await authService.getUserProfile(req.user!.userId)
    res.json(profile)
  } catch (err) {
    next(err)
  }
}
