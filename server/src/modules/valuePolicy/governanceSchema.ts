import { z } from 'zod'
import { HttpError } from '../../lib/httpError.js'

const safeText = (label: string, min: number, max: number) => z.string().trim()
  .min(min, `${label}长度不足`)
  .max(max, `${label}过长`)
  .regex(/^[^\u0000-\u001f\u007f]*$/, `${label}不能包含控制字符`)

const recordRef = safeText('决策记录引用', 1, 200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, '决策记录引用格式无效')
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, '必须是小写 SHA-256')
const positiveAtomic = z.string().regex(/^[1-9][0-9]{0,38}$/, '必须是正十进制整数字符串')

export const valuePolicyIdParamSchema = z.object({
  id: z.string().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
}).strict()

export const createValuePolicyGovernanceSchema = z.object({
  id: valuePolicyIdParamSchema.shape.id,
  version: z.number().int().positive(),
  referenceAtomicPerPointNumerator: positiveAtomic,
  referenceAtomicPerPointDenominator: positiveAtomic,
  effectiveAt: z.string().datetime({ offset: true }),
  d02DecisionRecordRef: recordRef,
  d02DecisionRecordSha256: sha256,
  d03DecisionRecordRef: recordRef,
  d03DecisionRecordSha256: sha256,
  disclosureVersion: safeText('披露版本', 1, 100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, '披露版本格式无效'),
  reason: safeText('操作理由', 8, 500),
}).strict()

export const transitionValuePolicyGovernanceSchema = z.object({
  reason: safeText('操作理由', 8, 500),
}).strict()

export type CreateValuePolicyGovernanceInput = z.infer<typeof createValuePolicyGovernanceSchema>
export type TransitionValuePolicyGovernanceInput = z.infer<typeof transitionValuePolicyGovernanceSchema>

export const VALUE_POLICY_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export function validateValuePolicyIdempotencyKey(raw: string | undefined): string {
  if (raw == null || raw.replace(/^[ \t]+|[ \t]+$/g, '').length === 0) {
    throw new HttpError(400, 'VALUE_POLICY_IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key 请求头')
  }
  const key = raw.replace(/^[ \t]+|[ \t]+$/g, '')
  if (!VALUE_POLICY_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new HttpError(400, 'VALUE_POLICY_IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 格式无效')
  }
  return key
}
