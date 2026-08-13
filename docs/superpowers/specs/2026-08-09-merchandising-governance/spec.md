# Spec: 热卖、推广与平台身份展示

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-MERCH-001 |
| 版本 | 0.1.2 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 产品 | MoNexus |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 配套 | [README](./README.md) · [Plan](./plan.md) · [Tasks](./task.md) · [Implement](./implement.md) · [Checklist](./checklist.md) |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |

---

## 1. 目的与现状

### 1.1 目的

建立诚实、可解释、可审计的商品曝光和身份展示系统：用户能区分自然销量、付费推广、平台运营选择和发布者身份；商家不能自行宣称热卖或平台认证；平台能以当前积分体系安全销售固定时长推广套餐。

### 1.2 已核实事实

| 事实 | 基线位置 | 问题 |
| --- | --- | --- |
| Product.isHot 是持久 Boolean | Prisma Product | 无来源、窗口或审计 |
| 商家 create/update schema 接受 isHot，UI 提供“设为热门推荐” | merchant schema/wizard/modal | 商家可自封热卖 |
| 公开列表固定 `isHot DESC,sales DESC,id DESC`，cursor/cache 亦绑定 | products service/cache | “推荐”和累计销量混为一个排序 |
| Product/Offer.sales 下单 increment、退款 decrement | orders service/refundInventory | schema 注释与代码矛盾，且不是时间窗 |
| Admin 热销报表已按 Order 时间窗且排除 refunded | admin service | 可复用口径，不应依赖 Product.sales |
| `merchantId=null` 卡片已经显示“平台自营”文案 | StorePage | 身份可计算，不需商家字段 |
| 当前无广告、campaign、editorial、entitlement模型 | 全仓检索 | 不能用几个 Boolean 补丁代替生命周期 |
| PointAccount/PointLog 是站内积分，无真实支付/提现 | schema/README | P0 应避免伪造法币广告系统 |

### 1.3 成功标准

1. 任意 merchant/admin Product mutation 均不能直接设置 hot；legacy isHot 对用户不可见。
2. 自然热卖来源、窗口、计算时间和排名可审计；退款在下一快照内收敛。
3. sponsored item 始终有“推广” disclosure，且 organic 排名不因付费被暗改。
4. 推广申请、审批、扣款、排期、暂停、到期、取消/退款均有状态和幂等审计。
5. 同一商品/placement 同时最多一个 scheduled/active/paused campaign，避免暂停后重复售卖或收费。
6. 平台精选与平台自营不能由商家请求或购买。
7. 合作伙伴只说明商业合作，不暗示质量认证；到期后自动消失。
8. 商品卡 badge 数量和优先级稳定，键盘/屏幕阅读器能理解 disclosure。
9. Image 2 资产有 prompt、provider/model、hash、人工批准记录，生产 UI 不依赖运行时图片服务。

---

## 2. 范围

### 2.1 范围内

- 废弃 isHot 写/读/排序并处理 legacy 数据；
- 版本化自然热卖计算 run/snapshot、定时 job、retention；
- organic ranking cursor 与 snapshot version；
- PromotionPackage、PromotionCampaign、积分扣款/退款、排期和公开 sponsored shelf；
- EditorialFeature 平台精选；
- MerchantEntitlement 合作伙伴自动/手工授予与到期；
- public merchandising projection、badge/disclosure UI、管理/商家页面；
- Image 2 概念资产和生产 SVG/CSS 转译流程；
- metrics、审计、安全、性能、E2E、发布/回滚。

### 2.2 范围外

- 法币、银行卡、第三方支付、发票、提现；
- CPM/CPC/竞价、点击归因、转化归因、反广告欺诈；
- 个性化推荐、用户画像、机器学习排序；
- 商家“申请平台自营/精选”；
- 平台质量认证、商品真实性担保；
- Web Push/邮件/站内审核通知；
- AI 在商品请求中实时生成图；
- 修改订单付款/退款/结算业务语义；
- 让付费推广改变自然热卖统计。

---

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| Effective order | window 内成功创建且当前 `status != refunded` 的 Order；即时模式已扣积分，人工服务 pending/processing 可为已冻结积分 |
| Ranking run | 一次原子生成的全量自然排名版本 |
| Hot snapshot | 某 product 在一个 completed run 中的有效销量/分类排名 |
| Organic | 不包含付费或运营插槽的常规商品结果 |
| Sponsored | 有效推广 campaign 带来的独立曝光，必须 disclosure |
| Editorial | 平台运营人工安排的精选展示 |
| Entitlement | 商家在有限时间内拥有的合作装饰权益 |
| Platform-owned | Product.merchantId=null 的派生身份 |
| Placement | `store_home_sponsored`、`category_sponsored`、`store_editorial` 等固定展示位 |

---

## 4. 冻结决策

