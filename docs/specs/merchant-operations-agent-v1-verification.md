# 商家经营 Agent V1 验证记录

依据：[SPEC-MERCHANT-AGENT-001](./merchant-operations-agent-v1.md)、[实施计划](./merchant-operations-agent-v1.plan.md)。本记录按阶段追加，只写实际执行过的检查；未执行项明确标注。当前只完成 A0，**Agent 尚不可用**，MA01–MA12 均未验收。

## A0：依赖基线核验与共享 AI 运行时调整（2026-10-08）

### 基线

- 分支 `feat/merchant-operations-agent`，起点 `origin/develop` `d5bd6c1`（依赖 #240 工作台 V1、#241 Node 22、#242 AI 基础与商品 Copilot 均已合入，develop push CI 通过）。
- 运行时 Node 22.23.1 / npm 10.9.8；`npm run check:runtime` 通过。
- 数据库：仅本人新建的可丢弃库 `monexus_test_merchant_agent`；另临时建库 `monexus_test_merchant_agent_fresh` 做全量迁移重放，验证后已删除。未使用开发库、预览库或其他会话的测试库。
- 编辑器与发布检查接缝：develop 上 `ProductEditPage` 同时保留工作台 focus 定位与 AI 差异采纳；`publicationReadiness` 共享评估由下列回归覆盖。
- **改动前基线**（同一组文件）：17 个文件 / 278 个用例通过。

### 实现

- 迁移 `20261008120000_ai_merchant_agent_foundation`：`AiRuntimeConfig` 增加 `merchantAgentEnabled`（默认 false，CHECK 要求 AI 总开关开启）、`merchantAgentReasoningMode`（默认 `default`，none/default）；`AiGeneration` 放行 `merchant_operations_agent`/`merchant_agent`，二者必须成对且 actorRole 为 merchant，新增 `stepCount`/`toolCallCount`/`stopReason`，并约束 Agent 行（accepted 为空、suggested ≤6、issueCounts 恰为四个非负整数、stopReason 为小写码）与非 Agent 行（三列为空）。
- 运行时：注册 `merchant_operations_agent`；额度映射按 feature 声明支持角色，不支持角色读取额度前 403；Agent 开启需 AI 总开关、Agent 开关、可解密 Key 与 `MERCHANT_WORKBENCH_ENABLED`；有效推理模式按 feature 在构造 provider 时确定（Copilot 用全局、Agent 用自身），provider name 记录实际模式；新增 run 初始输入 HMAC（独立用途域）。
- 后台：`GET/PUT /api/admin/ai/config` 增加 Agent 开关与推理模式（省略=保留，关闭 AI 或清除 Key 时一并关闭），只读返回工作台环境开关；审计只记标志。系统配置新增 `aiMerchantAgentDailyQuotaMerchant`（默认 0，0..1000）。后台 AI 设置页增加对应控件与依赖说明。
- 规范：SPEC-AI-001 升至 1.3.0；本 Spec §4.2 与计划 A0 第 7 项按实际实现方式修订。

### 实际执行

| 检查 | 结果 |
| --- | --- |
| `npx prisma migrate deploy`（已有 develop schema 的库升级） | 通过 |
| 新建空库全量 `migrate deploy` + `prisma migrate diff --from-url <空库> --to-schema-datamodel prisma/schema.prisma --exit-code` | 通过，无差异 |
| `npm --prefix server run build`（含测试源码 tsc 与 postbuild 检查） | 通过 |
| `npm run build` | 通过 |
| 前端全量 `npx vitest run --maxWorkers=4` | 191 个文件 / 1626 个用例通过（含新增 2 个面板用例） |
| 后端：基线同组 17 个文件 + 新增 `src/__tests__/ai-merchant-agent-foundation.test.ts`，`TZ=UTC`，可丢弃库 | 18 个文件 / 300 个用例通过（278 原有 + 22 新增） |

后端命令（server 目录，`$AGENT_DB` 为可丢弃库连接串）：

```bash
TZ=UTC TEST_DATABASE_URL="$AGENT_DB" REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npx vitest run \
  src/__tests__/admin-ai-settings.test.ts src/__tests__/config-ai-guards.test.ts \
  src/__tests__/product-content-copilot.test.ts src/__tests__/product-draft-assistant.test.ts \
  src/lib/ai src/modules/admin/admin-query.test.ts src/modules/catalog/contentCopilot \
  src/modules/catalog/draftAssistant src/modules/catalog/publicationReadiness.test.ts \
  src/modules/catalog/publicationReadiness.v2.test.ts src/modules/catalog/publicationRoutes.test.ts \
  src/modules/merchant/workbench/workbench.test.ts src/scripts/evalProductCopilot.test.ts \
  src/__tests__/ai-merchant-agent-foundation.test.ts
```

新增后端用例覆盖：后台 Agent 开关保存/保留/随 AI 关闭/清 Key 关闭/非法模式 400 与审计无密钥；四条件开启判定（含工作台环境开关）；按角色额度与不支持角色 403、额度上限 1000；有效推理模式选择，以及商品 Copilot 实际以全局模式构造 provider；数据库拒绝 11 类非法 Agent 行、非 Agent 行带计数列、Copilot 使用 Agent target；运行配置 Agent 开关受总开关约束；run 输入 HMAC 的格式、键序稳定与用途域隔离。

### 未执行

- 后端全量套件、E2E、CI：未运行（A0 只本地提交，按授权不推送）。
- 真实模型调用：无（A0 不涉及模型调用）。
- A1–A3、MA01–MA12：未开始。
