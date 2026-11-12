# 后台运营治理 v1：前端 agent 交接书

日期：2026-11-12｜状态：设计契约，尚未开发｜代码基线：develop@8da71e0

主方案：[后端业务闭环与运营治理实施书](../implementation/2026-11-12-backend-governance-implementation-plan.md)。本交接书只给页面方向和协作边界，具体视觉与组件由前端 agent 决定。

## 1. 负责人、文件与两个 PR

后端由 Codex 主代理负责 server/**、数据库迁移、OpenAPI、脱敏契约夹具、后台任务和告警；前端 agent 负责 src/**、客户端类型与 API、页面、组件测试与浏览器旅程。最多两个功能 PR，均从最新 develop 开发，后端先合并、前端随后合并。文档分别随功能 PR 纳入，不增加单独文档 PR。

请使用独立工作树。共享代码库内不要撤销他人的修改，不修改 server 逻辑来迎合页面 mock。根 package.json、e2e 公共夹具和工作流若有交叉变更，先声明具体文件与原因，由双方约定单一编辑者。

后端先提供 OpenAPI 和 docs/api/governance-v1/ 脱敏响应夹具。联调使用后端最终 SHA；字段或行为冲突反馈给后端负责人统一修订契约，不在前端另造规则。

## 2. 建议页面方向

| 场景 | 建议扩展位置 | 页面必须表达 |
| --- | --- | --- |
| 退款人工审核 | src/components/admin/AdminRefundAuditPanel.tsx；AdminRechargeRefunds.tsx | 原因、原充值来源资格、审核历史、可执行动作与阻止原因 |
| 用户管理 | src/components/admin/AdminUserTable.tsx | 昵称/角色/验证/状态/时间筛选，打开用户详情 |
| 用户详情 | 新页面或抽屉，由前端决定 | 概览；订单；积分和来源；会话；邀请；风险；操作记录，各区懒加载 |
| 商家审核 | 现有商家管理组件，实施时定位 | 当前申请版本、历史决定、拒绝理由、停用和恢复 |
| 商家申请 | 现有商家入驻流程 | 待审核、被拒理由、修改重提；不重复创建 Merchant |
| 商家停用 | 商家入口、RoleGuard、商家导航 | 保留历史只读和受限存量处置；禁止新增经营 |
| 审计 | src/components/admin/AdminAuditPanel.tsx | 安全详情，区分请求尝试与成功决定 |
| 库存与规格 | 现有商品编辑/库存页面 | 批次概要、剩余库存作废、已售关联、商业配置修订 |
| 导出 | 列表上的导出入口+任务列表或抽屉 | 排队、执行、失败、完成、过期；完成后申请下载 |
| 资金巡检 | 后台财务/运维入口 | 覆盖时间、差异、重查结果；没有一键修余额 |

优先扩展现有操作流，避免同时重做全站布局。移动端保证筛选、详情、理由输入、冲突提示与关键确认可操作即可；视觉方案不由后端固定。

## 3. 能力、权限与身份

GET /api/admin/capabilities 返回 contractVersion=governance-v1、permissions、features、limits。新页面按权限展示入口；接口 403 时明确显示无权限，不自动重复提交。

旧后端没有该端点时，新功能显示不可用；不能无条件沿用 super 权限或用 mock 数据冒充成功。现有基础功能保持原行为。新后端兼容旧前端，但新前端不承诺在旧后端上执行新业务。

商家身份与经营状态分开：商家被停用可能仍拥有历史资料读取能力。不要单凭 User.role 决定所有商家导航；登录及当前用户 DTO 增量返回 merchantCapabilities、merchantStatus、merchantLifecycleVersion，申请查询返回同一能力词表，业务详情返回 allowedActions。账号封禁优先于商家只读资格。

后端负责权限最终判定。页面隐藏按钮不是授权机制，用户详情各分区也可能分别无权限；分区不可见时不要提前请求其数据。

## 4. 客户端共同约定

1. 新状态使用英文词表，本地统一映射中文文案。旧 User.status 中文字段保留兼容，新界面使用 accountStatus，不在多个组件各写字符串比较。
2. 商城订单、批次、售后展示 orderNo/batchNo/caseNo，跳转仍用 id。历史暂无编号时可降级 #id，不修改供应商 externalOrderNo。
3. 所有新管理命令传 Idempotency-Key。一个操作意图使用稳定键；超时重试复用，动作或决定内容改变后新建键。不要拦截器里每次重试都生成新键。
4. 审核操作传对应 expectedVersion。409 时展示当前事实并重新获取，不能偷偷用最新版本重试旧决定。
5. allowedActions 与 blockers 是后端当前预览，执行仍可能冲突。金额、退款资格、来源、结算和商家权限不可在前端重新推导。
6. 沿用 error.code/message/details 解析，业务 409 不进入登录刷新循环；提交后只显示真实执行结果。断网或超时先查询，不乐观标记资金成功。
7. 明细使用 cursor/pageInfo；用户主列表保留 page/pageSize。筛选或排序变化清空旧游标，取消过期请求，防止用户 A 的迟到响应显示在用户 B 详情。
8. chargedPoints/refundedPoints/netSpentPoints 为积分口径；冻结额不算已消费，closed 订单可能已有售后退款。使用后端统计，不按列表当前页累加。
9. lastLoginAt、会话最近使用时间、活跃自然日有不同精度，分别命名；null 显示未知，不显示为从未使用或伪造注册时间。
10. 秘密与个人信息只显示授权 DTO，不要求后端返回卡密、token、raw IP 或原始支付响应来填满详情页。

## 5. 三个优先交互

退款审核：先看审核详情与阻止原因，再选择拒绝或恢复。恢复不让管理员输入退款金额；来源不足只展示事实。拒绝和恢复都要求理由。按钮成功表示后端决定已提交，现金退款仍可能处于执行中，页面要区分“审核通过”和“现金已退”。

商家审核：展示本次申请版本与旧决定。商家被拒后修改重提，原历史保留；管理员面对旧版本时提示已变化。恢复经营不能显示为同时解封用户或解除支付风险。

导出：提交固定 kind 和当前筛选；返回 jobId 后轮询摘要，到完成再请求 download。URL 不持久化、不写日志；过期后清晰说明需要重建。snapshotAt 是 worker 物化时间，不是点击时间，页面显示这一事实。

## 6. API 方向

详细请求 schema、字段与权限以主方案第 13 节及后端提交的 OpenAPI 为准，主要新增接口组如下。

| 组 | 路径方向 |
| --- | --- |
| 能力 | GET /api/admin/capabilities |
| 退款 | GET /api/admin/recharge/refunds/:id；POST /:id/review |
| 商家 | GET /api/merchant/application；POST /application/resubmit；GET /api/admin/merchants/:id/history；POST /:id/restore |
| 用户 | GET /api/admin/users/:id；其 orders/point-logs/sessions/referrals/security-events/audit 分区 |
| 封禁 | GET/POST /api/admin/users/:id/bans；POST /bans/:banId/release |
| 审计 | GET /api/admin/audit/:id |
| 追溯 | 商品下 inventory/batches 与规格下 revisions，管理端和商家端分别鉴权 |
| 导出 | POST/GET /api/admin/exports；GET /:id；POST /:id/download |
| 巡检 | GET /api/admin/wallet-integrity/runs、/issues；POST /issues/:id/recheck |

旧 ban/unban、商家 approve/reject/suspend、数字订单路径保留兼容。不要因为有新端点而同时给同一业务增加两套状态管理。

## 7. 验收与交付

组件层覆盖权限显示、状态文案、分区切换、迟到响应隔离、409 处理、幂等键复用和导出状态。沿用现有设计系统，不为普通文案和布局大量新增 E2E。

联调至少完成：原来源不足的退款只可拒绝；符合资格的恢复后呈现真实执行状态；驳回申请修改重提；停用商家读取历史但不能发布/接新单；临时封禁到期后的重新登录；operator 无权限直接调用被拒；用户售后净消费统计；导出完成下载与过期。

本批涉及鉴权、封禁与资金关键旅程，按项目 testing-policy.md 和 branching-and-ci.md 打 run-e2e 并取得 CI OK。前端完成组件测试、类型检查、生产构建、移动浏览器回归，并在交付说明中写清实际联调的后端 SHA。

前端交付包括：一个前端 PR、页面与客户端实现、必要测试、使用的契约版本、仍未接入项清单（若有必须明确，不以演示数据替代）。后端负责人交付可执行 API、迁移和证据；双方以同一业务场景结果验收。