| ID | 决策 |
| --- | --- |
| D-MERCH-01 | Product.isHot 立即从商家/admin write schema、UI、public sort/projection移除；字段暂保留但全部 false/deprecated |
| D-MERCH-02 | 自然热卖只从 Order 聚合，定义为 createdAt 在窗口且 status != refunded；pending/processing/delivered/disputed/closed均计入 |
| D-MERCH-03 | 默认 window=30d、minSales=5、topPercent=20、recompute=60min；使用 SystemConfig integers可调 |
| D-MERCH-04 | 同一 run 使用固定 `windowEnd`，按 Product.categoryId 分区；只排名 active Product |
| D-MERCH-05 | category 内按 effectiveOrderCount DESC、productId DESC 计算稳定 row number；hot=销量达阈值且 rank<=ceil(activePopulation*percent/100) |
| D-MERCH-06 | 短事务创建 running run；第二事务原子写入该 run 的全部 snapshots 并 CAS 为 completed，任一步失败整体回滚，再由独立短事务 CAS failed；public 只把 latest completed 视为 active，永不读取 running/failed run |
| D-MERCH-07 | cursor 包含 rankingRunId/score/id；run保留至少48h，过期返回409 CURSOR_EXPIRED而非混用新旧页 |
| D-MERCH-08 | organic 先 hot、再 effectiveOrderCount、再 id；sponsored/editorial不进入该 cursor或自然 score |
| D-MERCH-09 | P0推广仅固定时长/固定积分 PromotionPackage，不承诺 impression/click 数量 |
| D-MERCH-10 | merchant提交 pending_review不扣款；admin approve时校验商品/套餐/余额并同事务扣款+PointLog+schedule/active |
| D-MERCH-11 | 余额不足进入 payment_failed且不部分扣款；merchant可在批准仍有效时 retry-payment |
| D-MERCH-12 | 同 product+placement 只能有一个 scheduled/active/paused campaign；paused继续占位，数据库partial unique/CAS为最终裁决 |
| D-MERCH-13 | pending可merchant cancel无费用；开跑前平台cancel全额自动退；开跑后只允许admin显式adjust 0..charge并写理由，最多一次累计不超charge |
| D-MERCH-14 | sponsored endpoint只返回active、Product active、merchant active的campaign；10分钟bucket确定性轮换，公平但不承诺次数 |
| D-MERCH-15 | disclosure固定“推广”，与卡片内容同可见层级；不能只依赖颜色/图标 |
| D-MERCH-16 | EditorialFeature 由admin创建/排期/撤销并记录理由；显示“平台精选”，不扣款、不改变hot |
| D-MERCH-17 | platform_owned 从 merchantId=null 派生；没有可写 entitlement/boolean |
| D-MERCH-18 | partner entitlement label固定“平台合作伙伴”；自动源为近90天净推广消费积分 `Σ(chargedPoints-refundedPoints) >= 1000`，manual源必须reason+expiry |
| D-MERCH-19 | partner entitlement展示在merchant identity区域，不放在商品性能badge区；不得使用认证/担保词 |
| D-MERCH-20 | 商品badge顺序为平台自营→平台精选→热卖，最多三项；sponsored disclosure独立 |
| D-MERCH-21 | Image2仅离线概念设计；通过api-image脚本读取当前provider，默认gpt-image-2，opaque输出；不得请求transparent或泄露key |
| D-MERCH-22 | 生产badge使用SVG/CSS/token和可选已审纹理；每个AI资产保存prompt/角色/模型/hash/reviewer，不在runtime调用API |
| D-MERCH-23 | 本波不新增notification event、不修改订单/settlement状态机、不把Promotion塞进Settlement |

---

## 5. 目标数据模型

### 5.1 MerchandisingRun

~~~text
MerchandisingRun
  id             UUID PK
  status         running | completed | failed
  windowStart    DateTime
  windowEnd      DateTime
  windowDays     Int
  minSales       Int
  topPercent     Int
  startedAt      DateTime
  completedAt    DateTime?
  failedAt       DateTime?
  failureCode    String?  # 脱敏枚举
  createdAt      DateTime
~~~

数据库约束/关系：

- `CHECK(windowStart < windowEnd)`、`windowDays/minSales/topPercent` 使用 Foundation 冻结范围；状态字段必须满足：running 的 `completedAt/failedAt/failureCode` 全 null，completed 仅 `completedAt` 非 null，failed 的 `failedAt/failureCode` 非 null且 `completedAt` 为 null；
- partial unique `UNIQUE ((1)) WHERE status='running'`，即全局最多一个 running run；advisory lock 是调度优化，DB unique 是最终兜底；
- `INDEX(status, completedAt DESC, id DESC)`；public 以 `status='completed' ORDER BY completedAt DESC,id DESC LIMIT 1` 确定 active run，不另设可漂移 active boolean；
- 短事务 A 只创建 running run 并提交；事务 B 写该 run 的全部 snapshots，并以 `WHERE id=? AND status='running'` CAS 为 completed。事务 B 任一步失败则整体回滚，不留 partial snapshot；catch 后使用独立短事务 C 将同一 run CAS `running→failed`，写 `failedAt/failureCode`。事务 C 失败只能告警，不能伪报成功；
- 进程硬退出可能只留下 running。任一 scheduler 在持有 advisory lock 后，先用数据库时间把 `startedAt < now()-hotRunTimeoutMinutes` 的 running CAS 为 failed（`failureCode=RUN_TIMEOUT`），再创建新 run；旧进程若恢复，其事务 B 因 completed CAS 影响 0 行而整体回滚。失败/stale run 均不覆盖上一 completed run。

### 5.2 ProductMerchandisingSnapshot

