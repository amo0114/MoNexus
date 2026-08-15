# CMI C5a — 既有失败逐文件裁定(遗留债务清偿)

> 卡片:C5a(legacy debt clearance, session `cmi-c5-legacy`)。对 C4 合并前即已存在的
> 服务端 24 失败 / 9 文件 + 2 个 catalog e2e 失败,逐条裁定 `STALE-ASSERTION`
> (旧断言早于冻结 CMI 语义 → 更新测试)或 `PRODUCT-BUG`(只报告不修,交协调者裁决)。
> 纪律:不改生产代码 / schema / migrations;不放宽断言强度(新语义下等严格);write-as-you-go
> (先写裁定 → 再改测试 → 逐文件跑绿)。测试环境:Node 20、CMI 专用库
> `monexus_test_catalog_merch_integration`(dbguard)、`REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000`。

---

## server 测试(9 文件)

### 1. `server/src/__tests__/admin.test.ts` — 1 失败(共 25)

- **失败用例**:`POST /api/admin/products/:id/inventory > rejects non-instant offers, foreign offers, templated offers, and products without instant offers`
- **现象**:对带 `deliveryFields` 模板的规格做 admin 库存导入,期望 400 `交付字段模板`,实际 200。
- **裁定**:`STALE-ASSERTION`
  - 依据:Catalog Operations spec §8.2 "Preview/confirm"(`docs/superpowers/specs/2026-08-09-catalog-operations/spec.md`)"结构化字段与重复校验沿用现有限制"——结构化(交付字段模板)导入是 Merchant/Admin 共用的既有支持路径,不是"必须走商家端";`server/src/modules/admin/service.ts` `resolveAdminImportOffer` 只拒绝非 instant_inventory 规格,对带模板规格正常走 `analyzeStructuredInventoryImport` 落库 `structuredContent`。
  - 更新:模板规格由"期望 400"改为"期望 200 且落库行带 `structuredContent`"(等严格:正向断言结构化行内容),其余三项守卫(人工服务→400、外店规格→404、无即时规格商品→400)保持不动。

### 2. `server/src/__tests__/admin-product-delivery.test.ts` — 3 失败(共 3)

- **失败用例**(同一根因,均因 admin 商品写路径不再接受 `stock`):
  1. `supports the same fixed-content/manual product configurations as merchant authoring` — manual_service create 带 `stock: 3` → 期望 201 实得 400。
  2. `rejects invalid combinations instead of creating an ambiguous stock source` — `instant_fixed + limited + fixedContent`(不带 stock)→ 期望 400 实得 201(旧语义把"限量缺名额"当非法;新语义下草稿初始名额恒 0,名额由 offer 容量调整)。
  3. `validates effective cross-field updates and keeps the gallery cover canonical` — PUT 带 `stock: 2` → 期望 200 实得 400。
- **裁定**:`STALE-ASSERTION`(三条同源)
  - 依据:`180ec06 feat(catalog): add draft publication workflow` 引入的 `adminDraftProductFieldsSchema` 把 `stock` 从 admin 商品 create/update 写 schema 中 omit(与 merchant schema 一致);Catalog-Ops spec §8.1 "Offer-first 库存契约" UI 动作词(`instant_fixed limited → 调整可售名额`)与 `server/src/modules/merchant/capacity-adjust.test.ts`(注释:建品与可售量分离,草稿初始名额恒 0,随后显式补充)冻结了"建品与可售量分离"语义——`stock` 不再是商品级可写真相源。
  - 更新:① manual create 去掉 `stock: 3`,断言响应 `stock: 0`;② 将旧的"限量缺名额"400 断言改为严格正向断言：`instant_fixed + limited + fixedContent` 不带 `stock` 仍创建成功且返回 `stock: 0`，名额后续仅由 offer 容量调整补充;③ fixed PUT 去掉 `stock: 2`,断言 `stock: 0`。其余守卫(即时库存直设 stock→400、固定内容为空→400、人工服务带 fixedContent→400、封面不一致→400、切模式未清 fixedContent→400)保持不动。

### 3. `server/src/__tests__/dispute-resume.test.ts` — 2 失败(共 12)

- **失败用例**(同一根因,均在 `P6a review P1-2: dispute re-delivery refreshes an already-expired subscription` 的 seed 下单处):
  1. `re-delivery with NEW content after expiry recomputes expiresAt (remedy stays visible)` — seed `api.post('/api/orders')` 期望 201 实得 400。
  2. `unexpired re-delivery keeps the original expiry (no mid-window extension)` — 同上。
- **现象**:下单返回 400 `商品已下架`(probe 实测响应体)。
- **裁定**:`STALE-ASSERTION`
  - 依据:`180ec06 feat(catalog): add draft publication workflow` 冻结"草稿发布"语义——只有 `status: 'active'`(已发布)商品可下单;同文件首个 describe 的 seed 建品时已显式 `status: 'active'`(`固定内容争议商品`),而本 seed(`seedManualSubscriptionOrder`)建品未带 status,依赖旧"草稿可直接下单"行为。
  - 更新:seed 建品数据补 `status: 'active'`(场景焦点是到期后争议重交付,与发布门禁无关;其余断言不动)。

## 剩余文件裁定

