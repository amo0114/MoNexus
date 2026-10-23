import client from 'prom-client'
import { registry } from '../../lib/metrics.js'
import { prisma } from '../../lib/prisma.js'

// Scrape from durable state: a stopped worker must not leave a healthy-looking zero.
export const videoQueue = new client.Gauge({
  name: 'monexus_product_video_assets',
  help: 'Video assets by processing state',
  labelNames: ['status'] as const,
  registers: [registry],
  async collect() {
    const groups = await prisma.productVideoAsset.groupBy({
      by: ['status'], where: { status: { in: ['queued', 'processing', 'failed'] } }, _count: true,
    })
    for (const status of ['queued', 'processing', 'failed']) {
      this.set({ status }, groups.find(row => row.status === status)?._count ?? 0)
    }
  },
})

export const videoQueueAge = new client.Gauge({
  name: 'monexus_product_video_oldest_queued_seconds',
  help: 'Age of the oldest queued video, including retry wait',
  registers: [registry],
  async collect() {
    const oldest = await prisma.productVideoAsset.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    this.set(oldest ? Math.max(0, (Date.now() - oldest.createdAt.getTime()) / 1000) : 0)
  },
})

export const videoExpiredProcessing = new client.Gauge({
  name: 'monexus_product_video_expired_processing',
  help: 'Processing jobs whose claim has expired and needs recovery',
  registers: [registry],
  async collect() {
    this.set(await prisma.productVideoAsset.count({ where: { status: 'processing', processingUntil: { lt: new Date() } } }))
  },
})

export const videoProcessingDuration = new client.Histogram({
  name: 'monexus_product_video_processing_seconds',
  help: 'Video processing attempt duration including storage IO',
  labelNames: ['outcome'] as const,
  buckets: [5, 15, 30, 60, 120, 300, 540],
  registers: [registry],
})
