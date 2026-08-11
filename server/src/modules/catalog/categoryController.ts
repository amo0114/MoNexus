// T-CAT-BE-001 — Admin category API controller (SPEC-CATALOG-OPS-001 §7.2).
// Thin Express adapter over categoryService; all routes are mounted behind the
// existing /api/admin auth → active → admin → MFA chain (see adminRoutes).

import { Request, Response, NextFunction } from 'express'
import * as categoryService from './categoryService.js'
import type { CreateCategoryInput, ListCategoriesQuery, ReorderCategoriesInput, UpdateCategoryInput } from './categorySchema.js'

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await categoryService.listAdminCategories(req.query as unknown as ListCategoriesQuery))
  } catch (err) {
    next(err)
  }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await categoryService.createCategory(req.user!.userId, req.body as CreateCategoryInput))
  } catch (err) {
    next(err)
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await categoryService.updateCategory(req.user!.userId, id, req.body as UpdateCategoryInput))
  } catch (err) {
    next(err)
  }
}

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await categoryService.activateCategory(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function deactivate(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await categoryService.deactivateCategory(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}

export async function reorder(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ReorderCategoriesInput
    res.json(await categoryService.reorderCategories(req.user!.userId, body.orderedIds))
  } catch (err) {
    next(err)
  }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as unknown as number
    res.json(await categoryService.deleteCategory(req.user!.userId, id))
  } catch (err) {
    next(err)
  }
}