~~~text
ProductMerchandisingSnapshot
  runId                UUID
  productId            Int
  categoryId           Int
  effectiveOrderCount  Int >=0
  categoryRank         Int >=1
  categoryPopulation   Int >=1
  isHot                 Boolean
  computedAt            DateTime
  PK(runId, productId)
  INDEX(runId, categoryId, isHot, effectiveOrderCount, productId)
~~~

关系固定为：`runId → MerchandisingRun.id ON DELETE CASCADE`、`productId → Product.id ON DELETE CASCADE`、`categoryId → ProductCategory.id ON DELETE RESTRICT`。Snapshot 的 categoryId 是该 run 计算时的分类快照分区；计算时必须与目标 Product 当时 categoryId 相同。`PK(runId,productId)` 防同 run 重复，run 完成后 snapshot 不可更新。

### 5.3 PromotionPackage

~~~text
PromotionPackage
  id             Int PK
  code           String UNIQUE immutable
  label          String
  placement      store_home_sponsored | category_sponsored
  durationDays   Int 1..90
  pricePoints    Int >0
  description    String <=1000
  sortOrder      Int
  status         active | inactive
  createdBy/updatedBy
  timestamps
~~~

### 5.4 PromotionCampaign

~~~text
PromotionCampaign
  id                    Int PK
  merchantId            Int
  productId             Int
  packageId             Int
  packageCodeSnapshot   String
  placementSnapshot     String
  durationDaysSnapshot  Int
  pricePointsSnapshot   Int
  requestIdempotencyKey String
  requestPayloadHash    String
  status                pending_review | payment_failed | scheduled | active |
                        paused | expired | rejected | cancelled
  requestedStartAt      DateTime?
  startsAt              DateTime?
  endsAt                DateTime?
  reviewedByUserId      Int?
  reviewedAt            DateTime?
  reviewReason          String?
  chargePointLogId      Int? UNIQUE
  chargedPoints         Int default 0
  refundedPoints        Int default 0
  refundPointLogId      Int? UNIQUE
  adjustmentDecidedAt   DateTime?
  adjustmentByUserId    Int?
  adjustmentReason      String?
  adjustmentIdempotencyKey String?
  adjustmentPayloadHash String?
  cancelledByUserId     Int?
  cancellationReason    String?
  createdAt/updatedAt
~~~

DB partial unique：同 `(productId, placementSnapshot)` 在 `scheduled|active|paused` 中最多一行。paused 仍占位，防止暂停后重复售卖。

Foundation 必须同时冻结：

- `merchantId → Merchant.id ON DELETE RESTRICT`、`productId → Product.id ON DELETE RESTRICT`、`packageId → PromotionPackage.id ON DELETE RESTRICT`；申请/批准事务验证 `Product.merchantId == Campaign.merchantId`；
- `UNIQUE(merchantId,requestIdempotencyKey)`；创建重放须比较 canonical request hash，同 key/同 hash 返回既有 Campaign，同 key/异 hash 409；key/hash 仅内部可见；
- create key 的作用域是 merchant：不同 merchant 可复用同 key。`requestIdempotencyKey` 必须非空且符合公共幂等规范，`requestPayloadHash` 必须是 64 位 lowercase hex；数据库 unique 冲突后必须读既有行并比较 hash，不得把约束名直接返回客户端；
- reviewer/canceller/adjuster user FK 使用审计友好的 `ON DELETE RESTRICT`；平台账号不得靠删除绕过历史；
- `chargePointLogId → PointLog.id ON DELETE RESTRICT UNIQUE`，`refundPointLogId → PointLog.id ON DELETE RESTRICT UNIQUE`，并在 PointLog 增加两条命名反向关系；
- charge log 必须属于 `Merchant.userId`、`type='out'`、`orderId IS NULL`、`amount=chargedPoints`；refund log 必须同 user、`type='refund'`、`orderId IS NULL`、`amount=refundedPoints`。跨行等值由同一事务 service + real-PG contract test保证；FK/unique/CHECK负责结构兜底；
- `CHECK(chargedPoints >= 0 AND refundedPoints >= 0 AND refundedPoints <= chargedPoints)`；未扣款状态的 charged/refunded/log IDs 必须全零/null，由 service 状态机保证；
- P0 **最多一次 active/paused 调整决定**：以 `adjustmentDecidedAt IS NULL` 做 CAS，写 `adjustmentByUserId/adjustmentReason/refundedPoints/adjustmentIdempotencyKey/adjustmentPayloadHash`；金额允许 `0..chargedPoints`。大于 0 才创建唯一 refund PointLog/写 `refundPointLogId`，等于 0 仍以 adjustment fields + AdminLog 留下“明确不退”的不可变决定；
- adjustment key 的作用域是单个 Campaign；不同 Campaign 可复用同 key。`adjustmentDecidedAt` 为 null 时 adjustment key/hash/by/reason 必须全 null；非 null 时四者必须全非 null且 hash 为 64 位 lowercase hex。由于每个 Campaign 只有一行且 P0 只有一次决定，不新增伪装成全局约束的 key unique；行锁 + `adjustmentDecidedAt IS NULL` CAS 是并发最终裁决；
- scheduled 开跑前平台取消写全额 refund，并由 campaign terminal state + `refundPointLogId` 幂等。active/paused adjustment 重放同 idempotency key/同 amount 返回既有结果，不同 amount 或第二次新请求 409；
- 若未来需要多次调整，必须另立规格新增不可变 `PromotionChargeAdjustment`，不得复用/覆盖单个 `refundPointLogId`。

