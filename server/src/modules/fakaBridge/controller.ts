import type { NextFunction, Request, Response } from 'express'
import {
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  listBoundProvisionEmails,
  sendProvisionEmailCode,
} from '../../lib/fakaBridge/provisionEmailProof.js'

export async function sendProvisionCode(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await sendProvisionEmailCode(req.user!.userId, req.body.email)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function confirmProvisionCode(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await confirmProvisionEmailCode(
      req.user!.userId,
      req.body.email,
      req.body.code
    )
    res.json(result)
  } catch (err) {
    next(err)
  }
}

export async function provisionEmailStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const email = String(req.query.email ?? '')
    const result = await getProvisionEmailStatus(req.user!.userId, email)
    res.json(result)
  } catch (err) {
    next(err)
  }
}

/** GET bound Xboard emails for this MoNexus account (permanent OTP binds + account email). */
export async function listBoundEmails(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await listBoundProvisionEmails(req.user!.userId)
    res.json({ items })
  } catch (err) {
    next(err)
  }
}
