# Handoff · 后端架构整改与 FakaBridge 可选插件

- Owner 于 2026-11-24 批准实施，交付要求是一个面向 `develop` 的 PR。
- 评审基线为 `4b098c8ff415b53dabb32758730cfb792b60cc9c`。实施工作树为 `/root/.t3/worktrees/MoNexus-new/feat-backend-architectu-bbf4e2e25abe40a6`，分支已同步 `origin/develop@c00d588`。原工作区的未提交工作继续保留。
- 需求与验收见本目录的 [tasks.md](tasks.md) 和 [design.md](design.md)。制品安装、启停和保留数据见[运行手册](../../../docs/operations/faka-bridge-plugin.md)。

## 已实现

| 评审编号 | 实施内容 |
| --- | --- |
| BE-01 | 损坏历史凭据的重试 SQL 统一使用 UTC 操作数，保留未来调度和活动租约 |
| BE-02 | AG-05 按环内有向边限制增量，覆盖环成员不变、内部增边的反例 |
| BE-03 | 支付与充值共享契约下沉，支付从组合入口调用充值用例，二节点环退出基线 |
| BE-04 | 五个平台履约命令迁回订单应用层，目录保留商品和交付材料事实 |
| BE-05 | 注册在原事务内调用钱包开户接口，架构门禁覆盖开户写入 |
| BE-06 | OpenAPI 文档变更触发后端真实响应检查 |
| BE-07 | 下单从原事务提取交付决策和即时交付命令，保留原事务与幂等顺序 |
| BE-08 | 集成设置共享版本检查、事务写入锁和探测限流，保留短链契约 |

- FakaBridge 独立产出后端、前端和数据库安装制品。核心打包检查具体实现导入和专属表访问。旧站保留 Prisma 迁移历史，增量回填订单履约方。新核心数据库独立初始化，插件迁移按校验和记录。
- API 和 worker 根据共享状态加载同一构建的插件。暂停与历史任务分开，订单、重置确认和旧实例义务写入受数据库状态约束。注销检查任务、租约、撤销、售后及权益，保留历史订单和交付。

## 验证

Node 22.23.1、npm 10.9.8。主要运行代码快照为 `2434092`。随后补充了打包边界检测及 OpenAPI 断言。

| 命令或验收 | 结果 |
| --- | --- |
| `npm run test:architecture`、`npm run check:architecture`、`npm run check:migrations` | 退出码均为 0，架构单测 22 项、迁移规则单测 2 项 |
| `npm --prefix server run build`、`npm run build -- --manifest` | 退出码均为 0 |
| `openspec validate backend-review-faka-plugin --strict` | 退出码 0 |
| 定向 `npm --prefix server test -- --reporter=verbose …` | 退出码 0，PostgreSQL 14.24、Asia/Shanghai 会话，27 文件 281 项。覆盖下单幂等、资金和退款、注册钱包、供应商版本、撤销、Bot raw body、路由顺序及 OpenAPI |
| `npm --prefix server test -- src/__tests__/admin-faka-runtime.test.ts src/__tests__/openapi-contract.test.ts` | 退出码 0，11 项复跑通过，验证注销响应与 OpenAPI 一致 |
| 定向 `npm test -- --run …` | 退出码 0，8 文件 70 项。覆盖结账弹窗、管理商品、设置、权限与商品详情 |
| 旧库 `npm --prefix server run db:migrate:deploy` | 退出码 0；在基线已建 Faka 任务的数据库应用一个新增迁移，任务归属回填为 `faka_bridge` |
| BE-01 的 UTC 会话对照 | 退出码 0，1 项通过；Asia/Shanghai 结果已纳入定向集成 |
| `npm --prefix server run package:fulfillment`、`node scripts/package-fulfillment-web.mjs`、`node server/scripts/verify-fulfillment-release.mjs` | 退出码均为 0。纯核心新库通过交易，7 个可选 Web 资源独立交付，API 和 worker 在运行期间装载、注销 |
| 两种迁移入口分别指向另一种历史 | 均按预期退出 1，在迁移前拒绝混用 |

生产数据库会话时区、真实上游及站点出站政策仍需现场验证。全量浏览器旅程由 PR 的 `run-e2e` 门禁运行。
