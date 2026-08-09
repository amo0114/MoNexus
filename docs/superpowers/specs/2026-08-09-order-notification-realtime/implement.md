# Implement Protocol: 订单通知实时化

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — no Implement card In Progress** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) · [checklist.md](./checklist.md) |
| 方法依据 | [Spec Coding：Specify → Plan → Tasks → Implement](https://javaguide.cn/ai-coding/practices/spec-coding.html) |

---

## 1. 入口门槛

实施 Agent 必须逐项现场验证；文档里已有路径不等于门槛自动通过。

- [x] IMPL-ENTRY-001：Owner 已于 2026-08-09 批准 O-RT-01~08，六份文档状态均为 Frozen for Implementation。
- [x] IMPL-ENTRY-002：已完整阅读 README、spec、plan、task、implement、checklist。
- [x] IMPL-ENTRY-003：独立 worktree 为 `/root/projects/worktrees/monexus-order-notification-realtime`。
- [x] IMPL-ENTRY-004：分支为 `feat/order-notification-realtime`，目标 PR 为 `develop`。
- [x] IMPL-ENTRY-005：已 fetch / 对比最新 `origin/develop` 并记录实现基线；无未处理 delta。
- [x] IMPL-ENTRY-006：当前任务卡的 Owned、Must Not Touch、依赖、DoD 和验证已复制到活动实施卡（I-RT-001 卡见 §6；后续每卡开工前复制）。
- [x] IMPL-ENTRY-007：专用 DB `monexus_test_notification_realtime` 已建（127.0.0.1:5432）；端口 3112 / 3113 / 5182 空闲，未与其他 worktree 共用。
- [x] IMPL-ENTRY-008：不需要生产密钥、生产数据库、真实订单或他人工作树。
- [x] IMPL-ENTRY-009：确认本波零 Prisma migration；若实现看似需要 migration，停止并 Ask First。
- [x] IMPL-ENTRY-010：确认只允许 `pg` / `@types/pg` 两个预批准新依赖；其他依赖先 Ask First。

任一门槛失败：不得编码。记录阻断项并交回 Owner，不得用“先做起来再补规格”绕过。

---

## 2. Git 与 Worktree 隔离

| 资源 | 契约 |
| --- | --- |
| 可写 worktree | `/root/projects/worktrees/monexus-order-notification-realtime` |
| 当前 WIP 主树 | `/root/projects/MoNexus-new` 只读，不编辑、不切分支、不清理 |
| 分支 | `feat/order-notification-realtime` |
| 审查基线 | Draft 为 `develop@da38dd0580eeac737f5291556b9dbdf832d91970`；实施前记录更新后的 SHA |
| PR 目标 | `develop` |
| 禁止 | force push、reset --hard、checkout 丢弃、clean -fd、修改他人 worktree、覆盖用户未提交改动 |

### 2.1 实施前 Git 记录

在 implement evidence ledger 记录：

~~~text
worktree: /root/projects/worktrees/monexus-order-notification-realtime
branch: feat/order-notification-realtime
HEAD: 22ae95c8fa92411679f2452956053d25393beb64 (frozen SPEC-NOTIFY-RT-001 v0.2.0, NOT amended)
origin/develop: da38dd0580eeac737f5291556b9dbdf832d91970
merge-base: da38dd0580eeac737f5291556b9dbdf832d91970
git status --short: (clean at freeze; subsequent I-RT-001 edits are the first new commits)
active task: I-RT-001 (T-DOC-001)
agent: pi (goal 033abe57-83b2-46cd-9131-afce2ebe0ef4)
timestamp: 2026-08-09
~~~

**Delta audit (I-RT-001) — 最新 develop vs 冻结审查基线：无变化，冻结语义不变，继续实施。**

| 项 | 结果 |
| --- | --- |
| 冻结审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970`（spec README / spec / plan 一致） |
| 最新 `origin/develop` | `da38dd0580eeac737f5291556b9dbdf832d91970` — 与基线 SHA 完全一致 |
| merge-base | `da38dd0`（= 基线 = 最新 develop） |
| diff `develop..origin/develop` | 空（零差异） |
| 结论 | notifications / orders / auth / main / health / proxy / 前端五个接入页面均无变化 → 无受影响 REQ / AC，无语义变化；O-RT-01~08 冻结结论仍成立 |
| 动作 | 不 rebase、不改冻结决策，直接在冻结 commit 之上实施 |
若 develop 与 Draft 基线之间涉及 notifications、orders、auth、main、health、proxy 或前端五个接入页面，先做 delta audit。只读取变化位置并判断受影响 REQ / AC；不能直接 rebase 后继续。

---

## 3. Runtime、数据库与端口隔离

### 3.1 Runtime

| 项 | 固定值 |
| --- | --- |
| Node | 20.x，满足仓库 `>=20 <21` |
| npm | 10.x，满足仓库 `>=10 <11` |
| PostgreSQL | 16.x / 与生产兼容版本 |
| 前端 | Vite dev server，仅专用端口 |
| 后端 | 两个独立 Node PID，不能同进程伪装多实例 |

先运行 `npm run check:runtime`，不得通过跳过 pre-script 或改 engines 绕过。

### 3.2 专用数据库

| 用途 | 值 |
| --- | --- |
| Test DB | `monexus_test_notification_realtime` |
| 可选 Shadow DB | `monexus_test_notification_realtime_shadow`；只有 owner 批准的 migration 诊断可用，本波正常不需要 |
| 默认用户 / host | 本地 compose 的 `monexus@127.0.0.1:5432` |
| 禁止 DB | `monexus`、`monexus_test`、任何 staging / production / 未明确带 test 的数据库 |

允许的测试 URL 示例：

~~~text
postgresql://monexus:<local-dev-password>@127.0.0.1:5432/monexus_test_notification_realtime?schema=public
~~~

约束：

- destructive reset 前必须解析并打印 hostname / port / db name，断言 db name 精确等于上述专用库。
- listener 和 Prisma 在测试中必须指向同一专用 DB。
- 不把本地密码、完整 DATABASE_URL 写入日志、证据、PR 或 fixture；证据只记录 host / port / db name。
- 不复用默认 verify-local 的 `monexus_test`，避免并行 Agent 清库冲突。
- 本地值只放在 git-ignored、权限 0600 的根 `.env.notification-realtime.local`；verify scripts 在关闭 xtrace 后读取，禁止 `echo` 完整 URL。

### 3.3 端口

| 进程 | 端口 |
| --- | --- |
| Backend A | `127.0.0.1:3112` |
| Backend B | `127.0.0.1:3113` |
| Frontend | `127.0.0.1:5182` |
| Test Nginx / proxy | 由脚本申请未占用高位端口并记录；不得占 80 / 443 |

Playwright 必须 `reuseExistingServer=false`；Vite 设置 `VITE_API_PROXY_TARGET=http://127.0.0.1:3112`，API helper 设置对应专用 origin。

---

## 4. 文件所有权与共享热点

### 4.1 任务 Ownership

| Owner task | 可改文件 | 禁止扩张 |
| --- | --- | --- |
| T-BE-001 | server package / lock、config、realtime constants / protocol | schema、JWT / Redis |
| T-BE-002 | notification dispatcher + 对应 tests | orders service / fulfillment、hub |
| T-BE-003 | listener / lifecycle、service 安全投影 | REST schema、Prisma pool |
| T-BE-004 | hub / stream controller / routes、auth exp 类型 | JWT / refresh 语义、普通 controllers |
| T-BE-005 | metrics、health、main（只调用 lifecycle 公开 API） | lifecycle 核心、cron / Redis 业务 |
| T-FE-001 | realtime parser / stream、realtime types | Axios / auth persistence、页面 |
| T-FE-002 | invalidation / hook / bridge、Layout、appStore glue | Announcement、订单 cache |
| T-FE-003 | AnnouncementCenter、NotificationsPage、notification API glue | announcement backend / UI 重做 |
| T-FE-004 | OrdersPage、OrderDetailModal 最小 contract | order API / delivery权限 |
| T-FE-005 | MerchantDashboardPage、相关 dialog 最小 contract | merchant backend / stats口径 |
| T-INF-001 | nginx、Caddy、proxy check / smoke | upload / backup / MinIO 语义 |
| T-INF-002 | env examples、compose、prod env / smoke、runbook | 真实 env / secrets |
| T-QA-001~004 | 专用 tests、configs、harness、verify scripts | 放宽生产逻辑 / 跳过失败 |
| T-QA-005 | 最终 verify script、`implement.md` evidence / G-PR、`checklist.md` 证据 | 改冻结决策或删除失败证据 |
| T-DOC-001 | 本规格目录、旧 spec / design 指针 | 旧业务决策 |

### 4.2 共享热点锁

以下文件同一时间只能有一个活动 owner；`lifecycle.ts` 全程由 T-BE-003 独占，T-BE-005 只能 import 它的公开 API：

- `server/src/config/index.ts`
- `server/src/modules/notifications/routes.ts`
- `server/src/modules/notifications/realtime/lifecycle.ts`
- `server/src/main.ts`
- `server/src/lib/metrics.ts`
- `src/components/Layout.tsx`
- `src/stores/appStore.ts`
- `docker-compose.prod.yml`

如多 Agent 并行，协调者先记录 owner 与预计交付 commit。其他 Agent 只能读，不得“顺手修”。
T-DOC-001 冻结完成后移交文档证据区给 T-QA-005；后者只可填写 evidence、checkbox 与 G-PR 状态，不得改 D / NRT / REQ / AC 正文。

### 4.3 绝对禁止改动

- `server/prisma/schema.prisma`
- `server/prisma/migrations/**`
- 订单状态机与通知事件 / 收件人矩阵
- Refresh Token rotation、JWT secret / TTL
- Announcement schema / receipt 语义
- 生产 `.env`、任何 secret 文件
- 他人 worktree 或当前 WIP

---

## 5. 三色权限

### Green — Always Allowed

- 阅读本 worktree、运行只读 Git 检查、查看稳定 ID。
- 编辑当前任务 Owned files。
- 在专用 DB / ports 运行针对性测试。
- 添加当前任务所需测试、fixture、脱敏 metrics / logs。
- 更新当前任务状态、evidence、对应 checklist。
- 用 feature flag 保持默认关闭并验证回滚。

### Yellow — Ask First

- 修改任何 D-RT / NRT / REQ / AC 或 SLA。
- 修改非 Owned file、共享热点的他人区域或其他 Agent 未提交改动。
- 新增除 `pg` / `@types/pg` 以外依赖。
- 增加 / 修改 Prisma schema 或 migration。
- 改 SSE endpoint、event 名、payload、status、配置变量名 / 默认值。
- 用 Redis、Outbox、WebSocket、DB trigger 替代冻结架构。
- 修改 JWT / refresh / CORS / limiter 全局语义。
- 占用不同 DB / ports、启动共享 compose、改 CI workflow。
- rebase / merge 产生语义冲突。

### Red — Never Allowed

- 访问、写入、reset、migrate、seed production / staging 数据库。
- 把 access / refresh token 放 URL、日志、metric、snapshot、fixture 或 commit。
- 在 SSE / PG payload 发送卡密、delivery content、structured values、对象键、Webhook secret。
- 破坏性 Git：reset --hard、clean -fd、强推、覆盖用户改动。
- 删除 Notification 历史、回滚 / 改写其他 migration。
- 关闭 / kill 未由本任务启动的容器、进程或端口。
- 用 page.reload、主动 API polling、test.skip 伪造实时测试通过。
- 绕过失败 gate、降低 SLA / buffer / isolation 检查来得到绿灯。

---

## 6. 单任务实施卡协议

同时只能有一个 `I-*` 为 In Progress。每张实施卡开始前复制：

~~~text
Implement card:
Mapped tasks:
Status: Pending | In Progress | Blocked | Done
Agent:
Start HEAD:
Worktree:
DB name:
Ports:
Owned files:
Must Not Touch:
Prerequisites:
Target tests:
Rollback:
~~~

完成时补：

~~~text
End HEAD:
Changed files:
Commands + exit codes:
Test counts:
AC / CHK evidence:
Known limitations:
Follow-up owner:
~~~

### 实施卡顺序

| Implement ID | 对应任务 | 状态 | 提交门槛 |
| --- | --- | --- | --- |
| I-RT-001 | T-DOC-001 | Done (2949508) | 六件套 Frozen、delta audit |
| I-RT-002 | T-BE-001 | Done | config / protocol / dependency tests |
| I-RT-003 | T-BE-002 | Done | real PG commit / rollback / dedupe + AC-RT-028 / CHK-BE-003 |
| I-RT-004 | T-BE-003 | Done | listener / generation / primary projection |
| I-RT-005 | T-BE-004 | Pending | hub + stream raw integration |
| I-RT-006 | T-BE-005 | Pending | readiness / metrics / SIGTERM |
| I-RT-007 | T-FE-001、T-FE-002 | Pending | parser / state / invalidation contract |
| I-RT-008 | T-FE-003~005 | Pending | notification / buyer / merchant UI E2E |
| I-RT-009 | T-INF-001、T-INF-002 | Pending | proxy / env / smoke / runbook + AC-RT-029 / CHK-INF-007 |
| I-RT-010 | T-QA-001~004 | Pending | backend、browser、multi-instance、failure + AC-RT-028 evidence |
| I-RT-011 | T-QA-005 | Pending | AC-RT-001~029、全部 P0 CHK、rollout / rollback、PR handoff |

单卡范围仍受 task.md 更细的 ownership 约束。任何映射多个 Task 的卡在开工记录中必须逐 Task 列出独立 Owned files / DoD / commits；映射到同一卡不表示可以越界改彼此文件。

CHK-P1-001~005 均不映射 I-RT 实施卡且不阻断 G-PR；D-RT-25 / CHK-P1-005 阈值命中后只能创建新的 Draft 规格，不得在本实施包内顺手引入 broker / sharding。

---

## 7. 实施纪律

### 7.1 Red → Green → Refactor

1. 先新增能证明对应 REQ / AC 的失败测试。
2. 实现最小生产代码使测试通过。
3. 运行目标测试和直接受影响回归。
4. 只在绿色后整理代码；重构不能改变已冻结协议。
5. 记录证据后才把任务改为 Done。

### 7.2 事务与实时专项检查

改 Dispatcher 时必须人工复核调用链：

- Notification insert 和 `pg_notify` 使用同一个 `tx`；
- `pg_notify` SQL failure 没有被 catch / 降级为业务成功，也没有被移到 commit 后；
- AC-RT-028 listener 先 ACK；proxy 恰好一次命中 tx 参数化 `pg_notify` 并捕获唯一 ID 对，root client 零次；独立 client 证明 rollback，匹配 hint 静默 2 秒；正常路径匹配 hint ≤5 秒且恰好一次；
- 不存在 transaction 内 hub write；
- rollback 测试监听的是真实 PostgreSQL channel；
- unique conflict 不产生第二 hint。

改 listener 时必须人工复核：

- 专用 `pg.Client` 数量；
- DATABASE_URL 未被日志打印；
- on error / end 不重复重连；
- stop 后 timer 被清；
- 主库查询按两个 ID 且字段 allowlist。
- AC-RT-029 / CHK-INF-007 同时具备 7×24 小时内且同 endpoint / role / revision 的模式证据与 ≤65 秒、t≈0/30/60 三轮各 5 秒、四次 PID 单值、current_user match、权限通过的行为证据；证据缺失 / 过期即阻断启用，不擅自新增 direct URL。

改前端时必须人工复核：

- user / token change 先 abort；
- 不是 maxSeen 去重；
- ready 必定 REST sync；
- polling / healthy timer 互斥；
- history sync 不 Toast。

### 7.3 禁止顺手改

发现邻近 bug 或设计异味时：

1. 写入 Known limitations；
2. 提供 file:line、影响和建议；
3. 不在本 PR 顺手修，除非它直接阻断 AC 且 Owner 批准 scope change。

---

## 8. 验证环境准备

以下是实施协议，不代表当前已执行。可运行入口是 T-QA-003 创建的安全脚本；文档中的 redacted URL 不得被原样复制执行。

~~~bash
cd /root/projects/worktrees/monexus-order-notification-realtime
npm run check:runtime
test -f .env.notification-realtime.local
bash scripts/verify-notification-realtime-e2e.sh --prepare-only
~~~

本波不运行 `prisma migrate dev`，不生成 migration。

---

## 9. 分层验证命令

### 9.1 快速静态门禁

~~~bash
cd /root/projects/worktrees/monexus-order-notification-realtime
npm run check:runtime
npm run build
npm run check:nginx
cd server
npm run build
~~~

### 9.2 后端目标测试

~~~bash
cd /root/projects/worktrees/monexus-order-notification-realtime/server
set -a
. ../.env.notification-realtime.local
set +a
case "$TEST_DATABASE_URL" in
  */monexus_test_notification_realtime\?schema=public) ;;
  *) exit 1 ;;
