# MoNexus 后端业务闭环与运营治理实施书

版本：v1.0｜日期：2026-11-12｜状态：方案已批准，后端实施与验证中

代码基线：`origin/develop@8da71e00936695eb880e009cf98c6f746d08c9f9`。

交付约束：最多两个功能 PR，后端一个、前端一个，均合入 develop。后端由 Codex 主代理负责；前端由用户另行指定的 agent 负责。本文记录批准的设计；实际实现、验证和未完成门禁单独维护于[验证记录](../verification/backend-governance-v1/README.md)，发布步骤见[运维手册](../operations/backend-governance-v1.md)。本文和前端交接书随对应功能 PR 纳入，不再单开文档 PR。

主文档以 Markdown 为维护源，同名 DOCX 保留最初设计阅读版。前端协作入口：[前端交接书](../specs/backend-governance-v1.frontend-handoff.md)。既有交易、钱包和结算设计参见 [2026-11-10 实施方案](2026-11-10-commerce-accounting-settlement-closure-plan.md)；其中已经实现的部分，本批只扩展、不重建。

## 1. 目标、范围与成功标准

本批解决的问题是：异常订单与商家状态能够完成处置；管理员能够按权限查清一个账户、做出决定并追溯结果；商品库存、业务编号及变更记录能够支持真实运营。

成功标准按业务结果判断，不以新增表数、接口数或页面数判断。以下七项均属于后端 PR 的必交付范围，不能只完成 schema 或只返回演示 DTO。

| 工作包 | 后端必须交付 | 前端配合方向 |
| --- | --- | --- |
| B1 充值退款人工处置 | 审核详情、拒绝和恢复执行、并发幂等、原来源资格复核 | 在现有退款审核页面补操作与处理历史 |
| B2 商家生命周期 | 申请修订、再次提交、审核 CAS、停用/恢复、历史只读与存量处置权限 | 申请状态页、补资料、审核时间线、停用说明 |
| B3 账户与管理员治理 | 结构化封禁、到期语义、后台权限、审计安全详情 | 按权限导航、封禁表单、审计详情 |
| B4 用户聚合查询 | 用户详情、分区明细、筛选排序及统一积分统计口径 | 用户详情页面或抽屉、列表增强 |
| B5 基础数据规范 | 商城订单/结算批次/售后编号、状态约束、更新时间和索引 | 显示业务编号、英文状态映射 |
| B6 商品追溯 | 新库存批次逐件关联、批次剩余库存作废、规格商业配置修订记录 | 批次摘要与修订历史入口 |
| B7 运营执行 | 异步 CSV 导出、余额来源巡检、任务与积压告警 | 导出任务状态、下载、巡检结果入口 |

以下事项本批明确不做：多件订单与购物车、部分退款、商家现金提现或银行出款、通用工单引擎、重写所有履约供应商、全量 37 处分页改造、全表 BigInt 主键迁移、全量日志分区和冷归档、独立搜索服务。现有通用 FulfillmentJob 成功后的撤销能力列为新供应商接入准入条件，本批不为非生产 demo 扩建一套退款系统。

## 2. 已有能力与本批设计边界

钱包已经通过 WalletOperation、PointLot、WalletAllocation 实现来源分配、冻结、消耗与原来源返还；结算已有批次、冲正和欠收。本批所有积分动作继续调用 wallet，不直接写 PointAccount 或 PointLog，不另造收益主表。

退款有两种不同业务：商城订单售后返还平台积分，充值退款通过支付渠道退还实际支付款项。页面、接口权限、审计和测试均保持两者分离。商家收益本批仍为平台积分，不能把导出或用户统计中的积分数标作现金余额。

User、Merchant、Order 等保留原主键及既有关系。新增业务编号不替代技术主键；商家重新申请复用原 Merchant，不删除旧商家或重绑历史商品、订单、结算。历史未知来源、旧封禁理由、旧库存批次关系均不凭猜测重建。

## 3. 两个 PR 的分工与协作方式

