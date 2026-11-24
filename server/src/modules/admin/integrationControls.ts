import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import type { IntegrationConfig, Prisma } from '@prisma/client'
import { conflict } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

export const integrationVersion = z.number().int().min(0).max(2147483646)

export function requireIntegrationVersion(row: IntegrationConfig | null, expected: number) {
  if ((row?.version ?? 0) !== expected) throw conflict('配置已被更新，请重新加载后操作')
}

export function withIntegrationLock<T>(
  service: string,
  work: (tx: Prisma.TransactionClient, row: IntegrationConfig | null) => Promise<T>,
) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`monexus:integration:${service}`}))`
    return work(tx, await tx.integrationConfig.findUnique({ where: { key: service } }))
  })
}

export const integrationProbeLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, keyGenerator: req => String(req.user!.userId), standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: '探测次数过多，请稍后重试' } }),
})