esac
npx vitest run src/modules/notifications/__tests__
unset TEST_DATABASE_URL
~~~

### 9.3 前端与核心 E2E

~~~bash
cd /root/projects/worktrees/monexus-order-notification-realtime
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime-client.spec.ts \
  e2e/notification-realtime.spec.ts
~~~

### 9.4 双实例与代理

~~~bash
bash scripts/verify-notification-realtime-multi-instance.sh
bash scripts/verify-notification-realtime-proxy.sh
~~~

### 9.5 最终门禁

~~~bash
bash scripts/verify-notification-realtime.sh
git diff --check
git status --short
~~~

目标 scripts 在对应 QA / INF 任务落地前不存在；实施 Agent不得把“命令不存在”记为跳过理由，必须由 owner task 创建。

---

## 10. Evidence Ledger

每条证据使用：

| 时间 | HEAD | I / T | REQ / AC / CHK | 命令或动作 | 结果 | Artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-09 | 22ae95c8 (frozen) + I-RT-001 | I-RT-001 / T-DOC-001 | REQ-F-022、REQ-NF-007、REQ-NF-009；CHK-DOC-001~002 | git rev-parse HEAD / origin/develop; git diff --stat develop origin/develop; git diff --check; rg 六件套 ID/版本/状态/基线；编辑旧 spec/design superseded 指针 | develop..origin/develop diff 空 → 冻结语义不变；六件套 ID/版本/状态/基线一致；`git diff --check` exit 0；旧 spec.md / design.md 已加 superseded 指针 | commit 记录见 git log；delta audit 见本文档 2.1 |
| 2026-08-09 | I-RT-004 HEAD | I-RT-004 / T-BE-003 | REQ-F-002、REQ-F-020、REQ-NF-003；AC-RT-005、010、029；CHK-BE-006~010 | `cd server && npm run build`；`npx vitest run realtime-listener.integration.test.ts + notifications + config guards`；pg_stat_activity application_name 计数 | build exit 0；10 files / 112 tests passed；start 幂等 app_name 计数=1；no_subscriber 跳过查询；pg_terminate_backend → degraded + 恰好一次 drain → reconnect healthy；stop 后无 backend；query 无 payload 整体/敏感字段 | 新增 `realtime/listener.ts`、`realtime/lifecycle.ts`、`realtime-listener.integration.test.ts`；`service.ts` 新增 getRealtimeEnvelope |