| 项目 | PR-BE：后端 | PR-FE：前端 |
| --- | --- | --- |
| 建议分支 | feat/backend-governance-v1 | feat/operations-governance-ui-v1 |
| 负责人 | Codex 主代理 | 用户指定的前端 agent |
| 文件所有权 | server/**；后端运维脚本；OpenAPI；迁移；告警；本文；后端契约夹具 | src/**；前端组件测试；浏览器旅程；前端交接书 |
| 共用文件 | 后端维护 docs/superpowers/specs/monexus-api-openapi.json 和 docs/api/governance-v1/** | 前端消费契约，在 src/api、src/types 内实现客户端 |
| CI/配置冲突 | 根 package.json、工作流、架构脚本如需调整，由后端先声明具体改动；双方不互相覆盖 | 不为了前端 mock 修改服务端权限和业务状态 |
| 合并顺序 | 先合并；旧前端可继续使用 | 后合并；基于后端最终 SHA 完成联调 |

两方可以并行开发，契约先于页面与服务实现冻结。后端先提交 OpenAPI 增量、字段词表、错误码、脱敏响应夹具和能力版本；前端据此 mock。接口发生语义变化时，由后端同步修改契约与夹具并告知前端，不能只在聊天中更名。

实现阶段在最新 develop 创建各自隔离工作树，保留当前工作区已有修改。双方不修改对方拥有的业务代码；交叉问题通过契约和缺陷清单协调。前端不决定退款资格、金额或可用操作，后端不规定视觉细节。

推荐后端 PR 标题：完善充值退款、商家生命周期与后台运营治理。推荐前端 PR 标题：接入用户详情、商家审核与运营处置工作台。后端 PR 内按工作包分提交，迁移、领域规则和机械替换分开，仍只有一个后端 PR。

## 4. 跨模块不变量

| 编号 | 不变量 | 强制方式与验收位置 |
| --- | --- | --- |
| GOV-01 | 同一充值只有一份全额退款主记录及一次经济冲正 | 保留充值单唯一退款关系；原渠道幂等键；RechargeReversal 唯一关系 |
| GOV-02 | 人工恢复退款不能使用其他充值或奖励来源冒充原充值未消费 | 钱包来源过滤、账户锁、恢复资格复核、集成测试 |
| GOV-03 | 审核拒绝或记录备注不能触发外部退款和积分变动 | 专用命令、无外呼路径、事务断言 |
| GOV-04 | 同一商家申请版本只能产生一个审核决定 | Merchant 行锁、lifecycleVersion CAS、申请版本唯一决定 |
| GOV-05 | 停用不抹去历史关系；有效封禁优先于商家只读权限 | 保留主键和外键、统一身份与能力判断 |
| GOV-06 | 恢复商家不解除账号封禁或支付争议限制 | 分域服务，不互相写入限制状态 |
| GOV-07 | 所有管理入口同时满足当前管理员、MFA 和所需权限 | 全路由权限清单；独立挂载入口与敏感服务同样检查 |
| GOV-08 | 同一管理命令重放不产生第二次决定或资产结果 | 稳定 Idempotency-Key、请求摘要、领域唯一约束 |
| GOV-09 | 一个库存条目只属于一个确定的新导入批次；未知历史不伪造 | 新导入事务写 batchId；旧行保持 null |
| GOV-10 | 导出内容经过明确权限与字段白名单；下载重新鉴权 | 创建、执行、下载三处授权；私有对象；到期清理 |
| GOV-11 | 巡检只记录差异，不自动覆盖余额或来源 | 独立只读诊断查询，无修复余额命令 |
| GOV-12 | 旧前端仍可读取旧状态与使用数字 ID 路由 | 兼容序列化、增量字段、旧客户端契约回归 |

审核、导出、封禁的成功审计与本地状态同事务落库。外部调用的请求尝试可单独记录，但不能把一次请求尝试记为成功。网络请求一律在数据库事务外执行，通过既有支付任务或明确的持久化任务衔接。

## 5. 后端模块与调用方向

保留模块化单体与同一个 PostgreSQL，复用现有 worker、cronLease、私有存储和告警。新增代码按职责收拢，不增加通用工作流 DSL 或跨域消息总线。

| 模块/建议文件 | 责任 | 不承担的责任 |
| --- | --- | --- |
| recharge/refundReview.ts | 人工退款详情、决定、资格复核、恢复原退款记录 | 不另造支付退款执行器 |
| merchant/lifecycle.ts | 商家申请修订与生命周期命令 | 不写商家钱包和结算 |
| accountGovernance/ | 结构化封禁、有效状态、到期处理 | 不覆盖支付争议 AccountRestriction |
| adminAuthorization/ | 权限词表、授权查询与管理员配置 | 不依赖前端按钮判断 |
| admin/userQueries.ts | 用户详情、统计与各区明细查询 | 不存第二份用户资产 |
| catalog/offerRevisions.ts | 商业配置变更记录，供所有权威写入路径调用 | 不记录明文交付秘密 |
| merchant/inventoryService.ts | 批次关联与已有库存操作 | 不按日志数量猜旧库存批次 |
| adminExports/ | 固定导出种类、快照物化、任务与下载 | 不接受任意 SQL 或模型名 |
| wallet/integrity.ts | 分批巡检与差异生命周期 | 不自动调账 |
| lib/businessNumber.ts | 统一业务编号生成与校验 | 不更换现有主键 |

controller 只完成身份、输入和 DTO 适配；领域服务内部仍要验证状态、归属和敏感操作权限。不要把 admin/userAdmin.ts 再扩成集中了退款、封禁、导出和用户详情的万能服务。

## 6. B1：充值退款人工处置

### 6.1 保留的模型语义

保留 RechargeRefund.rechargeOrderId 唯一、现有渠道退款幂等键、全额退款金额、RechargeReversal 及 PointHold 关系。本批不把一次退款改成多条主记录，不新增任意金额退款接口。失败、取消与成功仍是终态；结果不明继续走查询/对账，不通过“重试”按钮发起第二次现金退款。

扩展 RechargeRefund：reviewVersion（Int，默认 0）、reviewedByUserId、reviewedAt、reviewDecisionCode、reviewNote。原 reasonCode 保留初始申请原因，不被审核备注覆盖。

新增 RechargeRefundReviewAction：id、refundId、kind（resume/reject）、requestKey、requestHash、expectedReviewVersion、actorUserId、reasonCode、note、evidenceRef、fromStatus、toStatus、createdAt。requestKey 全局唯一，关键外键 Restrict；只追加不覆盖。动作与退款状态、冻结、成功审计同事务写入。

### 6.2 状态与允许动作

| 当前状态 | 操作 | 结果与副作用 |
| --- | --- | --- |
| manual_review | reject | 改 cancelled，记录 admin_rejected；不冻结、不退现金、不撤销积分 |
| manual_review | resume | 资格满足后，原来源冻结成功则改 points_held；提交后由现有 worker 执行 |
| manual_review | resume 但资格不足 | 409，返回缺口和阻止码；状态不变，不记成功审核 |
| requested/points_held/processing | 查询 | 保持现有执行；不能作为待审核记录重复批准 |
| succeeded/failed/cancelled | 查询 | 返回事实及对账入口；本批不提供改状态重发 |

reject 是本次退款申请的终结，不宣称永久剥夺用户的其他处置权；本批不开放同一充值多次申请或部分退款。未来如需要再次受理，应单独审查退款尝试模型与渠道键，不能删除旧记录后重建。

### 6.3 resume 的精确执行步骤

1. 校验当前管理员、MFA、payments.refunds.review 权限、Idempotency-Key、expectedReviewVersion、理由及证据引用格式。
2. 通过 refundId 解析 rechargeOrderId；事务内依次锁 RechargeOrder、RechargeRefund，再读取争议、原信用及 PointHold。业务根锁之后再锁账户；锁内重读状态。
3. 同键同摘要先返回原成功动作；同键不同摘要返回 409 IDEMPOTENCY_KEY_REUSED。非 manual_review 或版本不符返回 STATE_CONFLICT。
4. 复核原订单已入账、非沙箱、支付身份/金额/币种完整、无非 won 支付争议、无已有冲正、无不一致的活动 hold。渠道能力检查只读本地能力；不在事务内请求渠道。
5. 找到 recharge-credit:<orderId> 钱包操作，仅统计它对应来源的可用积分；不得使用其他 recharge、reward 或 merchant_settlement lot。锁账户后复核；不足返回 REFUND_SOURCE_INSUFFICIENT。
6. 调用原退款对应的 reserveInTx，建立/核对唯一 PointHold，CAS 改 points_held 并递增 reviewVersion，写 ReviewAction 与成功 AdminLog；本地事务提交。
7. 提交后仅唤醒现有处理器；即使唤醒丢失，worker 仍能扫描到 points_held。外部超时保留查询恢复语义，不把超时当失败重新创建退款。

拒绝路径使用相同业务根锁与 CAS，确认该记录未执行、无活动资金冻结后写 cancelled。若发现 manual_review 与 hold/渠道执行事实矛盾，返回 RECONCILIATION_REQUIRED，转既有对账队列，不能一键释放或覆盖事实。

### 6.4 历史来源边界

现有 refundLotFilter 对无法关联钱包充值操作的历史记录回退 legacy_unknown，这不能证明该笔充值未消费。新增人工 resume 默认要求可验证原充值来源；无法证明时返回 LEGACY_SOURCE_UNPROVEN，提供查看原信用、消费记录和对账证据的能力。

本批不自动把未知余额洗成 recharge lot，不允许以手写备注解除这个检查。已有历史兼容执行路径要在盘点中单列，保持明确的 legacy 标记与原有受控范围；如果需要扩大历史现金退款范围，必须先确定可执行的历史余额撤销政策，再作为显式政策版本启用。未确定时可拒绝本次申请或维持有负责人、有理由、有期限告警的人工案件，不能显示“系统已经处理完”。

### 6.5 接口与验收

新增 GET /api/admin/recharge/refunds/:id、POST /api/admin/recharge/refunds/:id/review。POST body 为 action、expectedReviewVersion、reasonCode、note、可选 evidenceRef；不接受 amount、userId、providerRefundId 或目标积分来源。返回 refund、reviewAction、allowedActions、blockers 与最新版本。

验收至少覆盖：积分花掉后进入审核；订单退款恢复原 lot 后可批准；其他充值或奖励增加不能使其批准；并发批准/拒绝仅一方成功；相同动作重放无二次冻结；争议竞争；提交后进程退出仍由 worker 执行；外部结果不明时不重复退现金；历史未知来源不会被误报为已证明可退。

## 7. B2：商家申请、审核、停用与恢复

### 7.1 数据模型

Merchant 保持 userId 唯一，保留 pending/active/suspended/rejected 四态；增加 lifecycleVersion（Int）、currentApplicationVersion（Int）。现有 approvedAt/approvedBy 继续作为最近一次有效激活决定的摘要，不代替历史。

新增 MerchantApplicationRevision：merchantId、version、name/description/contactEmail/contactPhone 快照、submittedAt、submittedByUserId、isLegacyBaseline。唯一 (merchantId, version)。本批只存现有申请资料，不顺带建设实名资质或银行卡收款系统。

新增 MerchantLifecycleEvent：merchantId、applicationRevisionId（审核时必填）、action、fromStatus、toStatus、reasonCode、note、actorUserId、requestKey、requestHash、versionAfter、createdAt。审核同一申请的 approve/reject 建部分唯一约束；每次命令有唯一 requestKey。事件保留决定快照，不能靠解析 AdminLog 中文拼回审核历史。

### 7.2 状态转换

| 来源 | 动作与资格 | 目标 |
| --- | --- | --- |
| 无 Merchant | 活跃普通用户提交申请，邮箱验证遵守现有开关 | pending，创建 Merchant 及申请版本 1 |
| pending | 管理员审核当前申请版本，通过或拒绝 | active 或 rejected |
| rejected | 所有者修改后重新提交；新建申请版本 | pending，保留原拒绝决定 |
| active | 管理员说明理由停用 | suspended |
| suspended | 管理员说明恢复依据；账号有效状态允许 | active |

本批不支持 active 重新申请，不允许 suspended 借重新注册绕过恢复审核，不允许管理员账号通过申请流程覆盖自己的 admin 角色。已有异常角色组合由迁移盘点处理，不自动降级或授予权限。

### 7.3 并发与会话锁

所有改变商家资格或 User.role 的路径统一使用现有用户会话 advisory lock，再锁 Merchant 行并重读申请版本、生命周期版本、用户角色和有效封禁。对不存在 Merchant 的首次申请，用用户会话锁串行化并保留 userId 唯一约束兜底。

approve/reject 必须同时匹配 pending、currentApplicationVersion 和 lifecycleVersion；锁与 CAS 双重防止旧页面覆盖。通过、停用和恢复涉及身份上下文变化时沿用刷新令牌撤销；提交后用户重新登录。不得在锁之前读一次 pending，锁之后直接按 ID 写。

新策略下 merchant 表达已经获得商家身份，suspended 表达经营受限；新停用不再为隐藏商家页面而把 User.role 改回 user。对历史 suspended+user 组合，先通过“当前用户是否拥有该 Merchant”判定有限只读资格，恢复时再受控设置 merchant 角色，不在数据回填中批量升权。

### 7.4 权限与存量交易

将现有一刀切 requireMerchant 拆成所有者上下文与动作能力两层。路由、服务与前端都使用后端能力词表，不以 JWT 中的 role 单独判断。

| 能力 | pending/rejected | active | suspended |
| --- | --- | --- | --- |
| 查看本人申请与决定 | 允许 | 允许 | 允许 |
| 修改后再次提交 | 仅 rejected | 禁止 | 禁止 |
| 查看历史订单、结算与财务 | 如存在历史关系可只读 | 允许 | 允许 |
| 发布商品、导入库存、新建配置、发起营销 | 禁止 | 允许 | 禁止 |
| 接新单/开始尚未接单订单 | 禁止 | 允许 | 禁止 |
| 处理已经 processing 的人工单 | 禁止 | 允许 | 允许受限交付、进度与明确失败处置 |
| 拒绝未接单旧单、回应既有争议 | 禁止 | 允许 | 允许受限动作；退款仍走原协调器 |

账号有效封禁时，上表商家能力全部不授予，管理员负责存量处置。恢复商家不能解封账号或解除支付限制。停用不自动取消、退款或撤销外部权益；已有供应商任务继续按原任务协议收敛，未知结果进入既有核对队列。

购买事务中对 Merchant 取得共享行锁并在扣款前复核 active；停用取得排他锁。允许已通过锁内检查的交易先完成，停用提交后新的购买检查不能再通过。停用事务不反向锁 Product；缓存失效在提交后完成，购买资格始终由数据库复核。

历史只读范围仅含上述订单、结算、财务及已列明的库存批次/规格追溯；不包括商品经营配置列表或独立 dashboard 报表路由。停用商家前端默认进入订单，需扩大读取范围时先单独定义 DTO 和能力，不直接放开全部 GET。

### 7.5 接口

新增 GET /api/merchant/application、POST /api/merchant/application/resubmit、GET /api/admin/merchants/:id/history、POST /api/admin/merchants/:id/restore。旧 /merchant/register、approve、reject、suspend 保留，内部委托新命令。

成功登录与 GET /api/auth/me（以现有认证路由实际挂载为准）的用户 DTO 增量返回 merchantCapabilities、merchantStatus 与 merchantLifecycleVersion；申请查询返回同一能力词表。能力由当前数据库事实生成，不从过期 JWT 角色推导。新前端据此保留停用商家的历史入口；旧字段继续兼容。

新审核请求携带 expectedLifecycleVersion 与 applicationVersion；旧接口未携带时由服务在锁内作用于当前 pending 申请，仍只有一个决定成功，但不承诺旧页面的内容版本一致。新前端必须带版本。所有变更使用 Idempotency-Key；旧客户端缺失时由兼容适配器按实体和当前版本生成领域键，不用随机键冒充可重放保证。

## 8. B3：结构化封禁与管理员权限

### 8.1 封禁记录与到期语义

新增 AccountBan：UUID id、userId、version（Int，默认 0）、reasonCode、reason、startsAt、expiresAt（null 为长期）、createdByUserId、source（admin/legacy）、releasedAt、releasedByUserId、releaseReason、createdAt。未释放记录按 userId 建部分唯一索引（releasedAt IS NULL，不使用依赖当前时间的索引谓词）；已过期但尚未扫尾的记录必须先在用户锁内收尾，不能因唯一索引拒绝新的合法封禁。释放请求携带 expectedVersion，锁内 CAS 更新 releasedAt 等字段并递增 version；只提供立即生效的封禁，不在本批引入预约封禁调度。

User.status 规范为 active/banned，作为受 accountGovernance 管理的状态投影；有效封禁以未释放且未到期的 AccountBan 为准。统一有效状态 helper 和数据库过滤构造器。实施时鉴权改为直接读取当前数据库事实，确保其他实例写入封禁或撤销会话后立即生效；旧进程内状态缓存不再作为鉴权依据。若以后引入共享缓存，必须验证跨实例失效并限制 TTL 不跨越到期时刻；服务、SQL 列表过滤、登录和 SSE 资格都不能继续各自比较中文字面值。定时任务只完成到期投影和历史收尾，解封生效不能依赖 cron 及时执行。

ban/unban 在用户会话锁内复核当前记录，创建/释放结构化封禁、更新 User 投影、撤销会话并写成功审计。手动解封必须带理由。用户仍需重新登录；封禁到期不复活已撤销令牌。已有禁止封禁自己和管理员的保护保留。

历史 banned 用户回填一条 source=legacy 记录，createdBy、原始 startsAt 和原始理由无法可靠确认时允许为空，并显示未知；迁移观察时间另记 createdAt。不要把迁移时间伪造成真实封禁时间，不从模糊中文日志中猜决定人。AccountRestriction 继续只负责支付争议等分域限制，解封不删除它。

### 8.2 最小管理员授权模型

保留 User.role=user/merchant/admin；admin 表示管理员身份，权限由独立模型决定。新增 AdminAuthorization（userId 主键、tier=super/operator、version、updatedAt），以及 AdminPermissionGrant（userId、permissionCode、grantedBy、grantedAt、revokedAt、reason）。同一用户同一权限只允许一条有效 grant。

已有管理员初始化为 super，保持现有合法访问；新建 operator 默认没有权限，缺少授权记录默认拒绝。首次上线完成超级管理员名单盘点，不凭环境中的邮箱通配授予。授权配置由 super 专用接口/CLI 处理；本批前端不强制建设复杂角色编辑器。

权限按动作分组，至少包含 users.read、users.ban、points.read、points.adjust、merchants.read、merchants.review、merchants.suspend、catalog.read、catalog.write、inventory.manage、orders.read、orders.delivery.read、orders.resolve、orders.after_sales.execute、settlements.read、settlements.execute、payments.read、payments.refunds.review、payments.disputes.resolve、audit.read、audit.details.read、exports.create、wallet.integrity.read、settings.manage、admin.permissions.manage。其他既有营销、公告、文件、备份、AI、视频管理路由必须逐条映射受控权限，不能留一个“未迁移则 admin 全开”的兜底。

super 管理授权不允许删除最后一名有效 super；多管理员变更用独立授权配置锁串行化。权限不永久写入 JWT；每次敏感请求读取当前授权，撤销提交后新请求立即生效。已经完成鉴权的在途请求可按原授权完成，记录操作者；不宣称权限撤销可以撤回已经提交的事务。

路由保护范围要枚举实际挂载，而不是只修改 admin/routes.ts：独立营销、陈列、权益、CMI router，视频管理、上传与签名发放的 admin 分支，备份恢复及其他管理入口均纳入。私密交付内容与普通订单读取分权限。

提供 GET /api/admin/capabilities，返回 contractVersion、permissions、features、limits。页面隐藏只是体验；后端权限不足统一返回 403 PERMISSION_DENIED。super 专用授权动作也留成功审计，不开放管理员自助扩大权限。

### 8.3 审计详情

保留现有审计列表返回结构，新增 GET /api/admin/audit/:id。新增审计写入逐步采用 actionCode、detailSchemaVersion、detailSafe、requestId；现有 action/detail 保留兼容。新详情由按 actionCode 注册的白名单序列化器产生，不能直接把任意旧 detail 原文透传。

封禁与商家审核等旧记录，可在识别明确格式且确认无敏感字段时返回必要的理由摘要；无法安全解析的记录标记 legacy_detail_unavailable。密码、验证码、MFA、卡密、交付原文、表单答案、支付原始响应不进入通用审计详情。无需为“看详情”扩大到所有秘密。

顺手修正本批触及的非原子写入点，例如商家抽成调整与售后案件创建：状态成功和成功审计必须同事务。支付请求尝试日志明确使用 requested/attempted，不当成完成凭证。

## 9. B4：用户详情与列表读模型

### 9.1 查询结构

不创建 User360 主表，不在 User 上存订单总数、累计消费、风险分数和所有会话摘要。列表只返回可用的轻量信息；详情概览和大列表分开加载。

新增用户详情概览 GET /api/admin/users/:id，返回基本身份、邮箱验证、有效账号状态、当前封禁摘要、商家状态、账户可用/冻结与来源摘要、订单统计、邀请摘要和时间精度信息。各分区接口独立分页：orders、point-logs、sessions、referrals、security-events、audit。不存在用户返回 404；无分区权限不查询对应敏感数据。

lastLoginAt 新增于 User，仅成功密码/MFA 登录完成时更新，不把 refresh、普通 API 请求或注册写成一次登录。旧值保留 null，不用 createdAt 伪造。已有 RefreshToken.lastUsedAt 展示为最近会话使用时间；UserActiveDay 展示为最后活跃自然日，两者不能都命名为精确最后活跃时间。

### 9.2 统计口径

| 字段 | 口径 |
| --- | --- |
| orderCount | 实际商城订单数量，充值单另计 |
| chargedPoints | 订单实际消费/捕获的积分；冻结未捕获不算已消费 |
| refundedPoints | 原订单退款与执行成功售后退款，按唯一钱包凭证去重 |
| netSpentPoints | chargedPoints 减 refundedPoints；不能只排除 Order.status=refunded，因为售后订单仍为 closed |
| walletAvailable / walletFrozen | 当前 PointAccount 投影，不等同累计消费或收益 |
| legacyCompleteness | 指明历史扣款/退款来源是否可证明；不把未知直接计成 0 或充值 |

统计优先复用 wallet、orders、merchantFinance 的权威查询。先固定实际凭证口径，再选择聚合 SQL；严禁在前端用列表当前页累加。不同分区显示各自 asOf，概览用短只读一致性事务保证该响应内部一致，不承诺整个页面多次请求处于同一快照。

### 9.3 用户列表

保留 page/pageSize，增加 accountStatus、role、merchantStatus、emailVerified、registeredFrom/To、lastLoginFrom/To、sort、q。排序白名单为 createdAt、lastLoginAt、orderCount、netSpentPoints，固定以 id 做次排序，null 明确置后。

q 可明确识别 UID 与规范化邮箱做精确检索；保留现有邮箱/商家名模糊搜索并补昵称。派生字段排序先使用受限的数据库聚合，提供时间范围和页大小上限，禁止每个用户分别查询一遍订单。数据不足以支撑既定预算时，先优化该查询；不能悄悄按创建时间排序却返回“按消费排序”。

索引按实际 where/order 组合确定，至少补 User(createdAt,id)、User(lastLoginAt,id) 和用户订单时间检索索引。模糊搜索的 pg_trgm 仅在隔离环境查询计划证明需要且扩展可用时纳入该后端 PR；否则保留受限搜索并记录规模阈值，不强制引入新服务。

## 10. B5：业务编号、状态与更新时间

### 10.1 编号格式

| 实体 | 字段 | 格式 |
| --- | --- | --- |
| 商城 Order | orderNo | MN20261112-7K3QX9PA2D6F |
| SettlementBatch | batchNo | MNSB20261112-7K3QX9PA2D6F |
| OrderAfterSalesCase | caseNo | MNAS20261112-7K3QX9PA2D6F |

日期按创建时间转换为 Asia/Shanghai 后确定；随机段为 12 位 Crockford Base32，使用加密安全随机数，数据库各字段唯一。编号创建后不可修改；唯一冲突有限重试，只重试该编号唯一键冲突，不重试任意 P2002。回填用原 createdAt 的上海日期，不能用回填当天日期。

应用更新 DTO 不接受编号；数据库触发器只允许编号从 null 首次赋值，已有非空值发生改变（含置空）时拒绝。该规则覆盖手写 SQL 与回填脚本，触发器和 updatedAt 触发器分别命名，不能让普通更新时间维护绕开编号不可变约束。

新订单在原创建事务中生成编号。若编号冲突需要重跑数据库事务，只重复无网络副作用的本地步骤，沿用原下单意图与 prepared 输入并重新校验资格；不得重发外部开通或支付请求。保留内部 id、外键和数字路径，新增按业务编号精确搜索，不对业务编号做数值转换。

读接口增量返回编号；通知、邮件、导出中的人类可见引用使用编号，deeplink 和历史幂等键继续使用原 id。Faka 的 externalOrderNo 等供应商引用不能随商城编号一起重写。历史已发送消息不批量改正文，历史新读页面可关联展示 orderNo。

### 10.2 状态规范

User.status 存 active/banned；User.role 存 user/merchant/admin；Merchant.status 保留四态。Order.status 统一使用 statusPolicy.ts 的六态，存量 completed 按已有 normalizeOrderStatus 语义迁移为 delivered。所有状态更新仍通过领域命令及 CAS，CHECK 只保证词表合法，不代替状态转换校验。

原中文用户 API status 保留兼容输出，新增 accountStatus 为英文有效状态；新前端只消费 accountStatus。认证登录、/me、后台列表等所有序列化入口使用同一个兼容映射。新端点直接使用英文状态和 labelCode；服务与 SQL 中移除散落的中文比较。

迁移先只读盘点所有 distinct 状态与角色，遇到未知值先输出例外清单，不替换为 active。Product、Offer 等已有 CHECK 不重复创建或缩窄，只修确有缺口。测试包括直接 SQL 非法写入被拒绝、旧 completed 兼容和所有应用写入入口。

### 10.3 更新时间

对 User、Order、Product、Offer、Settlement、DeliveryRecord、Review 增加 updatedAt，并维护原生 SQL 写入。采用数据库触发器作为最终兜底，Prisma @updatedAt 可保留客户端便利；测试 raw SQL、Prisma 更新与 cron 更新都推进时间。使用一致的 UTC 时刻语义，本批不顺带改变旧 createdAt 的类型和历史时区解释。

存量初始化为迁移观察时刻，明确这是开始可靠记录的基线，不代表真实历史最后修改时间。记录 cutoverAt；增量导出或同步只能在该基线之后使用 updatedAt。不可变 WalletOperation、WalletAllocation、审计事实不为了统一外观添加可修改时间。

## 11. B6：库存批次与规格修订

### 11.1 逐件库存批次

新增 InventoryBatch：UUID id、productId、offerId、merchantId（平台商品可空）、actorUserId、importedCount、createdAt。InventoryItem 增加可空 batchId 外键；新导入强制非空，旧库存为 null。导入事务先创建批次，再 createMany 条目并写同一个 batchId 的 InventoryLog；所有变动同事务，不改变敏感库存内容的访问边界。

新增批次列表与详情查询，只返回数量、状态统计、操作人、时间与已售订单的授权引用，不返回卡密内容。可按批次对仍 available 的条目执行作废；已 sold 的条目保留，通过订单售后处理，不能因批次作废自动回滚销量、扣款或交付。

批次作废使用条件更新，既有领取逻辑继续只领取 available。与销售竞争时，每个条目只能由销售或作废一方成功改变状态，日志记录实际作废数。批次不是一个覆盖 sold 状态的总开关，不在作废事务中持有批次锁后逐个反锁订单。

历史 InventoryLog.batchId 仅证明一次汇总导入，不足以分配每条旧库存。旧数据提供汇总日志入口并标注“逐件关联未知”，不靠 createdAt 接近或内容比较猜归属。

### 11.2 规格商业配置修订

Offer 增加 commercialRevision；新增 OfferCommercialRevision，记录 offerId、revision、actorType、actorUserId、sourceRef、reasonCode、beforeSafe、afterSafe、changedFields、createdAt，唯一 (offerId, revision)。只记录价格、原价、有效期、状态、履约类型、库存模式和非秘密绑定标识等白名单；不记录固定交付内容、表单答案或供应商密钥。

将记录函数嵌入所有权威 Offer 写路径：商家规格编辑、管理员编辑、商品级兼容写、V2 创建/更新、供应商目录同步及默认规格变更。复用已有 Product 行锁与 checkoutVersion CAS，不增加另一套并发版本替代它。库存销售造成的 stock/sales 高频变动不产生商业修订；价格相同的重复保存不产生噪声。

历史规格可建立 migration_baseline 快照，明确变更前值未知；不能将基线误写成真实商家改价。修订记录与实际配置更新同事务，列表按 offerId/revision 游标读取。

## 12. B7：异步导出与资金巡检

### 12.1 导出种类与任务

固定三种导出：users、orders、point_logs。每种有独立筛选 schema、列白名单和所需读取权限；订单不导出交付内容、表单答案和供应商秘密。金额、积分、时间、编号均由后端序列化，CSV 对以 =、+、-、@ 及控制字符开头的外部文本做电子表格公式注入防护；真实数值列保持明确的数值语义。

新增 AdminExportJob：UUID id、kind、requestedByUserId、requestKey、requestHash、filters、columnVersion、status、phase、snapshotAt、rowCount、byteSize、sha256、providerConfigId、objectKey、leaseToken、leaseUntil、attempts、nextAttemptAt、errorCode、createdAt、completedAt、expiresAt。状态为 queued/running/succeeded/failed/expired；phase 区分 materializing/uploading。唯一 (requestedByUserId, requestKey)。

新增 AdminExportRow：jobId、rowNumber、payloadSafe，主键 (jobId,rowNumber)，随导出到期清理。它是短期报告快照，不是长期业务权威。初始上限每任务 100,000 行、128 MiB、每管理员一个活动任务、全局两个执行任务；参数由受控配置给出，不能通过 pageSize 绕过。

### 12.2 一致性与恢复

worker 开始时再次核查当前管理员、MFA 会话资格所对应的有效授权及该种导出的读取权限；用户被封禁或失去权限则失败结束，不继续生成。后台任务不要求把原访问令牌或 MFA 秘密存库；创建时保存可审计的会话引用，执行按当前授权与既定任务授权策略复核。

物化阶段在一个短 REPEATABLE READ 事务内用固定查询 INSERT…SELECT 生成脱敏行并记录 snapshotAt，限制行数与 statement_timeout（初始 30 秒）。超限或超时回滚并返回明确失败，不偷偷截断为完整报告。该时间是 worker 开始物化时刻，不是点击导出时刻。

物化完成与 phase 更新同事务提交。上传阶段按 rowNumber 游标从物化行流式生成 CSV，使用现有私有存储 putStream；不在上传期间持有快照事务。崩溃重试复用已提交的物化行，不重新读取可能变化的业务数据，从而保持该任务的同一快照。

任务认领、完成均使用租约 token CAS；过期 worker 不能把旧结果标为新任务成功。对象键包含 jobId 和执行 token，防止迟到上传覆盖有效文件；最终登记对象与任务成功同一数据库事务。上传完成但登记失败产生的孤儿对象由命名空间 GC 清理。

### 12.3 存储、下载与到期

复用 getWriteDeliveryStorage/getReadDeliveryStorage 的私有适配器和 StoredObject 登记，将 source 扩展为 admin_export。固定 providerConfigId，切换存储后旧导出仍按原提供商读取；不把导出伪装成商品 DeliveryFile。

现有 StoredObject.sourceId 为数字，不能把 UUID jobId 强转为数字：本批 sourceId 留 null，通过 job.providerConfigId/objectKey 关联并校验登记对象，jobId 保留在受控对象键中。GC 使用这一明确关系判断存活；若另行扩展类型化来源引用，必须同时更新注册、读取和 GC，不能只改写入类型。

扩展现有私有存储 GC 的保活判断：必须识别 admin-exports/ 命名空间、有效 ExportJob 和到期状态，不能只查 DeliveryFile 后删除有效导出。不要将 CSV 强行声明为视频 MIME；现有 putStream 的 MIME 联合需安全扩展或保留 attachment/octet-stream。

GET /api/admin/exports/:id 仅返回任务摘要，不长期存放已签名 URL；POST /api/admin/exports/:id/download 在每次请求时重新检查创建者或 super、当前权限和 expiresAt，再签发最长 60 秒的下载 URL。签名一旦发出在有效期内属于短期持有者凭证，权限撤销不能保证立刻撤回已发 URL；需要更严格即时撤销时使用认证代理下载，不作虚假承诺。

导出文件、物化行默认保留完成后 24 小时；失败任务的临时数据也有清理期限。清理幂等，删除对象后更新任务并清理物化行，元数据与审计保留。生产没有可用私有存储时明确 EXPORT_STORAGE_UNAVAILABLE，不能回退公开桶或仅进程内内存存储后宣称任务可恢复。

### 12.4 余额来源巡检

复用 findWalletInvariantViolations 的单查询守恒逻辑，扩展为按 userId 分块扫描，不直接把当前仅返回 100 条异常的函数当作完整巡检。新增 WalletIntegrityScanRun（范围上界、游标、覆盖数量、状态、起止时间、失败码）和 WalletIntegrityIssue（用户、类型、余额/来源差异快照、首次/最近发现、最后验证、处理状态）。

每次扫描固定账户上界，用确定性游标分批。单批在同一 MVCC 查询中比较账户与来源，避免先读余额、另一次读来源产生假差异。使用 cronLease；中断后从检查点恢复。初始每小时扫描、每批 500 个账户，记录实际覆盖时间与积压，不宣称扫描开始时全库一致快照。

管理员可以查看、备注、触发重扫；“标记已看”不等于已修复，只有复查该账户无差异才能标为 resolved。系统不自动调账、改 lot 或清零冻结。与既有支付对账的渠道差异队列分开，避免两种对账混用。

新增低基数指标：退款人工审核数量和最老年龄、导出积压/失败、巡检最后成功时间和未解决差异数。复用 lib/backgroundAlerts.ts 及告警路由文件；指标 label 不放 userId、订单号或邮件。守恒差异立即告警，巡检连续两轮未完成告警；人工审核超 24 小时告警为初始运营阈值，可配置。

## 13. API 契约与前后端联调

### 13.1 公共规则

沿用现有错误形状：`{ requestId?, error: { code, message, details? } }`。新增 409 错误码至少包括 STATE_CONFLICT、APPLICATION_VERSION_CHANGED、REFUND_SOURCE_INSUFFICIENT、LEGACY_SOURCE_UNPROVEN、RECONCILIATION_REQUIRED、IDEMPOTENCY_KEY_REUSED；403 为 PERMISSION_DENIED，导出过量为 EXPORT_LIMIT_EXCEEDED。不能为业务冲突返回需要自动刷新令牌的 401。

新管理命令使用 Idempotency-Key（UUID 或受控 1–128 字符键）；相同键同参数重放原成功结果，不同参数拒绝。摘要覆盖动作、目标、期望版本和所有会影响决定的字段；不得把未保存的失败尝试假装成成功重放。分页使用带筛选摘要和排序信息的不透明 cursor，服务端限制 pageSize，稳定 (createdAt,id) 或明确实体主键排序。

allowedActions 描述当前身份与当前事实允许的操作；blockers 返回稳定 code 与可显示 message。它们是即时预览，执行时必须重新检查。前端不能因为看到 execute 就跳过版本或执行前复核，也不能把网络失败显示为处理成功。

### 13.2 接口清单

| 路径（均为 /api 前缀） | 方法 | 主要契约/权限 |
| --- | --- | --- |
| /admin/capabilities | GET | contractVersion=governance-v1、permissions、features、limits；管理员+MFA |
| /admin/recharge/refunds/:id | GET | 原退款、来源资格、审核历史、版本、allowedActions；payments.read |
| /admin/recharge/refunds/:id/review | POST | action=resume/reject、expectedReviewVersion、理由；payments.refunds.review |
| /merchant/application | GET | 本人申请版本、决定、状态与允许动作；有效普通用户 |
| /merchant/application/resubmit | POST | 申请资料、expectedLifecycleVersion；被拒申请所有者 |
| /admin/merchants/:id/history | GET | 申请版本与决定时间线；merchants.read |
| /admin/merchants/:id/restore | POST | 版本、理由、恢复证据；merchants.suspend |
| /admin/users | GET | 保留旧分页，增量筛选与排序；users.read |
| /admin/users/:id | GET | 概览及各区可见性；users.read，资产字段额外 points.read |
| /admin/users/:id/orders | GET | 游标、订单编号、真实积分消费摘要；orders.read |
| /admin/users/:id/point-logs | GET | 游标、钱包凭证与来源；points.read |
| /admin/users/:id/sessions | GET | 脱敏会话，不返回 token/raw IP；users.read |
| /admin/users/:id/referrals | GET | 邀请关系与资格摘要；users.read |
| /admin/users/:id/security-events | GET | 脱敏安全事实；audit.details.read |
| /admin/users/:id/audit | GET | 用户直接相关的授权审计；audit.read |
| /admin/users/:id/bans | GET/POST | 封禁历史/创建，expiresAt 可空；users.ban |
| /admin/users/:id/bans/:banId/release | POST | 版本、解封理由；users.ban |
| /admin/audit/:id | GET | 安全 detail DTO；audit.details.read |
| /merchant/products/:id/inventory/batches | GET | 归属内批次摘要；商家读取能力 |
| /merchant/products/:id/inventory/batches/:batchId | GET | 归属内批次详情，无卡密；商家读取能力 |
| /merchant/products/:id/inventory/batches/:batchId/void | POST | 仅可用库存，理由、幂等；商家库存写能力 |
| /admin/products/:id/inventory/batches（含详情/void） | GET/POST | 平台/授权库存治理；inventory.manage |
| /merchant/products/:id/offers/:offerId/revisions | GET | 商家归属、游标、商业配置白名单 |
| /admin/products/:id/offers/:offerId/revisions | GET | 商业修订历史；catalog.read |
| /admin/exports | POST/GET | 固定 kind/filters、幂等；exports.create+种类读取权限 |
| /admin/exports/:id | GET | 本人或 super、当前权限；任务摘要 |
| /admin/exports/:id/download | POST | 当前授权、未过期、短期签名 |
| /admin/wallet-integrity/runs、/issues | GET | 分页覆盖与差异；wallet.integrity.read |
| /admin/wallet-integrity/issues/:id/recheck | POST | 幂等重扫，无自动调账 |

现有用户 ban/unban、商家 approve/reject/suspend 作为兼容适配器保留，不能继续有第二套写状态实现。super 授权配置提供 GET/PUT /admin/authorizations/:userId，单独校验 admin.permissions.manage 与 super 身份。

### 13.3 最小响应形状

```json
{
  "id": "refund-uuid",
  "status": "manual_review",
  "reviewVersion": 2,
  "qualification": { "sourceKind": "recharge", "requiredPoints": "1000", "availablePoints": "600", "asOf": "2026-11-12T08:00:00.000Z" },
  "allowedActions": ["reject"],
  "blockers": [{ "code": "REFUND_SOURCE_INSUFFICIENT", "message": "原充值来源积分不足，暂不能恢复退款" }]
}
```

以上为契约示意，不是运行输出；金额字段沿用充值模块字符串序列化。其他平台积分字段沿用当前安全整数约定，不为了统一外观在同一批里改掉全部客户端数字类型。

后端在 docs/api/governance-v1/ 提供至少以下脱敏夹具：无权限管理员、可审核退款、来源不足退款、历史未知来源、驳回可重提商家、停用只读商家、有效封禁用户、历史统计不完整用户、导出各状态、巡检差异。OpenAPI 和夹具在实现前提交；前端不得把本方案的字段示意当作任意扩展接口的许可。

## 14. 迁移、回填与发布

### 14.1 只读盘点

后端实现一个本批专用治理迁移 CLI，支持 preflight/backfill/finalize/verify、dry-run、batch-size、resume-after-id、report。报告不包含秘密、卡密、密码或 token。主要盘点：未知角色/状态、completed 订单、缺失编号、Merchant 与 User 角色不一致、旧封禁、原充值来源可证明性、库存历史关联缺失、旧管理员列表、钱包守恒差异及导出存储可用性。

遇到未知状态、无法解释的管理员身份或资金差异，不自动修成“正常”。输出具体例外及处理建议；可先部署只读能力，但相关状态切换不能在例外未处理时强行继续。

### 14.2 同一后端 PR 内的迁移阶段

| 阶段 | 数据库/代码操作 | 安全控制 |
| --- | --- | --- |
| M0 扩展 | 新表、可空编号字段、新元数据、时间戳、索引 | 与旧代码兼容；大表索引使用适用的 CONCURRENTLY 路径，不能被外层事务包住 |
| M1 准备 | 新版本构建、兼容 DTO、迁移 dry-run、脱敏报告 | 未改变真实资金开关；确认旧进程和 cron 全部可识别 |
| M2 切换 | 短维护窗口，停止旧版本写入/worker；部署新后端；规范状态和封禁记录 | 禁止旧后端与英文状态混跑；保留访问窗口及回调补偿范围记录 |
| M3 回填 | 分批编号、申请基线、更新时间基线、管理员授权、必要角色例外修复 | 每批短事务；WHERE 字段 IS NULL/版本条件；已生成编号不可重写；管理员授权及封禁基线完成并验证后才开放相关访问 |
| M4 收紧 | 无空编号与无非法状态后验证 CHECK、完整外键和唯一约束 | finalize 有先决检查，失败停止收紧；不删除原主键和兼容 DTO |
| M5 启用 | 巡检、审核、导出与新页面逐步开放 | 看真实覆盖、积压和差异；前端合并前后分别跑兼容旅程 |

Prisma deploy 默认会执行所有 pending migration，因此不能把“依赖人工回填”的最终 NOT NULL 混在无条件部署序列里。编号在 Prisma 中本批可暂保留 String? 表达迁移窗口；回填后通过版本化 post-deploy SQL 添加并验证非空 CHECK，SQL 与执行报告随本批维护，数据库最终拒绝新空值。已有项目手写 CHECK/部分索引的管理方式继续适用。若采用定制部署分段机制，必须先证明它能在最终约束前执行回填，不能靠运行顺序口头约定。

旧版本无法正确识别英文 banned，属于明确安全回滚边界。M2 必须停止旧 API、worker 和独立脚本写入；滚动混跑不在本方案支持范围。前端无需同时维护窗口，因为旧 API DTO 仍兼容。窗口内支付回调失败不能假定所有渠道都重试，恢复后按记录范围执行既有渠道查询和对账补偿。

### 14.3 回填规则

编号按 id keyset 每批初始 1,000 条，记录检查点；同一字段已非空则跳过。新写入已经生成编号，因此回填仅处理历史空值。唯一索引先兜底，随机冲突重新生成但不更改已成功编号。

商家申请历史只为当前资料创建 isLegacyBaseline 版本；旧 active/rejected/suspended 的原决定缺失就标注未知，不伪造审核时间线。旧封禁 createdBy 与 reason 可空。规格历史基线同样明确不是实际改价事件。旧库存不根据日志数量回填条目批次。

更新时间以 cutoverAt 的观察基线初始化；验证 raw SQL 维护。旧审计 detail 不批量解析后覆盖原文，只在安全详情读模型中做受控摘要。任何历史修正均不能重发积分、结算或现金退款。

### 14.4 回滚

优先关闭新 UI 能力和导出/审核入口，保持已产生新资金记录所需的钱包兼容代码。数据库以增量迁移为主，不通过 DROP 新表回滚。新版业务事件产生后，不能回退到不认识新状态与权限规则的旧后端继续写入。

发布前准备同样识别英文状态、封禁投影和新事件的兼容后端产物作为软件回退目标；新功能可关闭，但不能关闭新的身份判断。若必须恢复数据库快照，另列恢复点之后支付事件、退款、结算和导出任务的对齐步骤，不能只恢复一张余额表。

## 15. 锁顺序、幂等与失败恢复

本批按用例保留不同业务根，不能用一句“统一先锁 User”替代项目已有锁图。

| 用例 | 顺序/边界 |
| --- | --- |
| 充值审核 | RechargeOrder → RechargeRefund → 原信用/hold等从属记录 → PointAccount → lot |
| 支付争议 | 保留 RechargeOrder → Dispute → RecoveryCase → PointAccount；同订单锁下重新查退款 |
| 商家身份生命周期 | 用户会话 advisory lock → Merchant → 当前申请/事件约束 → User 身份更新；不调 wallet |
| 新下单商家资格 | 保留 Product/Offer 锁；Merchant 共享锁复核 → 新订单与账户动作；停用不反锁 Product |
| 封禁/解封 | 用户会话 advisory lock → 用户与封禁记录；不跨入订单或结算 |
| 结算/售后 | 沿用现有 Order → Settlement/Case → Merchant → 排序后账户 → lot |
| 导出 | 任务租约/任务行；业务只读快照事务与外部上传分离 |
| 库存作废 | 批次归属读/必要锁 → 条目条件更新；不反向锁已售订单 |

实现前把本批新增边加入现有锁图，并检查 auth、支付和商家财务调用的逆序边。有限数据库重试仅针对可重试死锁/序列化冲突；回调不得包含外部退款、发信或上传。CAS 失败返回当前状态与允许动作，不能用 finally 盲目清理他人接管的租约。

## 16. 测试、证据与门禁

遵守项目 testing-policy.md：领域行为用真实 PostgreSQL 集成测试，纯映射/输入契约用单元测试，跨端关键旅程复用少量现有 E2E。测试数量不设指标，以下不变量和竞争场景必须有断言证据。

| 验收号 | 关键场景 | 必须观察的结果 |
| --- | --- | --- |
| AC-01 | 原充值已消费，其他来源余额充足 | 仍不能恢复原充值退款 |
| AC-02 | 原来源经商城退款恢复后恢复执行 | 只冻结一次、只产生一份渠道退款与冲正 |
| AC-03 | 审核批准/拒绝并发，随后重放 | 一个决定生效；败方冲突；重放不二次冻结 |
| AC-04 | 退款人工处置与支付争议竞争 | 共享订单锁保护，两种资金撤销不重复 |
| AC-05 | 商家批准/拒绝并发与过期申请版本 | 只有一份决定，角色和商家状态一致 |
| AC-06 | 商家驳回、补资料、重新提交再批准 | 原 Merchant.id 不变，旧决定和所有历史关系保留 |
| AC-07 | 停用商家登录、读历史、尝试发布/接新单 | 只读/受限存量处置可用，新增经营被拒绝 |
| AC-08 | 停用与购买并发、随后恢复 | 停用提交后新资格检查不能通过；恢复不解除封禁/支付限制 |
| AC-09 | 临时封禁到期但 cron 未运行 | 有效状态按到期生效，旧撤销会话不复活 |
| AC-10 | operator 直接请求隐藏按钮对应 API | 403；独立 router、上传、交付秘密入口同样受限 |
| AC-11 | 审计写入失败 | 本地状态事务回滚；尝试日志不显示为成功 |
| AC-12 | 编号冲突、回填中断、重复执行 | 已有编号不改变；无重复；外部任务不重复创建 |
| AC-13 | 数据库直接写非法状态；raw SQL 改业务行 | 非法值被拒绝；更新时间推进 |
| AC-14 | 导入批次、销售与批次作废竞争 | 无条目同时售出和作废；已售历史不被删除 |
| AC-15 | 商家/平台/同步/兼容路径改价 | 白名单修订与配置同事务；无敏感内容；相同值不记噪声 |
| AC-16 | 用户存在已执行售后但 Order 仍 closed | 统计净消费扣除真实售后退款，历史未知有标记 |
| AC-17 | 导出物化后修改业务数据、进程重启 | 重试使用同一物化快照；无重复/缺行；上限明确失败 |
| AC-18 | 导出权限撤销、存储切换、到期与 GC | 当前鉴权拒绝；旧提供商可读取；有效对象不被误删；过期清理 |
| AC-19 | 并发正常交易时巡检、注入已知差异 | 正常无假差异；异常被发现；仅记案件不自动改账 |
| AC-20 | 旧前端连接新后端，新前端连接无能力版本后端 | 旧契约可用；新功能明确不可用，不伪造成功 |

迁移验收包括空库完整重放、代表性旧数据升级、非法历史例外、回填恢复、约束先决失败、数据库/应用回滚边界。脱敏规模数据至少覆盖 10 万订单/流水及具有多 lot 的账户，记录版本、硬件、数据分布、EXPLAIN ANALYZE 和冷/热请求结果；不能把本地单次耗时当作生产承诺。

初始工程目标：普通用户列表/详情概览服务端 P95 500ms 内，明细 keyset 查询 P95 300ms 内，导出入队响应 500ms 内（不含实际生成）；目标在固定验证环境测量，数据与环境随证据保存。未达到则优化对应查询或明确限制，不以改 mock、删断言或放宽生产承诺冒充通过。

后端 PR 本地执行受影响集成测试、server build、test:architecture、check:architecture 和契约检查。由于涉及认证、封禁及资金关键旅程，PR 按项目规范打 run-e2e 标签，CI OK 为合并门禁。前端 PR 执行组件/类型/构建、移动浏览器和相应关键旅程联调。使用可丢弃数据库，不能在当前开发库或生产库执行清表测试。

## 17. 开发顺序与联调检查点

| 次序 | 后端产物 | 前端并行条件 |
| --- | --- | --- |
| D0 规则与契约 | 确定词表、OpenAPI、权限矩阵、脱敏夹具、错误码 | 可开始布局、客户端、状态展示和 mock |
| D1 数据与公共约束 | 增量 schema、迁移 CLI、业务编号、状态 helper、审计 serializer | 使用契约夹具，禁止依赖未落地的假字段 |
| D2 核心闭环 | 退款审核、商家生命周期、结构化封禁 | 联调每个命令的版本冲突、阻止原因和权限 |
| D3 授权与读模型 | 全入口权限映射、用户详情与列表、审计详情 | 联调导航、用户详情和分区加载 |
| D4 追溯与后台任务 | 库存批次、规格修订、导出、巡检及告警 | 联调任务状态和历史追踪 |
| D5 发布演练 | 旧库升级、回填恢复、旧前端兼容、关键旅程证据 | 对后端最终 SHA 完整联调，清理 mock 回退 |
| D6 合并 | 后端 PR 先合并；观察集成门 | 前端同步 develop 后合并自己的 PR |

内部提交可以逐步形成，但后端 PR 的最终交付必须完整包含 B1–B7。若规模超出预期，优先裁掉第 1 节明确的后续范围；如确需削减必交付项，必须改写范围和验收，不能把“建了字段”算成完整交付，也不能擅自新增第三个功能 PR。

## 18. 前端方向与交接摘要

优先扩展现有页面：AdminRefundAuditPanel 的审核详情与操作、AdminUserTable 的筛选与用户详情、商家管理的申请/决定时间线、商家申请页的状态和重提、AdminAuditPanel 的安全详情、已有库存页的批次入口。导出任务可用轻量列表或抽屉；巡检放后台财务/运维入口，不另造一套总控制台。

详情分区按权限懒加载；表单显示后端版本冲突与阻止原因。资金操作提交后显示真实后端结果，不乐观改成成功。用户和商家界面展示 orderNo；链接继续使用 id。停用商家仍应看得到历史入口和受限操作说明，不能因 RoleGuard 只认 merchant 就整页跳走。

视觉布局、组件选型、动效与响应式由前端 agent 决定，遵循现有设计系统。详细 UI 不在后端方案中定死；接口、权限、数据口径和验收边界按本文及交接书执行。

## 19. 源码定位与设计依据

下表是基线位置，实施时按符号名核对；不是运行验证证据。

| 现状/入口 | 基线文件与符号 |
| --- | --- |
| 人工退款创建、来源与执行 | server/src/modules/recharge/refund.ts：refundLotFilter、requestRechargeRefund、submitProviderRefund、applyRefundObservation |
| 退款 worker | server/src/modules/payment/workers/index.ts：processDueRefunds |
| 支付争议互斥 | server/src/modules/payment/disputes/service.ts：DISPUTE_BLOCKING_REFUND、openPaymentDispute |
| 商家申请 | server/src/modules/merchant/profileService.ts：applyForMerchant |
| 商家审核与停用 | server/src/modules/admin/merchantAdmin.ts：approveMerchant、rejectMerchant、suspendMerchant |
| 会话锁 | server/src/modules/auth/sessionService.ts：lockUserRefreshSessionMutations |
| 认证与商家守卫 | server/src/middlewares/auth.ts：requireActiveUser、requireAdminMfa、requireMerchant |
| 用户与审计列表 | server/src/modules/admin/userAdmin.ts：listUsers；auditQueries.ts：AdminLog 查询 |
| 旧状态输出 | server/src/modules/auth/sessionIssuance.ts：buildAuthUser；auth/service.ts：getUserProfile |
| 订单状态与售后 | server/src/modules/orders/statusPolicy.ts；afterSales.ts：externalBlocker、executeAfterSalesCase |
| 库存批次入口 | server/src/modules/merchant/inventoryService.ts：confirmOfferInventoryImport |
| 商家规格更新 | server/src/modules/merchant/offerService.ts：createMyOffer、updateMyOffer |
| 平台规格审计 | server/src/modules/admin/offerAdmin.ts：patchAdminOffer |
| 钱包巡检 | server/src/modules/wallet/queries.ts：findWalletInvariantViolations |
| 私有存储 | server/src/lib/storage/runtime.ts；deliveryTypes.ts；storedObjectRegistry.ts |
| 通知与后台租约 | server/src/modules/notifications/dispatcher.ts；expiryCron.ts；lib/cronLease.ts |
| 告警 | server/src/lib/backgroundAlerts.ts；docs/operations/background-alerts.rules.yml |
| 开发与测试规则 | docs/branching-and-ci.md；docs/testing-policy.md |

## 20. 实施前保留的政策输入

本方案已给出可开发的默认行为，不要求先确认每个界面或技术细节。以下仅列会影响后续启用范围的业务输入，不作为“接口尚未实现”的理由。

| 输入 | 本批默认 |
| --- | --- |
| 历史未知来源充值如何退现金 | 不扩大现有兼容范围；新增人工恢复要求原来源证明，未知进入明确案件 |
| 停用商家存量人工单是否完全由平台接管 | 默认允许有限存量处置；有效账号封禁时由平台接管 |
| 多管理员职责名单 | 已有管理员保留 super，新增 operator 显式授权；上线盘点名单 |
| 大额操作双人复核阈值 | 本批不新增审批引擎；保留权限、MFA、额度和完整审计 |
| 导出保留与规模 | 默认 24 小时、10 万行、128 MiB；受控配置，不扩为财务关账凭证 |
| 审计/账本长期保留期限 | 本批不删除经济和审计事实；只清理短期导出物化数据与文件 |

后端完成的标准是可迁移、可恢复、可授权执行并有针对性证据；前端完成的标准是准确呈现这些真实能力。两者分别交付、共同联调，不以另一个 agent 尚未接入为由留下后端业务空壳。
