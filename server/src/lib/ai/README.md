# lib/ai — AI runtime (SPEC-AI-001)

Contract: `docs/specs/ai-foundation.md`. First consumer: `modules/catalog/contentCopilot` (SPEC-AI-PRODUCT-001).

`modules/catalog/draftAssistant` (SPEC-AI-PRODUCT-002) adds creation-time extraction under the same product Copilot flag/quota. It uses its own projection and validator; `product_draft` targets identify the actor's pending form, never a placeholder business row.

## Red lines

- AI never writes business tables. The only write is `AiGeneration` metadata (no prompt / input / output columns, ever).
- Prices, inventory, points, checkout versions, order state, settlement, RBAC/MFA/ownership and organic ranking are never decided by AI (SPEC-AI-001 §3.2).
- No retries, model switching, fallback chains or model routers. A failed call is a failed call; manual paths keep working.

## Adding an AI feature

1. Write its spec first (projection, output schema, validator, permissions, flag).
2. Build model input only through a projection file that calls `markAiSafe` on an explicitly constructed allowlist — never Prisma entities, API DTOs or `JSON.stringify(entity)`. `markAiSafe` may only be called from projection files.
3. Projection tests must use `src/__tests__/aiProjection.ts`: sentinel leak, key-path allowlist, unknown preserved, truncation, and an integration test proving 404 before any provider call.
4. Call the model only through `runAiGeneration` (flags, per-role daily quota from SystemConfig, in-flight dedupe, timeout, metadata, metrics).
5. Bind model and call parameters to a `promptVersion` constant; changing either requires a new version and an L3 eval run.

## Files

| File | Role |
| --- | --- |
| `safe.ts` | `AiSafe<T>` brand |
| `provider.ts` | `LlmProvider` interface, `LlmError`, test override |
| `openaiProvider.ts` | the only file allowed to import the `openai` SDK |
| `generation.ts` | `runAiGeneration`, quota, `AiGeneration` lifecycle, applied telemetry |
| `metrics.ts` | `monexus_ai_*` Prometheus metrics |