证据规则：

- 命令必须含 exit code、测试数与耗时；
- 环境证据含 DB 名、ports、feature flags，不含密码 / token；
- E2E artifact 保留 trace / screenshot / video 路径；
- 性能证据含样本量、P50 / P95 / P99、环境与时间；
- 双实例证据含两个独立 PID、ports、listener application_name；
- 人工 smoke 写 Given / When / Then 和观察指标；
- “本地看起来正常”不是证据。

---

## 11. PR 合并闸门

状态枚举仅允许 `Pending | Passed | Failed`。只有 T-QA-005 可在当前 HEAD 的证据填入后改状态；代码变化使证据过期时必须退回 Pending。

| Gate | 要求 | 状态 | Evidence |
| --- | --- | --- | --- |
| G-PR-001 | 六件套 Frozen，所有 P0 task / checklist 完成 | Pending | 待填 |
| G-PR-002 | 分支基于最新 develop，冲突与 delta 有记录 | Pending | 待填 |
| G-PR-003 | backend / frontend build 全绿 | Pending | 待填 |
| G-PR-004 | 既有通知、订单、auth、announcement 回归全绿 | Pending | 待填 |
| G-PR-005 | 新 realtime client / E2E / multi-instance / proxy suite 全绿 | Pending | 待填 |
| G-PR-006 | AC-RT-001~029 全有证据，P95 / P99 达标 | Pending | 待填 |
| G-PR-007 | schema / migrations 无 diff，migration status 无 drift | Pending | 待填 |
| G-PR-008 | secret scan、payload allowlist、metrics cardinality 审核通过 | Pending | 待填 |
| G-PR-009 | realtime 默认 false，发布 / 回滚 / smoke 已演练 | Pending | 待填 |
| G-PR-010 | PR 描述含规格链接、配置、监控、风险、回滚与证据索引 | Pending | 待填 |

任一 Gate Pending / Failed：不得宣称 ready to merge。

---

## 12. Blocked / Ask First 模板

~~~text
Blocked task:
Current HEAD:
Exact blocker:
Evidence (file:line / command / error):
Frozen decision affected:
Safe alternatives:
Recommended choice:
Scope / migration / dependency impact:
Work that remains safely completed:
~~~

阻断期间可以继续只读定位或不冲突的测试设计；不得越权选架构。

---

## 13. 实施完成交接模板

~~~text
Outcome:
Branch / HEAD:
Spec version:
Tasks completed:
Files changed:
Feature defaults:
Database / migration result:
Validation summary:
Latency result:
Security / payload result:
Multi-instance / proxy result:
Rollout order:
Rollback command / action:
Metrics to watch:
Known limitations:
Follow-ups:
PR gate status:
~~~
