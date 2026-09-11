import { Router } from 'express'
import { validate, idParamSchema } from '../../../middlewares/validate.js'
import {
  approveAssuranceSchema,
  createAssuranceApplicationSchema,
  createAssuranceGrantSchema,
  listAdminAssuranceQuerySchema,
  rejectAssuranceSchema,
  revokeAssuranceGrantSchema,
} from './schema.js'
import * as service from './service.js'
import { getMyMerchant } from '../../merchant/service.js'

export const merchantAssuranceRouter = Router()

merchantAssuranceRouter.get(
  '/products/:id/assurance',
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const merchant = await getMyMerchant(req.user!.userId)
      res.json(await service.getMerchantAssurance(merchant.id, req.params.id as unknown as number))
    } catch (err) {
      next(err)
    }
  },
)

merchantAssuranceRouter.post(
  '/products/:id/assurance/applications',
  validate({ params: idParamSchema, body: createAssuranceApplicationSchema }),
  async (req, res, next) => {
    try {
      const merchant = await getMyMerchant(req.user!.userId)
      res.status(201).json(await service.applyForAssurance(merchant.id, req.params.id as unknown as number, req.body.reason))
    } catch (err) {
      next(err)
    }
  },
)

merchantAssuranceRouter.post(
  '/assurance-applications/:id/withdraw',
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      const merchant = await getMyMerchant(req.user!.userId)
      res.json(await service.withdrawAssuranceApplication(merchant.id, req.params.id as unknown as number))
    } catch (err) {
      next(err)
    }
  },
)

export const adminAssuranceRouter = Router()

adminAssuranceRouter.get(
  '/products/:id/assurance',
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      res.json(await service.getAdminProductAssurance(req.params.id as unknown as number))
    } catch (err) {
      next(err)
    }
  },
)

adminAssuranceRouter.get(
  '/assurance-applications',
  validate({ query: listAdminAssuranceQuerySchema }),
  async (req, res, next) => {
    try {
      res.json(await service.listAdminAssuranceApplications(req.query as { status?: string; page?: number; pageSize?: number }))
    } catch (err) {
      next(err)
    }
  },
)

adminAssuranceRouter.post(
  '/assurance-applications/:id/approve',
  validate({ params: idParamSchema, body: approveAssuranceSchema }),
  async (req, res, next) => {
    try {
      res.json(await service.approveAssuranceApplication(req.user!.userId, req.params.id as unknown as number, req.body))
    } catch (err) {
      next(err)
    }
  },
)

adminAssuranceRouter.post(
  '/assurance-applications/:id/reject',
  validate({ params: idParamSchema, body: rejectAssuranceSchema }),
  async (req, res, next) => {
    try {
      res.json(await service.rejectAssuranceApplication(req.user!.userId, req.params.id as unknown as number, req.body.reason))
    } catch (err) {
      next(err)
    }
  },
)

adminAssuranceRouter.post(
  '/products/:id/assurance/grants',
  validate({ params: idParamSchema, body: createAssuranceGrantSchema }),
  async (req, res, next) => {
    try {
      res.status(201).json(await service.grantProductAssurance(req.user!.userId, req.params.id as unknown as number, req.body))
    } catch (err) {
      next(err)
    }
  },
)

adminAssuranceRouter.post(
  '/assurance-grants/:id/revoke',
  validate({ params: idParamSchema, body: revokeAssuranceGrantSchema }),
  async (req, res, next) => {
    try {
      res.json(await service.revokeAssuranceGrant(req.user!.userId, req.params.id as unknown as number, req.body.reason))
    } catch (err) {
      next(err)
    }
  },
)
