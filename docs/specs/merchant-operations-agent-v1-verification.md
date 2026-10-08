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

## A1：受控运行容器、只读工具与决策循环（2026-10-08）

按用户要求本阶段只做针对性验证，不跑后端全量、E2E 或真实模型。

### 实现

- `server/src/lib/ai/task.ts` `runAiTask`：一次 run 一行 AiGeneration、一次额度；固定配置快照与有效推理模式；整次 deadline、单次调用上限与收尾余量；客户端断开取消；usage 累计（任一步未知则为 null）；Agent 行写入 stepCount/toolCallCount/stopReason。`runAiGeneration` 改为它的单调用消费方，商品 Copilot/草稿助手行为不变。
- `server/src/modules/merchant/agent/`：
  - `schema.ts`：turn 请求（strict）与下一步决定的静态 JSON Schema（固定根对象 + 可空分支），服务端按 kind 取唯一分支。
  - `tools.ts`：`read_workbench`（urgent/availability/drafts，草稿每 run 最多两批）、`find_products`、`inspect_product`（与发布相同的 readiness + 封闭动作）、`read_item`、`read_product_content`（复用拆出的 `prepareContentSuggestionContext`）、`read_help`。模型只见不透明 ref（P*/I*/C*/A*）、档位与缺项代码；准确数值、名称与动作只在证据卡中返回商家。工具失败报告为 unavailable/not_found，不终止 run。
  - `runner.ts`：模型决定下一步；服务端校验引用与动作、执行工具；最多 4 次规划、3 次工具、单次调用输入 ≤40000 字符、累计 ≤120000 字符；重复调用 → `no_progress`；超出 → `limited`。`prepare_content` 仅在本 run 读取过该商品内容后可用，使用内容 Copilot 的 prompt/schema/validator 生成一次，只返回提案（10 分钟有效），不写入。
  - `service.ts` / `routes.ts`：`GET /api/merchant/agent/availability`、`POST /api/merchant/agent/turns`；选中资源先校验归属（外来/不存在统一 404，不占额度）；每一步与返回前重查账号状态、会话、商家状态与开关；`res.on('close')` 且未完成响应才取消。
- 内容 Copilot：`generateContentSuggestion` 拆出 `prepareContentSuggestionContext`，原端点行为不变。

### 实际执行

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit`（server，含测试） | 通过 |
| `runAiGeneration` 改造后回归：admin-ai-settings、product-content-copilot、product-draft-assistant、ai-merchant-agent-foundation | 4 个文件 / 61 个用例通过 |
| 新增 `src/__tests__/merchant-agent.test.ts` | 6 个用例通过 |
| `npm --prefix server run build` | 通过 |
| 最终定向回归：admin-ai-settings、product-content-copilot、product-draft-assistant、ai-merchant-agent-foundation、merchant-agent、`src/lib/ai`、`src/modules/catalog/contentCopilot`、`src/modules/merchant/workbench/workbench.test.ts`（可丢弃库 `monexus_test_merchant_agent`，`TZ=UTC`） | 12 个文件 / 218 个用例通过 |

新增用例：模型选工具后基于观察结果回答（动作由服务端证据解析；模型输入不含 ID 与准确数量；元数据步数/工具数/usage/stopReason）；伪造引用 → 502 且记 output_invalid；工具预算用尽与重复调用 → limited；外来选择 404、额度 0 → 429、Agent 关闭 → 404，均不调用模型、不占额度，availability 分别返回 quota/disabled；读取内容 → 生成提案不写库，文案步骤输入不含规划观察与交付密文；真实 HTTP 断开时 provider 收到中止、run 记 client_disconnected。

### 简化与未完成

- run 总输出 token（8000）未单独计数，由单次上限（规划 1200×4 + 文案 3000）约束。
- 用户自由输入的凭据/联系方式模式拦截、回答文本的无根据因果/承诺检查尚未实现（只校验引用与动作）；需在 A2/A3 前补齐或在 L3 中暴露。
- 工具级指标与 DB statement timeout 未加。
- A2（前端对话与提案审阅）、A3（真实模型 L3）未开始；MA01–MA12 未验收。

## A2：对话与文案审阅闭环（2026-10-08）

按用户要求只做针对性单测/组件测试，未新增 E2E、未做浏览器冒烟。

### 实现

- `src/api/merchant/agent.ts`：availability 与 turn 调用；仅 turn 请求 55 秒超时并支持取消，全局 15 秒不变。
- `src/stores/merchantAgent.ts`：只在内存的对话历史、选中对象与提案交接；同一时间一个请求；切换账号/登出清空并丢弃旧响应；取消提示仍计次数；404/429 分别更新为不可用/额度用完。提案交接只在内存，不写 URL、history state 或浏览器存储，只能对同一商品、同一会话、未过期时使用一次。
- `src/components/merchant/agent/`：`AgentPanel` 放在 `/merchant/workbench`（与规则列表并存，不可用时隐藏）；示例只填输入框，发送才发起计费调用；结果按服务端证据卡渲染（复用 `WorkbenchCard`、缺项标签与封闭导航），模型文字为纯文本；展示澄清候选、提案入口、实际执行的工具和覆盖不完整提示，limited 时标明未完成。
- 入口：工作台卡片“帮我处理”（只选中对象，不发请求）；首页摘要“问经营助手”。
- 编辑器：`ProductEditPage` 接收交接的提案，校验会话、商品、未过期、`contentVersion` 一致、可编辑且无未保存修改，否则提示失效；复用 `ProductContentSuggestionDialog`（新增 `preset` 模式：无生成控件、不另计额度、不上报采纳遥测），默认不勾选，“填入已选内容”只改表单，保存仍走原接口与 CAS。
- 后端小改：发布检查证据卡附带封闭动作，供前端逐项定位（模型观察仍只含代码与 actionRef）。

### 实际执行

| 检查 | 结果 |
| --- | --- |
| 新增 `src/stores/merchantAgent.test.ts`、`src/components/merchant/agent/AgentPanel.test.tsx`；`ProductEditPage.test.tsx` 新增交接用例 | 3 个文件 / 42 个用例通过（含原有编辑器用例） |
| `ProductContentSuggestionDialog` 原有测试 | 10 个用例通过 |
| 前端全量 `npx vitest run --maxWorkers=4` | 193 个文件 / 1635 个用例通过 |
| `npm run build` | 通过 |
| 后端 `tsc --noEmit` 与 `merchant-agent.test.ts` | 通过（6 个用例） |

### 未执行

- 390px/1280px 浏览器检查、键盘与焦点、真实前后端联调、新 E2E：未执行。
- 提案“保存后单项重查”只依赖原编辑器保存与发布检查，未加专门联动。
- A3（真实模型 L3）未开始；MA01–MA12 未验收。
