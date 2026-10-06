# 测试策略与分层规范（Testing Policy）

> 自 2026-08-12 起生效。目标：CI 立刻提速、测试规模不再随功能数线性膨胀、质量门槛不下降。
> CI 的事件矩阵与分支模型见 [`branching-and-ci.md`](./branching-and-ci.md)；本文回答"什么改动配什么测试"。

## 1. 分层与职责

| 层 | 位置 / 工具 | 职责 | 门禁 |
|---|---|---|---|
| 前端单元/组件测试 | 根目录 `npm test`（Vitest，`src/**/*.test.ts(x)`） | 纯逻辑与组件行为：协议解析、状态归并、展示计算等 | CI frontend job（秒级） |
| 前端浏览器回归 | `npm run e2e:mobile-island`（Playwright，API 测试桩） | 移动布局、焦点、导航动效及无障碍等真实浏览器行为 | CI frontend job；三个 spec 仅在专用套件运行 |
| 后端集成测试 | `server` 下 `npm test`（Vitest + 真实 PostgreSQL） | 路由、事务、并发、鉴权、数据约束 | CI backend job（6 shard 并行，片内串行） |
| E2E | `npm run e2e`（Playwright） | **跨端关键旅程**的端到端行为 | push→develop / PR→master / 满足条件的 PR；主套件在 CI 分 2 shard，片内单 worker |

原则：能在下层复现的行为不上升到上层。E2E 是最贵的一层，只保留下层无法表达的价值。

## 2. E2E 准入标准

新增一个 e2e spec（或往既有 spec 增加场景）必须满足以下**至少一条**，否则下沉：

1. 引入了**新的跨端用户旅程**（新的前后端契约 + 页面流程，如新的结账方式）。
2. 触及 §3 关键旅程清单。
3. 行为只能在真实浏览器中复现（SSE 生命周期、存储、路由跳转、Cookie 语义等）。

不满足时的归宿：后端行为 → server 集成测试；前端行为 → 根目录单元/组件测试。

**每个新功能的默认测试组合**：后端集成测试 + 前端单元测试，外加**至多 1 条** happy-path e2e 冒烟（仅当满足准入标准）。逐条 AC 挂 browser E2E 证据的做法停止使用，见 §4。

## 3. 关键旅程清单

以下旅程的回归必须有 E2E 覆盖；清单本身的增删需在 PR 中说明理由并评审：

- 认证与会话：注册、登录、MFA、刷新、登出
- 下单支付与结算链路
- 交付：即时/结构化/文件交付
- 管理端高危操作：全局配置、库存导入、封禁类操作
- 法务合规页（enforce 模式）
- 实时通知链路（SSE）

## 4. 验收清单（checklist）证据规则

- AC 证据**默认引用单元/集成测试**（测试文件名 + 断言点）。
- 仅关键旅程相关的 AC 要求 browser E2E 证据。
- 禁止为纯 UI 断言（文案、样式、开关显隐）新增 e2e 场景——下沉到组件测试。
- spec/plan 模板按本规则编写；评审时对照本文档，而不是临场裁量。

## 5. `run-e2e` 标签触发条件（PR → develop）

默认**不打**标签，依赖 push→develop 的全量集成门（这是 PR 级 e2e 可省的前提）。
以下情形**必须**打标签，在 PR 合并前跑全量 e2e：

1. 改动触及 §3 关键旅程对应的代码路径。
2. 改动鉴权、session、中间件、限流等横切面。
3. 运行时依赖的大版本升级（prisma / express / react / vite 等）。
4. release PR 之前的最后一个功能 PR（建议，非强制）。

注：`.github/workflows/ci.yml` 与 playwright 配置的变更已在路径过滤器内**自动**触发 e2e，无需标签。

## 6. 存量 E2E 治理（渐进，不做一次性重写）

当前 37 个 spec 按功能命名，存量按以下规则收敛：

- 新 PR 不得往既有 spec 添加不满足 §2 的场景。
- 改动某 spec 时顺手评估：纯 UI 断言下沉、与其他 spec 重叠的场景合并。
- 目标形态：E2E 收敛为 §3 关键旅程集合 + 少量功能冒烟，总时长不随功能数线性增长。

## 6.5 AI 功能分层（SPEC-AI-001 §13）

- L1/L2（进 CI）：Projection（哨兵泄露、键白名单、未知保持、截断）、Validator、归一化器单测；路由权限、flag、配额、超时与元数据走 `server` 集成测试，LLM 一律使用 `setLlmProviderForTests` 测试替身。
- L2.5（进 CI）：`contentCopilot/__fixtures__` 中的录制 / 对抗输出回放给 Validator。
- L3（手动，不进 CI）：`npm --prefix server run ai:eval:product-copilot` 调用真实模型；promptVersion、validatorVersion 或模型变更时必跑，报告写入被忽略的 `server/.ai-eval/`。
- AI 功能 V1 不新增 E2E：真实 provider 无法进 CI，保存 / 发布路径已有覆盖。

## 7. 本地验证

- 小改动：`npm run verify:quick`（只跑受 git 变更影响的测试；
  `npm run verify:quick -- e2e/xxx.spec.ts` 追加指定 e2e spec）。
- 全量（与 CI 等价）：`npm run verify:local`，或 `verify:local:no-e2e`。
- `verify:local` 包含独立移动浏览器套件；`verify:quick -- e2e/mobile-chrome.spec.ts` 等移动 spec 会路由至专用配置，不为这些 spec 重置数据库。也可单独运行 `npm run verify:mobile-island`。
- 日常无需本地全量：push→develop 集成门会跑全套，develop 上红了再修即可。

## 8. 后端公共开销计时

CI backend job 设置 `TEST_PROFILE_COMMON_SETUP=1`；本地可在原有测试数据库配置上加同名变量。每个测试文件结束后输出一条 `BACKEND_TEST_PROFILE` JSON，包含相对文件路径、执行测试数，以及公共操作的次数、总耗时、P50、P95 和最大耗时（毫秒）。
若本地 reporter 隐藏通过文件的输出，可加 `--reporter=verbose` 查看记录。

- `reset.*`：缓存重置、67 张表的 `TRUNCATE`、存储运行配置复位。
- `fixture.*`：`createTestUser` 的密码哈希、用户写入、分类准备、积分账户及初始积分日志写入。
- `database.*`：测试文件的连接和断开。

计时保持原有清理和造数顺序；未设置变量时不输出报告。报告不包含夹具参数或凭据。不同 shard、并发夹具操作的耗时可能重叠，不能把累计耗时直接当作流水线可节省的墙钟时间；需结合 job/step 时间戳及文件测试耗时判断。
