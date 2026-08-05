import { Request, Response, NextFunction } from 'express'
import { config } from '../../config/index.js'
import { notFound } from '../../lib/httpError.js'
import { listLegalDocumentSummaries, resolveLegalDocument } from './registry.js'

// 文档内容随部署版本固定：短缓存即可，版本参数请求天然免疫过期。
const CACHE_CONTROL = 'public, max-age=300'

export async function listDocuments(_req: Request, res: Response, next: NextFunction) {
  try {
    if (!config.legalPages.enabled) throw notFound('页面不存在')
    res.set('Cache-Control', CACHE_CONTROL)
    res.json({ documents: listLegalDocumentSummaries() })
  } catch (err) {
    next(err)
  }
}

export async function getDocument(req: Request, res: Response, next: NextFunction) {
  try {
    if (!config.legalPages.enabled) throw notFound('页面不存在')
    const version = typeof req.query.version === 'string' && req.query.version.trim() !== ''
      ? req.query.version.trim()
      : undefined
    // slug/version 未知统一 404（不区分"文档不存在"与"版本不存在"，防枚举）。
    const doc = resolveLegalDocument(String(req.params.slug), version)
    if (!doc) throw notFound('文档不存在')
    res.set('Cache-Control', CACHE_CONTROL)
    res.json(doc)
  } catch (err) {
    next(err)
  }
}
