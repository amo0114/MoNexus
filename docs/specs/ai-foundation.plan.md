# Plan：AI Foundation（SPEC-AI-001 v1.0.1）

配套 spec：`docs/specs/ai-foundation.md`。从 `develop` 拉 `feat/ai-foundation`，PR 目标 `develop`。本计划只拆任务与依赖，实施细节以 Spec 为准；Spec 与代码事实冲突时停止并回报，不自行改 Spec。

## 前置事实（实施者需知）

- 无任何现存 LLM 代码；新增代码放 `server/src/lib/ai/`（同 `lib/fakaBridge/`、`lib/mailer/` 子目录惯例）。
- Env 解析：`server/src/config/index.ts`（Zod schema + 解析后交叉校验 `console.error` + `process.exit(1)`，参照 `NOTIFICATION_EMAIL_ENABLED` 在第 668 行的写法）；新 env 同步 `.env.example`。
- SystemConfig 新键需同步**全部登记位置**：`systemConfigKeys`、默认值表、标签表、分组表、单位表、描述表、`RANGE_CONFIG_KEYS`（`lib/systemConfig.ts`，参照 `fulfillmentSlaDays` 在 32/103/153/201/249/295/401 行），以及前端 `src/api/adminConfig.ts`、`src/components/admin/adminConfigMeta.ts`、`server/src/modules/admin/README.md`。
- ErrorCode 是 `lib/httpError.ts` 中的封闭 union。
- Ajv 配置参照 `modules/catalog/templates/validate.ts`。
- Advisory lock 锁类常量参照 `orders/fileAccess.ts:70` / `leaderboard/service.ts:198`；新锁类常量须与现有常量不冲突（grep `LOCK_CLASS`）。
- HMAC 惯例：`orders/idempotency.ts:104`（`createHmac('sha256', config.jwtSecret)`）。
- 日界：`lib/businessTime.ts` 的 `businessDateString` / `businessDayStartUtc`。
- 指标：`lib/metrics.ts` 的 `registry`，前缀 `monexus_`。
- 测试替身注入惯例：`modules/catalog/externalCatalog.ts` 的 `catalogClientOverrides`。
- 运行时：依赖 `chore/node-22-runtime`（Node 22 / npm 10）先合入或作为本分支基底。
- OpenAI SDK：固定 `openai@7.28.0`；只允许 `lib/ai/openaiProvider.ts` import。安装后确认 `npm --prefix server ls openai` 为 7.28.0，且 `npm --prefix server run build` 通过。
- 迁移后：`npm --prefix server run db:generate`；测试库 `DATABASE_URL=$TEST_DATABASE_URL npm --prefix server run db:migrate:deploy`。
- 后端测试命令见 `CLAUDE.md`（`TEST_DATABASE_URL` + `REDIS_ENABLED=false` + `API_RATE_LIMIT_MAX=3000`，只跑目标文件）。

## 依赖图

```
F1(config) ─┬─► F4a(provider 接口+替身) ─► F4b(OpenAI adapter)
            │                            │
F2(errors) ─┤                            ├─► F6(runAiGeneration) ─► F8(集成测试基座)
F3(migration)───────────────────────────┤
F5(metrics) ────────────────────────────┤
F7(SystemConfig 配额键) ─────────────────┘
F9(AiSafe + projection 测试工具)  （独立，可最先做）
F10(eval 脚本基座)  依赖 F4a；真实运行依赖 F4b 与 OPENAI_API_KEY
F11(文档)  最后
```

SPEC-AI-PRODUCT-001 计划的 P1–P4 只依赖 F9；P5 起依赖 F6。

## 任务分解

D-AI-01 已于 SPEC-AI-001 v1.0.0 §6.3 冻结，无前置决策任务。

### F1 配置（`config/index.ts`、`.env.example`）

- 新增 `AI_ENABLED`、`AI_PRODUCT_COPILOT_ENABLED`、`OPENAI_API_KEY`、`AI_TIMEOUT_MS`（Spec §15）；**不**新增 `AI_PROVIDER` / `AI_MODEL`。
- 交叉校验：copilot=true 需 `AI_ENABLED=true`；`AI_ENABLED=true` 需 `OPENAI_API_KEY` 非空。
- `.env.example` 中 `OPENAI_API_KEY` 留空。
- 单测：默认值、范围、交叉校验失败退出。

### F2 ErrorCode（`lib/httpError.ts`）

- 加入 `AI_QUOTA_EXCEEDED`、`AI_GENERATION_IN_PROGRESS`、`AI_TIMEOUT`、`AI_PROVIDER_ERROR`、`AI_OUTPUT_INVALID`、`AI_PRODUCT_TEMPLATE_REQUIRED`。
- 核对 `middlewares/errorHandler.ts` 对 502/504 的透传；核对前端 `src/api/client.ts` 拦截器不会对这些状态码自动重放（只读核对，如有问题在 Copilot 前端任务中处理）。

