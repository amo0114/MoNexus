# 后端治理 v1：前端协作契约

版本：`governance-v1 / 1.0.0`。基线：`develop@8da71e0`。

**契约已交付；服务实现中。此目录的 JSON 均为合成数据，不代表接口已经可调用。**

- `openapi.json`：可独立导入的 OpenAPI 3.0.3；39 个方法、61 个 schema。相同增量已合入 `docs/superpowers/specs/monexus-api-openapi.json`。
- `manifest.json`：夹具索引。每个文件带 method/path/status/schema/response；mock 返回 `response`，不要返回整个夹具包装。
- `permissions.json`：管理员权限与商家能力词表。
- 实现状态以真实 `GET /api/admin/capabilities` 为准。不存在该端点时显示新能力未提供，不能自动认为是 super。

## 前端现在可以开始的工作

1. 从 OpenAPI 建立 API 类型和客户端；mock 直接按夹具 method/path/status 返回 response。
2. 完成权限导航、用户详情分区、退款阻止原因与审核历史、商家申请状态和重提表单、导出状态展示。
3. 为 403、409、来源不足、未知历史来源及异步完成状态做组件测试。
4. 真实联调前移除成功 mock 回退，并记录实际后端提交 SHA。

## 固定约定

- 所有路径包含 `/api`，响应没有额外 `data` 包装。
- 用户列表保留 `{items,total,page,pageSize}`；新明细是 `{items,pageInfo:{nextCursor,hasNextPage},asOf}`，cursor 是不透明字符串。
- 管理接口需要当前管理员、MFA 和操作权限。`permissions` 按动作判断；`features` 是部署能力开关，不能代替权限。
- 用户 API 的 `status` 继续输出“正常/已封禁”，新界面使用 `accountStatus`；商家状态和退款状态是不同词表。
- 新命令都传 `Idempotency-Key`；同一操作超时重试复用。动作内容改变后创建新键。下载只是申请短期 URL，不要求该头。
- 退款决定提交成功后的 `points_held` 表示待执行，不能显示为现金已退。资格、可操作项和阻止原因均以后端为准。
- 版本冲突为 409，先获取当前事实，再让操作人重新决定。不能用最新版本静默提交旧决定。
- 充值金额和充值积分是十进制字符串；商城积分仍为安全整数。`netSpentPoints` 扣除已执行售后，即使 Order 仍为 closed。
- `lastLoginAt` 是成功登录时刻，`lastSessionUsedAt` 是会话使用时刻，`lastActiveDay` 只有自然日精度；null 表示未知。
- 旧数字 ID 链接不变；新增 `orderNo/batchNo/caseNo` 供显示和搜索。编号迁移窗口可能为 null。
- 导出只接受固定种类及对应筛选。users 允许 q/accountStatus/role/merchantStatus/emailVerified/from/to；orders 允许 userId/status/orderNo/from/to；point_logs 允许 userId/type/from/to。无关字段按 400 拒绝。from 包含、to 不包含，ISO 时间戳。
- 用户列表 sort 为 createdAt/lastLoginAt/orderCount/netSpentPoints，direction 为 asc/desc，默认 createdAt desc，固定 id 次排序，null 置后；注册和登录范围同样 from 包含、to 不包含。
- 导出 `snapshotAt` 是 worker 物化时刻，下载 URL 最长 60 秒；不存入 localStorage、不写日志。完成后默认保留 24 小时。
- `UserDetail.wallet/stats` 在缺少对应权限时为 null，sections 决定是否请求明细。null 不等于余额 0。
- `beforeSafe` 等修订快照只含白名单。审计旧 detail 不能安全解析时返回 legacy_detail_unavailable。

## 夹具覆盖

退款可恢复 / 来源不足 / 历史来源未知 / 审核后待执行；权限拒绝 / 版本冲突；商家被拒可重提 / 停用只读；封禁用户和历史不完整统计；安全审计；导出 queued/running/succeeded/failed/expired；巡检差异；库存批次和商业修订。

商家 approve/reject/suspend 保留原 PUT 方法，restore 新增 POST。新客户端必须传版本和理由；旧接口兼容层由后端负责。授权设置只允许 super。库存批次作废只影响 available 条目。

后端将分提交更新实际实现状态，不更改此版本既定字段语义；语义变更同时修订 OpenAPI、夹具和本说明。
