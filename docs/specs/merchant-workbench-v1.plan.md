# 商家待办与经营建议 V1：实施计划

版本：0.2.1；日期：2026-10-07。状态：PR1 后端已实现并通过本地验证，PR2/PR3 待实施。契约：[SPEC-MERCHANT-WORKBENCH-001](./merchant-workbench-v1.md)。实际检查见 [PR1 验证记录](./merchant-workbench-pr1-verification.md)，不代表已部署或完成前端验收。

## 1. 分支与协作

- 文档分支：`feat/merchant-workbench`，从本地 `develop` 的 `ffc7546` 建立。
- 工作区：`/root/projects/worktrees/monexus-merchant-workbench`。最初提交两份方案文档，当前继续实施 PR1；不混入主工作区邮件改动或其他未跟踪文件，不改 AI Agent 工作区。
- 开始实施时检查 develop 的最新变更，按仓库规范更新本分支；本记录不声称已同步远端最新提交。
- V1 不依赖 AI 分支合并，不做暂缓/指纹/偏好表/写接口，不新增工作台数据库迁移，不改 `/me` 契约。
- 后续实施拆为三个 PR：规则查询、工作台接入、试点与验收。原暂缓 PR 已删除。

## 2. PR1：只读规则查询

### 目标与文件范围

返回商家真实事项、完整紧急计数与明确截断提示；草稿只在请求其专用端点时检查。

- 新增 `server/src/modules/merchant/workbench/{schema,rules,repository,service,dto,routes}.ts`。
- `server/src/modules/merchant/routes.ts`：原权限链后挂载只读路由。
- `server/src/config/index.ts`、`.env.example`：新增关闭默认的开关。
- 不修改 `/me`；不扩充暂缓错误码、Prisma 偏好模型或事务写入。

### 实施顺序

1. 纯判定器显式传入同一个 now：`deadline < now` 超时；`now <= deadline <= now+24h` 临期；等于 now 显示“已到截止时刻”。
2. 库存聚合和 SLA 查询全部服务端限定商家归属；即时库存只数 available 条目，不读交付内容。
3. GET urgent：只查询 SLA 和售罄，每组最多 200 条，另取完整计数。该路径禁止调用 readiness，包括间接调用。
4. GET availability：低库存及售罄最多 200 条，无 keyset 分页；返回 matchedTotal、truncated。
5. GET drafts：beforeProductId 简单游标，每次最多检查 20 个、并发上限 4；多读一个候选判断 hasMore。显式输出失败 ID，单项重验不推进整个批次。
6. readiness 使用与发布一致的默认参数 `requireCurrentlySellable=true`。逐项实现 Spec §8.1 的导航映射；OFFER_NOT_SELLABLE 复用原规格评估逻辑区分库存/配置/无启用规格，禁止解析 reason。
7. GET 单事项：鉴权、归属、match/clear/unknown/ineligible 与资源 404；不写已处理状态。
8. DTO 白名单、部分失败及开关 404；所有新端点都保持只读。

### 截止时间与原始 SQL

`Order.fulfillmentDeadline` 为 UTC 约定的 timestamp without time zone。优先 Prisma 查询构造器。若使用原始 SQL，遵照 `server/src/modules/merchandising/ranking/compute.ts`，将绑定 Date 显式转换为 UTC 无时区时间戳：

```sql
"fulfillmentDeadline" < (${now}::timestamptz AT TIME ZONE 'UTC')
```

这是参数化模板示意，严禁拼接时间字符串。临期上下界做同样转换。集成测试在同一事务/连接中分别 SET LOCAL TIME ZONE 为 UTC、Asia/Shanghai，断言相同 now 和数据得到相同匹配结果，尤其覆盖截止瞬间及毫秒两侧；事务结束恢复设置。

### 必须通过

- Spec AC01–AC07、AC10、AC13–AC14 后端部分。
- 25 个草稿、空 deadline、多规格、外部集成、201 个 SLA/库存匹配项。
- matchedTotal 不能由截断后的数组长度计算；任一紧急分组查询失败不能伪报完整总数。
- repeated urgent 请求对 readiness 的调用数为 0；只选择安全字段，无库存 N+1。
- 无工作台迁移；如测量发现需要索引，另以 EXPLAIN 和实际负载证据评审，不能借此恢复原偏好表设计。

