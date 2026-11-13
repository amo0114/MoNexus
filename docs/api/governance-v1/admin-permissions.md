# 后台标签与动作权限（契约 1.0.3）

机器可读来源：[admin-navigation.json](admin-navigation.json)。当前后端动作词表见 permissions.json，真实授权取 GET /api/admin/capabilities.permissions。entryAllOf 全部满足才进入标签；actions 是相应子区/动作的额外检查，不能推导出其他权限。所有请求仍由服务端鉴权。

| 标签 key / 名称 | 入口必须具备 | 额外动作与分区 |
| --- | --- | --- |
| dashboard / 数据仪表盘 | catalog.read | — |
| users / 用户管理 | users.read | ban：users.ban；wallet：points.read；adjustPoints：points.adjust；orders：orders.read；audit：audit.read；auditDetails：audit.details.read；authorizations：admin.permissions.manage |
| products / 商品与库存 | catalog.read | edit：catalog.write；inventory：inventory.manage；ai：ai.manage；videos：videos.read；manageVideos：videos.manage；uploadImage：files.manage |
| orders / 订单记录 | orders.read | detail：orders.delivery.read；resolve：orders.resolve；executeAfterSales：orders.after_sales.execute；uploadDelivery：files.manage |
| logs / 积分流水 | points.read | adjust：points.adjust |
| audit / 操作审计 | audit.read | detail：audit.details.read |
| files / 文件治理 | orders.delivery.read | revoke：files.manage |
| merchants / 商家管理 | merchants.read | review：merchants.review；suspendRestore：merchants.suspend；commission：settings.manage |
| settlements / 结算管理 | settlements.read | execute：settlements.execute |
| announcements / 公告管理 | announcements.read | write：announcements.write |
| config / 系统配置 | settings.manage | ai：ai.manage |
| backup / 数据备份与恢复 | backups.manage | — |
| faka / 自动开通任务 | orders.read | retryRevoke：orders.resolve |
| abuse / 注册与激励风控 | settings.manage | — |
| storage / 对象存储 | settings.manage | — |
| merchandising / 营销与陈列 | marketing.read | write：marketing.write |
| catalogGovernance / 目录治理 | catalog.read | write：catalog.write |
| recharge / 充值支付 | payments.read | reviewRefund：payments.refunds.review；resolveDisputeRecovery：payments.disputes.resolve；otherPaymentCommands：settings.manage |
| walletIntegrity / 资金巡检 | wallet.integrity.read | recheck：wallet.integrity.read |
| exports / 导出任务 | exports.create | users：exports.create, users.read；orders：exports.create, orders.read；point_logs：exports.create, points.read |

复合界面的约束：

- dashboard：stats/reports 包含聚合统计；不得把该权限当作支付或用户明细权限。
- users：详情按 sections 懒加载；授权编辑还要求服务端当前 tier=super。
- products：写权限不隐含读取权限；库存和视频分区独立检查。
- orders：原订单详情包含交付秘密，只有 orders.read 时不得自动请求详情。
- files：GET /admin/delivery-files 及 grants 要求 orders.delivery.read；files.manage 不能代替读取权限。
- config：现有父面板挂载即 GET /admin/config，故入口仍要求 settings.manage；AI 子面板另要 ai.manage。若要支持仅 ai.manage，前端须先拆开父级配置加载。
- recharge：其他非读支付操作保留 settings.manage；按具体端点检查，不把 payments.read 当作所有操作权限。
- walletIntegrity：另检查 features.walletIntegrity。
- exports：另检查 features.exports；任务列表/下载仍按归属和当前种类读取权限验证。

用户详情的 sessions/referrals 要 users.read，订单要 orders.read，积分明细/来源要 points.read，风险事件要 audit.details.read，操作摘要要 audit.read，封禁历史及释放要 users.ban。钱包统计缺权限返回 null；按 sections 决定是否请求。

加载能力前不要推断 super；无权限面板不挂载也不后台预取，撤权后清除其 keep-alive 与当前选择。保留明确的无权限/能力不可用状态。旧后端无 capabilities 时，只按前端明确的旧版兼容策略处理，不能拿新权限词表空集推断为无限权限。
