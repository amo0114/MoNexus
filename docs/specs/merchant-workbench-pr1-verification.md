# 商家工作台 PR1 验证记录

日期：2026-10-07。范围：[实施计划 PR1](./merchant-workbench-v1.plan.md)。状态：只读后端已实现，本地检查通过；PR2 前端、PR3 试点尚未执行。本文不表示已经推送、创建远端 PR 或部署。

## 实现

- 关闭默认的 `MERCHANT_WORKBENCH_ENABLED`，不修改 `/me`。
- 四类只读 GET：urgent、availability、drafts、单事项重验。商家身份从已认证用户查得，沿原 active merchant 权限链。
- SLA 与售罄各 200 条上限、完整计数和截断标记；组失败返回未知计数，两组失败返回 503。
- 草稿每批 20 个、并发上限 4；独立失败结果及重试目标。urgent 不调用 readiness。
- `readinessOffer.ts` 提取既有纯评估函数；`inspectProductReadiness` 提供同次检查产生的安全导航提示。原 `checkProductReadiness` 的参数默认值和返回 DTO 保持不变。
- 新接口显式构造白名单 DTO、封闭导航对象和有限标签指标。无工作台新表、迁移、业务写入、通知、后台任务或模型调用。
- AC13 已明确集合 404、200、5xx/网络失败的不同前端语义；本 PR 仅验证服务端响应，前端行为由 PR2 实现与测试。

## 实际执行

运行时 Node 20.20.2；独立本地 PostgreSQL 14 数据库 `monexus_workbench_test`。已在该库重放仓库已有迁移；未使用其他 Agent 的测试/预览库，未修改 Prisma schema。CI 的 PostgreSQL 16 环境尚未运行。

| 检查 | 结果 |
| --- | --- |
| `npm --prefix server run build` | 通过，包括 TypeScript（含新增测试源码）和 postbuild 模板注册表导入检查 |
| `publicationReadiness.test.ts` + `publicationReadiness.v2.test.ts` | 32 个用例通过 |
| `publicationRoutes.test.ts` + `low-stock-notify.test.ts` + `sla-remind.test.ts` + `workbench/workbench.test.ts` | 22 个用例通过 |
| `git diff --check` | 通过 |

共 54 个不同测试用例。工作台文件曾独立运行 8 个用例，之后纳入上述 22 个回归，不重复计数。

首次并行构建/测试期间，容器交换空间用满、发布检查测试超时；已中止该轮并改为顺序执行。上表记录的是顺序重跑的成功结果，没有放宽测试超时或修改业务断言。

## 新测试的证据

位置：`server/src/modules/merchant/workbench/workbench.test.ts`。

- ACL：未登录 401、关闭 404、开启 200、暂停 403、跨商家目标 404、身份查询参数 400。
- 故障：单紧急组失败时总数为 null；两组失败为 503，错误响应不泄露底层错误文本。
- 库存：即时库存 available 数与 Offer.stock 不一致时仍取实际条目；容量取 stock；无限量、外部集成、停用、归档排除；0 阈值只取售罄。
- 上限：201 个 SLA 订单及 201 个售罄规格返回各 200 项，总数 402；连续 urgent 调用不执行 readiness，不新增订单事件/库存日志/通知。
- 时间和归属：deadline 等号、前后 1ms、24h 上界、空值及终态；UTC 和 Asia/Shanghai 数据库会话产生相同结果；商品归属变化后订单仍按快照 merchantId 查询。
- 草稿：25 个草稿分 20+5，默认发布检查仍报告售罄；单项读取后状态变化可退出；模拟故障保留 unknown，并发最多 4。
- 导航与秘密：覆盖全部已知缺项代码，验证无启用规格、配置无效、配置有效但售罄的不同目标；DTO 不含 reason、卡密、固定交付内容或购买资料哨兵。

## 后续

PR2 必须补齐真实页面的 404/200/5xx 区分、定时器只调用 urgent、精确规格深链接与焦点行为；本地后端测试不能替代这些前端验收。PR3 再收集试点数据，不将当前接口可用等同于经营收益已验证。