### F3 迁移：`AiGeneration`

- Prisma model 原样按 Spec §10.1；迁移中加入 `feature` / `actorRole` / `targetType` / `status` 的 CHECK。
- 断言：表中不存在任何 text/json 内容列（除 `issueCounts`）。

### F4a Provider 接口与测试替身（`lib/ai/provider.ts`）

- 接口、`LlmError`、模块级 override（`setLlmProviderForTests` 或同等命名）。
- 测试替身支持：返回固定输出、延迟、抛指定 `LlmError`、记录是否被调用。
- 单测：`LlmError.message` 只为错误码。

### F4b OpenAI adapter（`lib/ai/openaiProvider.ts`）

- 安装 `openai@7.28.0`（精确版本）。
- 按 Spec §6.3 冻结的请求形态：Responses API、`text.format` `json_schema` `strict: true`、`reasoning.effort: 'none'`、`store: false`、无 `tools`、无 `background`、`max_output_tokens`；客户端 `apiKey` 取自 `config`（显式传入）、`maxRetries: 0`；`signal` 中止。
- 读取结构化输出文本 → `JSON.parse`；`refusal` / `incomplete` / 超时 / 429 / 5xx / 4xx → `LlmErrorCode` 映射；`LlmError.message` 只为错误码。
- 测试：Spec §17 第 7、8 条（mock SDK / HTTP，断言请求参数与错误映射；断言仅此文件 import `openai`）；不在 CI 调用真实 OpenAI。

### F5 指标（`lib/metrics.ts` 或 `lib/ai/metrics.ts`）

Spec §14 四个指标；标签有限枚举。

### F6 运行时包装 `runAiGeneration`（`lib/ai/generation.ts`）

- 按 Spec §11.1 七步实现；advisory lock 短事务；in-flight 窗口 = `AI_TIMEOUT_MS + 5s`。
- `inputHash`：Spec §10.2 AI-R21——`HMAC-SHA256(config.jwtSecret, "monexus:ai-input-hash:v1\0" + canonicalJson(input))`；单测断言前缀存在（同一输入与无前缀 HMAC 结果不同）与键序无关性。
- 配额读取 `getSystemConfigValue`，按 `actor.role` 选键（键名由调用 feature 传入或按 feature 映射，保持简单）。
- 单测（替身）：成功、parse 失败、超时、provider 错误的行状态与 HttpError 映射。

### F7 SystemConfig 配额键

- `aiProductCopilotDailyQuotaAdmin`、`aiProductCopilotDailyQuotaMerchant`：默认 0、范围 0..1000，同步前置事实中列出的所有位置。
- 前端后台配置页能显示与修改（复用现有通用配置 UI，不做专属页面）。

### F8 集成测试基座

- `server/src/__tests__/` 下新增 AI 运行时集成测试：配额并发（N 个并发请求，行数 ≤ 配额）、上海日界（钉时间）、in-flight 409、崩溃遗留 pending 超窗后不阻塞、元数据行不含哨兵。

### F9 AiSafe 品牌与 Projection 测试工具（`lib/ai/safe.ts` + 测试 helper）

- `AiSafe<T>`、`markAiSafe`。
- 可复用测试 helper：`assertNoSentinel(context, sentinels)`、`collectKeyPaths(context)`（白名单快照）、`assertUnknownPreserved`。
- 评审规则写入 `lib/ai/README.md`：`markAiSafe` 仅允许在 projection 文件调用。

### F10 Eval 脚本基座（`server/src/scripts/`）

- 通用 runner：加载 fixtures、调用 feature 的生成函数（绕过 HTTP 与配额，但仍走 Projection 与校验器）、输出 JSON + Markdown 报告到 gitignored 目录（在 `.gitignore` 增加条目）。
- `server/package.json` 增加 npm script（由 Copilot 计划 P8 注册具体命令）。

### F11 文档

- `server/src/lib/ai/README.md`：红线、Projection 规则、如何新增 feature（必须先有 Spec）。
- `docs/testing-policy.md` 增补 AI 分层（L1/L2/L2.5 进 CI，L3 手动）——一小节，不改其他条款。

## 验证

- `npm --prefix server run build`（type-check）。
- 目标后端测试文件（F1/F4a/F6/F8/F9 相关）。
- 前端：`npm test` 中 adminConfig 相关单测（F7）。
- `AI_ENABLED=false` 下跑 `npm run verify:quick`，确认无行为变化。

## 完成定义

Spec §17 全部八条有对应测试且通过。真实调用只在 L3 eval（手动）中发生；上线前检查见 Spec §6.3「上线检查」。