### 5.5 EditorialFeature

~~~text
EditorialFeature
  id            Int PK
  productId     Int
  placement     store_editorial | category_editorial
  status        scheduled | active | revoked | expired
  startsAt/endsAt
  sortWeight    Int
  publicReason  String? <=120
  internalReason String 1..500
  createdBy/revokedBy
  timestamps
~~~

### 5.6 MerchantEntitlement

~~~text
MerchantEntitlement
  id             Int PK
  merchantId     Int
  code           partner
  source         promotion_spend | admin_grant
  sourceRef      String?
  status         active | expired | revoked
  validFrom      DateTime
  validUntil     DateTime
  reason         String <=500
  grantedByUserId Int?
  revokedByUserId Int?
  createdAt/updatedAt
~~~

同 merchant+code 同时最多一个 active。自动重算以幂等 upsert/expire维护，不删除历史 grant。

---

## 6. 自然热卖计算

### 6.1 事实口径

SQL 逻辑等价于：

~~~sql
COUNT(order.id)
WHERE order.createdAt >= windowStart
  AND order.createdAt < windowEnd
  AND order.status <> 'refunded'
~~~

- 每个 Order 当前购买一个 Offer/商品，计数为1。
- 退款在下一 run 排除；不读取 Product.sales/Offer.sales。
- disputed仍是已支付订单，计入；若后来 refunded，下轮排除。
- draft/inactive Product不参与当前 activePopulation，但历史 Order不删除。

### 6.2 原子 run

1. 获取 job advisory lock；已有running未超时则退出。
2. 读取一次 SystemConfig，冻结进 run。
3. 固定 windowEnd=job开始时数据库时间，计算 windowStart。
4. 在 transaction/临时表内聚合并写全部 snapshots。
5. 校验 active Product 覆盖和非负计数。
6. 单事务把 run completed；上一run保持可读至新run完成。
7. 清理48h以前且无活跃cursor需要的旧run；保留失败run诊断7天但可删snapshots。

### 6.3 排名和游标

公开 organic query固定一个 completed run：

~~~text
isHot DESC,
effectiveOrderCount DESC,
productId DESC
~~~

cursor包含 v/runId/isHot/effectiveOrderCount/productId/filterHash。run仍保留时下一页继续同run；filter不匹配或run已清理返回409 `PRODUCT_CURSOR_EXPIRED`，前端清页并从第一页重新取。

如果尚无completed run，所有商品按 hot=false,count=0,id DESC；不得回退legacy isHot。

---

## 7. 推广套餐与活动

### 7.1 状态机

~~~text
merchant request ─► pending_review
  ├─ merchant cancel ─► cancelled（未扣款）
  ├─ admin reject ─► rejected（未扣款）
  └─ admin approve + atomic charge
       ├─ insufficient ─► payment_failed ─► retry-payment
       ├─ future start ─► scheduled ─► active ─► expired
       └─ start now ────► active ─► paused/resumed | expired

scheduled（start前）平台cancel ─► cancelled + full refund
active/paused cancel ─► cancelled + optional explicit admin adjustment
~~~

### 7.2 申请

商家只能为自己 active merchant 下的 active Product 请求 active package。请求 body 只有 productId/packageId/requestedStartAt；价格/placement/duration由服务端快照，不能由客户端传。

### 7.3 扣款

Admin approve transaction：

1. CAS pending_review/payment_failed（retry路径）并锁 campaign；
2. 重验 merchant/product/package/status/placement冲突；
3. 条件 decrement Merchant.user 的 PointAccount.balance；
4. 创建 PointLog type=out、reason使用稳定模板、orderId=null；
5. 依据数据库时间写 `startsAt/endsAt` 与 `scheduled|active` 状态；
6. 写 AdminLog；
7. 任一步失败整体回滚。

余额不足不写PointLog，campaign→payment_failed并保留review结果。retry由merchant触发，但仍使用已批准价格快照；套餐失效不影响已批准retry，超过批准有效期（默认7天）则必须重新申请。

### 7.4 退款/调整

- scheduled且未开始由平台取消：同事务返全部chargedPoints、PointLog refund、campaign cancelled。
- active/paused：不自动退。P0 只允许 Admin **最多一次** 显式调整决定，金额 `0..chargedPoints`，理由必填；以 `adjustmentDecidedAt IS NULL` CAS。同事务写 adjustment fields/AdminLog；金额大于 0 时再写余额、唯一 refund PointLog 与 `refundPointLogId/refundedPoints`。P0 不存在第二次调整入口。
- merchant不能直接调用refund。
- expired不自动退。

### 7.5 公开展位

`GET /api/products/sponsored?placement=&categoryCode=&limit=`：

- 只 active campaign + active Product + active Merchant；
- limit 1..12；
- 使用 `hash(campaignId, placement, floor(serverTime/10min))` 确定性轮换；
- 不返回chargedPoints、审核人、内部reason、merchant余额；
- 每项强制 `{disclosure:{code:'sponsored',label:'推广'}}`；
- 缓存最大60s，campaign/status/product变化主动失效。

