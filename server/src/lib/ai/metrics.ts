import client from 'prom-client'
import { registry } from '../metrics.js'

// SPEC-AI-001 §14 — labels are closed enums only; never product/user ids or
// model output.

export const aiGenerationTotal = new client.Counter({
  name: 'monexus_ai_generation_total',
  help: 'AI generations by feature, final status and error code',
  labelNames: ['feature', 'status', 'error_code'] as const,
  registers: [registry],
})

export const aiGenerationDuration = new client.Histogram({
  name: 'monexus_ai_generation_duration_seconds',
  help: 'AI provider call duration by feature',
  labelNames: ['feature'] as const,
  buckets: [1, 2, 5, 10, 20, 30, 40, 50],
  registers: [registry],
})

export const aiTokensTotal = new client.Counter({
  name: 'monexus_ai_tokens_total',
  help: 'AI tokens consumed by feature and direction',
  labelNames: ['feature', 'direction'] as const,
  registers: [registry],
})

export const aiValidationRejectionsTotal = new client.Counter({
  name: 'monexus_ai_validation_rejections_total',
  help: 'Units or items rejected by deterministic AI validators, by issue kind',
  labelNames: ['feature', 'kind'] as const,
  registers: [registry],
})