## 3. PR2：商家工作台与导航

### 修改范围

- 新增 `src/api/merchant/workbench.ts`、`src/components/merchant/workbench/`、`src/pages/merchant/WorkbenchPage.tsx`。
- `src/App.tsx`、`src/pages/MerchantDashboardPage.tsx`、`src/pages/merchant/Dashboard.tsx`：路由及同一摘要组件。
- `MerchantAvailabilityModal.tsx` 和下游规格选择器：initialOfferId 精确定位，不回退到错误的默认规格。
- `ProductEditPage.tsx`：封闭 focus 枚举映射 publication/images/purchase-notes/after-sales/attributes/offers/category；offerId 校验与无效目标回退。

### 实施顺序

1. 先请求 urgent 探测；集合端点 404 隐藏入口。200 后请求 availability 和第一批 drafts。不改 `/me`，不加前端独立开关。
2. 首页紧急前 3、普通前 5；完整列表库存/SLA 每组最多 200，超限显示完整数量与原管理页入口。只有草稿有继续检查按钮。
3. 首次、焦点（每组至少间隔 30 秒）、手动刷新加载相应数据；可见时 60 秒定时器只刷新 urgent。
4. 单页共享状态/请求；切会话清空、旧批次响应丢弃、失焦停止定时器。多标签页不做跨页协调，但都不能轮询草稿。
5. 各组独立更新时间；新 urgent 结果按 key 更新售罄并移除普通区重复项，不伪造普通组刷新时间。
6. 主要动作和逐缺项定位链接按 Spec §8.1；CATEGORY_INACTIVE 只提示更换分类或联系平台。
7. 库存目标按 ID 获取，不能依赖当前列表页；关闭清理本功能查询参数。原操作成功后刷新紧急和相关数据；草稿只重验目标产品。

### 必须通过

- AC08：模拟多个 60 秒 tick，确认只调用 urgent，草稿调用次数不增加；焦点/继续检查/手动/操作返回独立验证。
- 200 条上限、草稿覆盖提示、局部失败、空状态、注销和旧响应处理。
- 集合 404 隐藏功能；单事项 404 不关闭模块；401/403、网络错误和 5xx 不混同关闭开关。可用性不永久缓存，后续进入或有效焦点可重探测。
- 覆盖每个 readiness code；OFFER_NOT_SELLABLE 包括无启用规格、配置无效、有效但无库存三种情况。
- 深链接不触发业务写入；无效 offer 不落回默认规格。
- 390px/1280px 浏览器检查、键盘与焦点恢复；至多一条新导航冒烟，逻辑主要由单测和集成验证。
- 真正触及库存写路径或其他关键旅程时，按 testing-policy 追加现有回归及 run-e2e 标签。

## 4. PR3：验收、试点与发布说明

1. 汇总 14 项 AC 的测试文件和实际执行结果，不以文档草案充当验收记录。
2. 验证默认关闭、开启、再关闭；原编辑/库存/订单/邮件回归。
3. 说明登录时检查、无离线日报、无暂缓；数据保护上限存在且截断可见。
4. 小范围试用至少一周，观察误报、重复、导航是否解决问题及操作耗时。
5. 如果反复出现“已知道，暂时别提醒”再评审暂缓；固定帮助不足才评审 AI；需要离线发现再评审巡检。不默认继续增加复杂度。

## 5. 测试与验证

仅文档修订检查 Markdown、相对链接和 git diff，不运行数据库或全量构建。实施后按实际文件名选择：

```bash
npm --prefix server run build
npm run build
npx vitest run src/components/merchant/workbench
```

后端测试在 server 工作目录执行 `npx vitest run src/modules/merchant/workbench`，按仓库约定配置 TEST_DATABASE_URL 为可丢弃测试库，先应用已有迁移。V1 没有新数据模型，不要求为本功能额外执行 db:generate 或创建迁移。页面接入测试、时间戳会话测试和浏览器冒烟按实际改动补充。

## 6. 修订记录

0.2.0：采纳实施前评审八项意见，移除暂缓 PR，将开关、分页和刷新路径简化；补齐发布参数、缺项导航、SLA 等号及 SQL 时区测试；迁入独立分支提交。

0.2.1：完成 PR1，只读查询和共享发布评估已落地；补充本地验证记录。前端与试点仍属于后续范围。