- `file-delivery-chain.test.ts`（12）：`STALE-ASSERTION`。遗留 API setup 把 merchant 商品创建后直接下单，既没有规范封面，也没有走草稿发布动作；冻结语义要求 create 返回 draft、满足 cover/offer readiness 后显式 `POST /api/merchant/products/:id/publish`。更新共享文件商品 helper，以及两个直接下单的人工商品 setup：以 canonical `imageUrl/images` 创建草稿，严格断言 publish 200，交付/下载断言保持不变。禁止在 create payload 写 `status`（该字段是严格拒绝的服务端真相字段）。
- `purchase-form.test.ts`（1）：`STALE-ASSERTION`。公共详情断言依赖旧的草稿可见行为；以带规范封面的草稿创建，随后严格断言 merchant publish 200，再验证公共详情暴露表单。禁止以 `status: 'active'` 绕过发布门禁。
- `subscription-expiry.test.ts`（2）：`STALE-ASSERTION`。文件订阅订单 seed 依赖草稿可直接购买；以带规范封面的草稿创建，随后严格断言 merchant publish 200，再创建文件规格并下单，过期/授权断言不变。禁止以 `status: 'active'` 绕过发布门禁。
- `p7a-multi-instance.test.ts`（1）：`STALE-ASSERTION`。失败不是使用 `createTestProduct` 的进度并发用例（该 helper 已直接建 active 商品），而是文件授权限流用例的另一条 API setup：merchant 草稿没有规范封面且未 publish，随后下单旧式地期望 201。更新为草稿带 canonical cover、严格断言 publish 200 后再建文件规格/下单；advisory-lock 并发和 "恰一 granted" 断言不变。
- `merchant.test.ts`（1）：`PRODUCT-BUG`（仅报告，不改测试）。默认 value gate 关闭时，普通已认证用户申请商家仍应 201；干净 CMI DB 复现实际为 `403 FORBIDDEN`。根因是 `app.ts` 先将 `merchantPromotionRouter`、`merchantEntitlementRouter` 挂到 `/api/merchant`，二者在 root `router.use` 上执行 `requireMerchant`（`server/src/app.ts:114-117`、`server/src/modules/merchandising/promotions/routes.ts:30-33`、`server/src/modules/merchandising/entitlements/routes.ts:13-15`），在 `/register` 进入 merchant registration route 前截断普通用户。`server/src/modules/merchant/routes.ts:32-33` 的契约明确 register 面向 authenticated user；保持 201 happy-path 断言，不得改为 403。
- `verified-value-gates.test.ts`（1）：`PRODUCT-BUG`（仅报告，不改测试）。同一根因使 `requireMerchant` 先返回 `403 FORBIDDEN`，掩盖本应由 `requireVerifiedEmail` 发出的 stable `403 EMAIL_VERIFICATION_REQUIRED`。最小探针在干净 CMI DB（未验证普通用户、`emailVerificationRequiredForValue=1`）实测 `{httpStatus:403,errorCode:'FORBIDDEN',merchantCount:0}`；冻结 RAP spec REQ-F-001/002 要求该路由返回 `EMAIL_VERIFICATION_REQUIRED`（`docs/superpowers/specs/2026-08-01-registration-abuse-prevention/spec.md:169-170`），中间件实现亦如此（`server/src/middlewares/auth.ts:202-234`）。保持错误码与零 Merchant 写入断言，不得放宽为仅检查 403。

## catalog E2E（2 个既有失败）

- category-governance 引用删除场景：`STALE-ASSERTION`。专用 runner 实测失败在 response 已到后立即 `row.isVisible()` 的 React render window；失败快照与 CMI DB 均证明 approvedCategoryId 对应 active category 已存在、approved application 仍引用该行，后端 list 也返回全量 7 行。更新为从当前真实分页响应解析目标 id 是否在该页，再严格等待同 `category-row-<id>` 渲染；之后仍须精确断言 DELETE `409` / `CATEGORY_REFERENCED` 和原分类不变。
- xboard-import `network-node` 分类定位：`STALE-ASSERTION`。专用 runner 实测同一 response-to-render race；CMI DB 证明 active `network-node` 存在，失败截图也显示该行已在稍后渲染。更新 helper 为从每个真实分页响应解析 `network-node` 的 id，并严格等待匹配 `category-row-<id>`；不改 canonical code、分页语义或后续 Xboard import 断言。定位修复后暴露同一 spec 的下一项旧 parser：公开 Faka plan DTO 已含 `content`、`renew`、`group_id`、`transfer_enable`（`server/src/lib/fakaBridge/types.ts:124-139`；fixture 同步），而测试仍拒绝它们。将四项纳入严格 plan allowlist 并逐项类型断言，继续拒绝所有未知字段及嵌套对象额外键；该变更是 `STALE-ASSERTION`，不放宽远端 payload 契约。再次运行后，接口仍严格返回 `FAKA_SOURCE_CHANGED` 与消息 `Xboard 套餐已变化，请重新预览`，但标准 error toast 可见全文为 `错误：Xboard 套餐已变化，请重新预览`；将 UI 断言更新为该完整文本，接口断言不变。第三个旧 parser 缺少 import offer 的必出 `validityDays`（`server/src/modules/admin/service.ts:1645-1653`：周期默认映射或请求显式值），将其纳入严格 key/type（正整数或 null）及结果 DTO；不允许 optional/未知字段。该 fixture 未显式给出有效期，故 preview 中 `monthly`/`yearly` 分别严格期望 `30`/`365`，而非仅适用于永久/流量包周期或显式传入的 `null`。
- xboard-import 幂等重放 toast：`STALE-ASSERTION`。重放响应已严格证明同一 productId、`replayed:true` 和零重复创建；标准 success toast 的完整可见文本是 `成功：幂等重放：商品 #<id> 已存在，未重复创建`，更新精确 UI 文本断言，业务 replay 契约不变。