套餐售卖的是进入指定曝光池的时长，不承诺展示/点击/成交次数；商家购买页必须明确该说明。

---

## 8. 平台精选、平台自营与合作伙伴

### 8.1 平台精选

- 只有admin/MFA可create/schedule/revoke；
- Product必须active；feature生效时Product若inactive则不展示但时间继续流逝；
- publicReason可展示，internalReason只后台；
- 独立 editorial shelf，label“平台精选”；
- 不计入hot、不扣积分、不授予partner。

### 8.2 平台自营

`platformOwned = product.merchantId === null`，服务端projection计算。任何request body中的platformOwned/official/verified均返回不可写错误。

### 8.3 合作伙伴

自动 job 使用数据库时间和半开区间：筛选 `chargePointLog.createdAt ∈ [now()-partnerSpendWindowDays, now())` 的 Merchant Campaign，计算净推广消费积分 `Σ(PromotionCampaign.chargedPoints - PromotionCampaign.refundedPoints)`；达到1000则grant/extend partner至`today+30d`，低于阈值不立即撤销已授予期限，期限到自动expire。退款无论发生在窗口内外，都通过 Campaign 当前 `refundedPoints` 从对应窗口内 charge 扣除；窗口外 charge 不进入本次聚合。阈值/window/duration为整数SystemConfig。

manual admin grant必须reason、validUntil≤365d；revoke需要reason。UI固定“平台合作伙伴”，tooltip：“该商家当前参与平台商业合作计划；不代表平台对商品质量作保证。”

---

## 9. Public projection 与 UI

公开 Product DTO增量：

~~~json
{
  "merchandising": {
    "rankingRunId": "uuid",
    "hot": { "effectiveOrders": 18, "rank": 2, "windowDays": 30, "computedAt": "..." },
    "platformOwned": true,
    "platformPick": { "label": "平台精选", "publicReason": "本周上新" },
    "merchantPartner": null
  }
}
~~~

- hot不返回其他商家销量明细，只返回本商品指标。
- badge组件以文本节点/aria-label显示；不能只用图片。
- product card badge最多三项，顺序固定。
- sponsored card在卡片顶部/标题邻近显示“推广”，视觉对比满足WCAG，不得放进tooltip才可见。
- partner装饰位于商家名附近，并带不担保tooltip。

未知 merchandising code安全忽略；不得猜测为认证。

---

## 10. Image 2 资产流程

Image 2 是设计辅助，不是业务依赖。

### 10.1 输入/输出

- 先读取项目已有品牌色、字体、卡片/徽章截图作为style/composition reference；不需要外部品牌搜索。
- 通过 `/root/.codex/skills/api-image/scripts/generate_image.py`，运行时读取当前Codex provider配置，默认`gpt-image-2`。
- 生成2048×2048或2048×1152、quality=high、background=opaque的概念板；不得请求transparent。
- 每次n=1，评审后逐项迭代；不得批量生成后无筛选上线。

### 10.2 资产记录

~~~text
docs/design/merchandising/concepts/
  <concept>.png
  <concept>.prompt.md      # prompt、input roles、model、size、quality、日期
  <concept>.review.md      # reviewer、接受/拒绝、使用边界、sha256

public/assets/merchandising/  # 只放批准的runtime纹理/栅格，不放废稿
src/components/merchandising/BadgeMark.tsx
~~~

API key/base_url不得进入prompt、metadata、日志或commit。AI概念中的文字不直接作为runtime文字；生产文字由HTML渲染，图形由SVG/CSS/token实现。若使用概念纹理，需裁切/压缩、版权/敏感内容复核和1x/2x性能预算。

### 10.3 视觉方向

- 平台自营：稳重、平台主色、简洁建筑/盾形轮廓，但避免“认证勾”暗示。
- 平台精选：编辑书签/星芒，但不使用Hot火焰。
- 热卖：数据/趋势/火焰语义，可显示“热卖”。
- 平台合作伙伴：连接/握手/环形装饰，明确商业合作而非认证。
- 推广：使用megaphone并始终配“推广”文本。

---

## 11. API

### 公共幂等规范

- `Idempotency-Key` 在 HTTP OWS trim 后必须匹配 `[A-Za-z0-9._:-]{1,128}`，按原值保存且大小写敏感；缺失返回 400 `IDEMPOTENCY_KEY_REQUIRED`，格式错误返回 400 `IDEMPOTENCY_KEY_INVALID`。
- hash 输入先经过 strict schema 校验；未知字段拒绝。字符串先 trim，再做 Unicode NFC；整数保持十进制整数；时间解析后统一为 UTC 毫秒 ISO-8601（`YYYY-MM-DDTHH:mm:ss.sssZ`），省略的 `requestedStartAt` 与 null 都规范为 null。
- create canonical bytes 是 UTF-8 JSON array `["campaign-create-v1",productId,packageId,requestedStartAtUtcOrNull]`；adjustment canonical bytes 是 `["campaign-adjustment-v1",campaignId,points,normalizedReason]`。对 bytes 取 SHA-256 lowercase hex，禁止依赖普通 object key 枚举顺序。
- 冻结测试向量：`["campaign-create-v1",42,7,null] → 0360a61366112b759d8fdcad40d8e235b2a8864172508a928343c39916836ddc`；`["campaign-adjustment-v1",99,120,"排期调整"] → 5e8d59c7b387bbbd6a657254ee58a5be333add82e487ab84de8434b9faca5dc6`。
- 同 scope/key/hash 重放返回既有资源/决定并标 `replayed=true`；同 scope/key 异 hash 返回 409 `IDEMPOTENCY_KEY_REUSED`。adjustment 已由另一 key 决定时返回 409 `CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED`。create 首次返回 201、重放返回 200；adjustment 首次与重放均返回 200。任何响应/log/metric 不回显 key/hash。

