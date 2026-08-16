import { Router } from 'express'
import { authenticate, requireActiveUser, requireAdmin, requireAdminMfa } from '../../../middlewares/auth.js'
import { validate, idParamSchema } from '../../../middlewares/validate.js'
import { createEditorialSchema, listEditorialQuerySchema, publicEditorialQuerySchema, revokeEditorialSchema, updateEditorialSchema } from './schema.js'
import { createEditorialFeature, listEditorialFeatures, revokeEditorialFeature, updateEditorialFeature } from './service.js'
import { listEditorialShelf } from './publicShelf.js'

export const adminEditorialRouter = Router()
adminEditorialRouter.use(authenticate, requireActiveUser, requireAdmin, requireAdminMfa)
adminEditorialRouter.get('/editorial-features', validate({ query: listEditorialQuerySchema }), async (req, res, next) => { try { res.json(await listEditorialFeatures(req.query)) } catch (e) { next(e) } })
adminEditorialRouter.post('/editorial-features', validate(createEditorialSchema), async (req, res, next) => { try { res.status(201).json(await createEditorialFeature(req.user!.userId, req.body)) } catch (e) { next(e) } })
adminEditorialRouter.patch('/editorial-features/:id', validate({ params: idParamSchema, body: updateEditorialSchema }), async (req, res, next) => { try { res.json(await updateEditorialFeature(req.user!.userId, req.params.id as unknown as number, req.body)) } catch (e) { next(e) } })
adminEditorialRouter.post('/editorial-features/:id/revoke', validate({ params: idParamSchema, body: revokeEditorialSchema }), async (req, res, next) => { try { res.json(await revokeEditorialFeature(req.user!.userId, req.params.id as unknown as number, req.body.reason)) } catch (e) { next(e) } })

export const publicEditorialRouter = Router()
publicEditorialRouter.get('/editorial', validate({ query: publicEditorialQuerySchema }), async (req, res, next) => { try { res.json({ items: await listEditorialShelf(req.query) }) } catch (e) { next(e) } })
