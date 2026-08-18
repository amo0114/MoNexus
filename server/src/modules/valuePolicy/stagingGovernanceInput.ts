import { z } from 'zod'

export const STAGING_D02_RECORD_REF = 'controlled-archive://value-policy-decisions/20260818-owner-directive/d02-100pts-per-cny-v1.json'
export const STAGING_D02_RECORD_SHA256 = '02a0d6642fec6cf542805d20970eb9d489dae8180775bc719349d1153867a998'
export const STAGING_D03_RECORD_REF = 'controlled-archive://value-policy-decisions/20260818-owner-directive/d03-disclosure-zh-cn-v1.json'
export const STAGING_D03_RECORD_SHA256 = '72c148a645f9aaff6deb656757d6637e5688c1a987a76830badf6786464a2971'
export const STAGING_DISCLOSURE_VERSION = 'zh-CN-v1'
export const STAGING_GOVERNANCE_CONFIRMATION = 'RUN_VALUE_POLICY_STAGING_GOVERNANCE'

const actorSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(16).max(128),
  totpSecret: z.string().regex(/^[A-Z2-7]{32}$/),
}).strict()

const policyIdSchema = z.string().min(3).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const stagingGovernanceInputSchema = z.object({
  confirmation: z.literal(STAGING_GOVERNANCE_CONFIRMATION),
  operation: z.enum(['schedule', 'activate']),
  maker: actorSchema,
  checker: actorSchema,
  policy: z.object({
    id: policyIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    effectiveAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.maker.email === value.checker.email) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checker', 'email'],
      message: 'maker and checker must use different accounts',
    })
  }
  if (value.maker.totpSecret === value.checker.totpSecret) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checker', 'totpSecret'],
      message: 'maker and checker must use different MFA factors',
    })
  }
})

export type StagingGovernanceInput = z.infer<typeof stagingGovernanceInputSchema>

export function parseStagingGovernanceInput(value: unknown): StagingGovernanceInput {
  return stagingGovernanceInputSchema.parse(value)
}

export function assertStagingGovernanceEnvironment(input: {
  nodeEnv: string | undefined
  deployEnv: string | undefined
  databaseUrl: string | undefined
}): void {
  if (input.nodeEnv !== 'production' || input.deployEnv !== 'staging') {
    throw new Error('ValuePolicy staging governance requires the production runtime in the staging deploy environment')
  }
  if (!input.databaseUrl) throw new Error('ValuePolicy staging governance database is not configured')

  let databaseName: string
  try {
    databaseName = new URL(input.databaseUrl).pathname.replace(/^\/+/, '')
  } catch {
    throw new Error('ValuePolicy staging governance database URL is invalid')
  }
  if (databaseName !== 'monexus_staging') {
    throw new Error('ValuePolicy staging governance refuses a non-staging database')
  }
}