### Merchant

~~~text
GET    /api/merchant/promotion-packages
GET    /api/merchant/promotion-campaigns?status=&page=
POST   /api/merchant/promotion-campaigns
POST   /api/merchant/promotion-campaigns/:id/cancel
POST   /api/merchant/promotion-campaigns/:id/retry-payment
GET    /api/merchant/entitlements
~~~

创建 Campaign 必须遵循上述公共幂等规范；canonical payload 固定覆盖 productId/packageId/requestedStartAt。

### Admin

~~~text
GET/POST/PATCH /api/admin/promotion-packages...
GET              /api/admin/promotion-campaigns
POST             /api/admin/promotion-campaigns/:id/approve
POST             /api/admin/promotion-campaigns/:id/reject
POST             /api/admin/promotion-campaigns/:id/pause
POST             /api/admin/promotion-campaigns/:id/resume
POST             /api/admin/promotion-campaigns/:id/cancel
POST             /api/admin/promotion-campaigns/:id/refund-adjustment
GET/POST/PATCH    /api/admin/editorial-features...
GET/POST          /api/admin/merchant-entitlements...
POST              /api/admin/merchant-entitlements/:id/revoke
POST              /api/admin/merchandising/recompute
GET               /api/admin/merchandising/runs
~~~

`refund-adjustment` 必须遵循上述公共幂等规范，body 为 `{ points: 0..chargedPoints, reason }`。相同 campaign/key/hash 重放返回既有决定；相同 key 异 hash、或已存在另一 adjustment 决定均返回稳定 409 code。

所有admin mutation要求MFA并写AdminLog；积分transaction另写PointLog。Public/merchant response不返回内部reason/reviewer/pointLogId。

---

## 12. 配置

新增整数SystemConfig：

| key | 默认 | 范围 |
| --- | ---: | --- |
| `hotWindowDays` | 30 | 1..365 |
| `hotMinSales` | 5 | 1..100000 |
| `hotTopPercent` | 20 | 1..100 |
| `hotRecomputeMinutes` | 60 | 10..1440 |
| `hotRunTimeoutMinutes` | 30 | 10..1440 |
| `partnerSpendWindowDays` | 90 | 1..365 |
| `partnerMinPromotionPoints` | 1000 | 1..2e9 |
| `partnerEntitlementDays` | 30 | 1..365 |

Config变化不重写当前completed run；下个run采用新snapshot。所有值显示单位/说明并由现有SystemConfig审计。

---

## 13. 不变量

| ID | 不变量 |
| --- | --- |
| MERCH-001 | 商家/admin不能直接设置hot，legacy isHot不参与任何用户可见语义 |
| MERCH-002 | Hot只由completed run+Order事实计算，不能由Product.sales或推广活动生成 |
| MERCH-003 | refunded订单不计；推广/精选曝光不计入销量 |
| MERCH-004 | public绝不读取running/failed partial snapshots |
| MERCH-005 | 同cursor所有页使用同rankingRunId |
| MERCH-006 | Sponsored必须文字标注推广，不混入organic score/cursor |
| MERCH-007 | Promotion价格/placement/duration由服务端package snapshot决定 |
| MERCH-008 | 扣款、PointLog、campaign状态、AdminLog在同一transaction |
| MERCH-009 | refundedPoints累计不得超过chargedPoints，merchant无refund权限 |
| MERCH-010 | 同product+placement不能重复scheduled/active/paused campaign |
| MERCH-011 | 平台精选只能admin创建，不能购买且不改变hot |
| MERCH-012 | 平台自营只由merchantId=null派生 |
| MERCH-013 | 合作伙伴有有效期/来源/审计，不等于认证或质量担保 |
| MERCH-014 | Merchant/Product inactive时campaign不公开展示 |
| MERCH-015 | 内部review reason、point log、余额、扣款细节不进入public DTO |
| MERCH-016 | Runtime不调用image provider，API key/provider secret不入repo |
| MERCH-017 | badge文本由HTML渲染，未知code默认隐藏 |
| MERCH-018 | 本规格不修改Order/Settlement/Notification业务语义 |

---

## 14. 功能需求

| ID | 需求 |
| --- | --- |
| REQ-MERCH-F-001 | 移除所有merchant/admin isHot写入口和legacy展示/排序 |
| REQ-MERCH-F-002 | 定时/手动触发原子ranking run并保留上一成功版本 |
| REQ-MERCH-F-003 | public organic列表按固定run热卖指标排序并稳定分页 |
| REQ-MERCH-F-004 | 配置、run、snapshot在admin可观测且失败可诊断 |
| REQ-MERCH-F-005 | Admin管理固定积分PromotionPackage |
| REQ-MERCH-F-006 | Merchant申请/查看/cancel/retry自己的Campaign |
| REQ-MERCH-F-007 | Admin审核、扣款、排期、暂停/恢复、取消/退款调整Campaign |
| REQ-MERCH-F-008 | Public sponsored shelf清晰disclosure并公平轮换 |
| REQ-MERCH-F-009 | Admin管理EditorialFeature，public显示平台精选shelf/badge |
| REQ-MERCH-F-010 | platformOwned自动投影且不可写 |
| REQ-MERCH-F-011 | partner entitlement自动/手工授予、到期/撤销和tooltip |
| REQ-MERCH-F-012 | public projection/BadgeMark在商品和商家区域一致 |
| REQ-MERCH-F-013 | Image2概念→人工审查→runtime assets流程可复现 |

---

## 15. 非功能需求

| ID | 需求 |
| --- | --- |
| REQ-MERCH-NF-001 | ranking run 10万Order/1万Product production-like fixture在10分钟内完成，失败不影响上一run |
| REQ-MERCH-NF-002 | organic list P95相对Catalog基线退化≤10%；sponsored/editorial endpoint P95≤300ms |
| REQ-MERCH-NF-003 | Campaign扣款/退款/冲突使用真实PG并发测试，不发生重复扣/超退 |
| REQ-MERCH-NF-004 | public/admin/merchant权限和敏感字段边界严格分离 |
| REQ-MERCH-NF-005 | metrics标签有界，不含merchant/product/user/campaign ID |
| REQ-MERCH-NF-006 | AI生成离线、可审计、无secret，runtime bundle新增资产预算≤150KiB gzip |
| REQ-MERCH-NF-007 | Shared Foundation Owner/CMI Integration Owner规则满足PAR-CMI，零通知冲突 |
| REQ-MERCH-NF-008 | frontend/backend build、points/orders/products/admin回归与专用E2E全绿 |

---

## 16. 验收标准

| ID | Given / When / Then |
| --- | --- |
| AC-MERCH-001 | Given merchant create/update传isHot；Then 400 FIELD_NOT_WRITABLE且DB不变，UI无toggle |
| AC-MERCH-002 | Given legacy isHot=true；When新版本读取；Then无Hot badge/排序加成，迁移/cleanup置false |
| AC-MERCH-003 | Given窗口订单覆盖pending/processing/delivered/closed/disputed/refunded；When run；Then成功创建的订单除refunded外均计入，人工未终态按已冻结积分理解，且不读Product.sales |
| AC-MERCH-004 | Given同分类10个active商品、规则20%/min5；Then只有排名前2且≥5单为hot，tie按productId稳定 |
| AC-MERCH-005 | Givenrun中途失败；Then上一completed run仍active，running/partial不公开 |
| AC-MERCH-006 | Givenrefund在run后发生；When下个run完成；Then指标减少/Hot按新结果收敛 |
| AC-MERCH-007 | Given第一页cursor run A；Whenrun B完成；Then下一页仍按保留的A；A过期返回409并前端重启分页 |
| AC-MERCH-008 | Given无completed run；Then全部hot=false，organic按id fallback，不读legacy isHot |
| AC-MERCH-009 | Givenmerchant申请package；Then价格/placement/duration取server snapshot，pending不扣分；同Idempotency-Key/同payload重放同Campaign，异payload 409 |
| AC-MERCH-010 | Givenadmin批准且余额足；Then扣分+PointLog+schedule/active+AdminLog同事务一次完成 |
| AC-MERCH-011 | Given余额不足；Thenpayment_failed、零PointLog/部分扣款；充值后retry只扣一次 |
| AC-MERCH-012 | Given两管理员并发approve或同商品placement冲突；Then最多一campaign占位/扣款，另一稳定409 |
| AC-MERCH-013 | Givenpending merchant cancel/admin reject；Then终态且不扣/退积分 |
| AC-MERCH-014 | Givenscheduled未开始平台cancel；Then全额refund和状态同事务；重复cancel不二次退 |
| AC-MERCH-015 | Givenactive admin refund adjustment；Then需要理由、最多一次且金额≤charge、同key同normalized body幂等、不同points/reason或第二个新key稳定409、merchant不能调用 |
| AC-MERCH-016 | Givenactive sponsored campaigns超过limit；Then10分钟bucket确定性轮换，所有卡清晰显示推广 |
| AC-MERCH-017 | Givencampaign/Product/Merchant inactive；Thenpublic sponsored endpoint不展示，organic不受影响 |
| AC-MERCH-018 | Given平台精选active；Then独立精选展示/label，Hot count/rank不变 |
| AC-MERCH-019 | Givenmerchant尝试platformOwned/platformPick；Then字段不可写且无申请接口 |
| AC-MERCH-020 | GivenmerchantId=null Product；Then显示平台自营；merchant Product永不显示该身份 |
| AC-MERCH-021 | Given90d有效推广净消费达阈值；Thenpartner entitlement grant/extend；到期后自动消失且历史保留 |
| AC-MERCH-022 | Givenmanual partner grant/revoke；Then需要reason/expiry/AdminLog且tooltip明确不担保 |
| AC-MERCH-023 | Given商品同时自营/精选/热卖；Then按固定顺序最多3badge；sponsored disclosure独立 |
| AC-MERCH-024 | Given未知badge code；Then客户端忽略且不显示认证兜底 |
| AC-MERCH-025 | GivenImage2资产任务；Then使用api-image/gpt-image-2 opaque、prompt/model/hash/review齐全且无secret |
| AC-MERCH-026 | Given未审核AI概念或runtime试图调用image API；ThenCI/Gate失败，产物不进入public assets |
| AC-MERCH-027 | Given100并发Campaign/payment请求；Then无重复扣款、重复活动、超额退款或负余额 |
| AC-MERCH-028 | Given Catalog/Merch 并行；Then Merch 业务分支不改 schema/products service/StorePage，CMI Integration Owner 一次接线 |
| AC-MERCH-029 | Given完整suite；Thenmigration、points/orders/products/admin/notification回归、build、性能、a11y全通过 |

---

## 17. 风险与处理

| 风险 | 处理 |
| --- | --- |
| Order状态口径未来变化 | 口径冻结status!=refunded；改变需新版本/Owner review |
| snapshot表增长 | 48h成功run retention+失败诊断7d；索引/清理metric |
| job与public读混合版本 | run completed原子切换，cursor pin runId |
| 推广被误认为自然推荐 | 独立endpoint/shelf、强制文字disclosure、organic不加权 |
| 积分系统被当真实货币 | P0明确内部积分，页面无人民币/收益承诺；法币另立规格 |
| 审批并发重复扣款 | Campaign/point account行锁+CAS+DB partial unique+PointLog link |
| 商家买到无展示承诺 | 套餐条款明确“曝光池时长”，不承诺次数；购买前确认 |
| 合作伙伴被误解为认证 | 固定文案/tooltip/禁词测试/无verified字段 |
| AI小图文字失真/透明背景 | AI只概念，runtime HTML+SVG/CSS；gpt-image-2 opaque |
| 与 Catalog 共享文件冲突 | Foundation Owner/adapter/CMI Integration Owner 硬锁 |

---

## 18. Owner批准记录

- [x] O-MERCH-01~12 已逐项批准。
- [x] PAR-CMI-001 和 Shared Foundation 内容已批准。
- [x] 六件套已统一 Frozen for Implementation。

批准人：MoNexus Project Owner；批准日期：2026-08-09。

Owner 已于 2026-08-09 批准本规格与 PAR-CMI-001。积分、生产资产和 migration 仍只能在对应实施 Gate 真实满足后操作，不得预填证据。

---

## 19. 追溯矩阵

| 需求 | Plan | Tasks | Implement | Checklist | AC |
| --- | --- | --- | --- | --- | --- |
| REQ-MERCH-F-001～004 | Phase B/C | T-MERCH-BE-001～002、T-MERCH-X-001、T-MERCH-INT-001 | I-MERCH-002～004、010 | CHK-HOT-001～012、CHK-MERCH-FND-002、CHK-QA-001～002 | AC-MERCH-001～008 |
| REQ-MERCH-F-005～008 | Phase D/E | T-MERCH-BE-003～004、T-MERCH-FE-002、T-MERCH-INT-001 | I-MERCH-005～006、009～010 | CHK-PROMO-001～013、CHK-PUBLIC-001～004、CHK-UI-002～004 | AC-MERCH-009～017、027 |
| REQ-MERCH-F-009～012 | Phase F | T-MERCH-BE-005、T-MERCH-FE-001、T-MERCH-FE-003、T-MERCH-INT-001 | I-MERCH-007～010 | CHK-EDIT-001～002、CHK-ID-001～006、CHK-UI-001、CHK-UI-005～006 | AC-MERCH-018～024 |
| REQ-MERCH-F-013 | Phase G | T-MERCH-ASSET-001 | I-MERCH-011 | CHK-ASSET-001～006、CHK-QA-006 | AC-MERCH-025～026 |
| REQ-MERCH-NF-001～008 | Phase H/I | T-MERCH-QA-001～003 | I-MERCH-012～014 | CHK-SEC-001～004、CHK-OPS-001～002、CHK-PERF-001～004、CHK-QA-001～008、CHK-REL-001～004、CHK-MERCH-PAR-001 | AC-MERCH-027～029 |

---

## 20. 变更控制

Draft变更同步六件套/PAR/版本/追溯。Frozen后改变D/MERCH/REQ/AC、销量口径、积分扣退、disclosure、禁词、资产provider流程或Foundation模型，必须退回Draft并重新批准。

Owner 于 2026-08-09 批准 v0.1.1 唯一修订：CMI Foundation DAG 改为 `S→A_CMI→F0→B_CAT→F`；只修执行 DAG/ownership/Gate，不改 D-MERCH/REQ/AC/API/积分/展示。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：自然热卖、积分推广、精选/自营/合作权益、Image2 资产治理 |
| 0.1.1 | 2026-08-09 | Frozen for Implementation | Owner 批准唯一修订：CMI Foundation DAG 改为 S→A_CMI→F0→B_CAT→F；Merch 只消费最终 F、不参与 B_CAT，schema 仍 F0 落地 |
| 0.1.2 | 2026-08-13 | Frozen for Implementation | Owner 批准 QA 收口修订（AMD-CMI-012）：证据规则对齐 testing-policy；QA 卡收敛；T-MERCH-ASSET-001 拆出本次交付 |
