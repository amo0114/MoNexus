# Spec：法律页面与协议同意证据

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-LEGAL-001 |
| 版本 | 1.1.0（R1：复审修订——重放优先、enforcement 下发、携带项逐项校验、指纹空值等价） |
| 日期 | 2026-08-05 |
| 状态 | Implemented（草案文档 v1.0 随代码发布） |
| 产品 | MoNexus |
| 关联模块 | `server/src/modules/legal`、`server/src/modules/auth`（注册）、`server/src/modules/orders`（下单）、`server/src/modules/checkout`（预览）、`src/pages/legal`、`src/components/PurchaseModal.tsx`、`src/pages/LoginPage.tsx`、`src/components/Layout.tsx` |

---

## 1. 背景

平台此前没有任何公开法律文档：footer 的「关于我们 / 服务协议 / 隐私政策」是指向 `#` 的死链；注册与下单不采集任何协议同意，发生争议或拒付时无法举证"用户在何时同意了哪个版本的哪份协议"。

本特性补齐三件事：

1. **五份公开法律文档**（服务协议 / 隐私政策 / 退款政策 / 积分规则 / 关于我们），未登录可直达；
2. **注册与下单的明示同意采集**：勾选门控 + 服务端强校验 + 证据落库；
3. **证据中个人信息的生命周期管理**：IP / User-Agent 到期自动匿名化。

## 2. 目标与非目标

### 2.1 本次目标

1. 五份草案文档经注册表版本化管理，公开只读 API 直出，前端五页公开路由渲染。
2. 注册必须确认《服务协议》《隐私政策》；下单必须确认《服务协议》《退款政策》——强制模式下由服务端在写库前裁决。
3. 同意证据两级落库：用户级长期同意（`UserAgreementConsent`）与订单级确认快照（`OrderAgreementAcceptance`），均锚定文档版本与规范化内容哈希。
4. 协议版本更新后，持有旧版本确认的注册/下单请求返回 `409 LEGAL_AGREEMENT_STALE`，前端重新拉取并要求用户再次勾选。
5. IP / UA 仅留存 180 天，到期由留存 cron 置空匿名化，其余证据字段长期保留。
6. 全特性由 env 开关控制，fail-closed 启动校验；测试逃生（fixture 目录）生产拒启。

### 2.2 明确不在范围内

1. 不做管理端文档编辑器 / CMS；文档内容随代码版本发布（草案期），运营改版走代码评审。
2. 不做历史版本的时间轴展示 API（注册表保留多版本解析能力，前端只展示当前版本）。
3. 不修改既有积分、履约、退款业务流程本身——本特性只采集"确认了什么"。
4. 不提供用户自助导出/删除同意记录的接口（隐私权利流程走客服渠道，见《隐私政策》草案）。

## 3. 领域规则与不变量

| ID | 规则 |
| --- | --- |
| LEG-01 | 五份文档（`terms` / `privacy` / `refund` / `points-rules` / `about`）缺一不可；注册表启动期经 zod 校验、slug 唯一性、`currentVersion ∈ versions[]` 检查，任一失败进程拒启（fail-closed）。 |
| LEG-02 | `contentHash` = 对规范化公开载荷（`{slug,title,version,updatedAt,sections}`，键序固定的 JSON）的 sha256（hex）。公开响应在此载荷上仅追加 `contentHash`，任何人可重算验证。 |
| LEG-03 | 文档内容实质性变更必须 bump `version`（`MAJOR.MINOR`）；历史同意记录锚定旧版本哈希，绝不追溯修改。 |
| LEG-04 | `LEGAL_PAGES_ENABLED=false` 时：公开 API 一律 404，注册/下单忽略 `agreements` 输入、不落证、不报错（旧客户端零感知）。 |
| LEG-05 | `ENFORCEMENT=enforce` 时：注册缺确认 → `400 LEGAL_AGREEMENT_REQUIRED`；版本落后 → `409 LEGAL_AGREEMENT_STALE`（details 携带必备清单 ∪ 过期项的当前版本）。拒绝发生在任何 DB 写入与幂等 claim 之前，零副作用。**例外（R1）**：已完成幂等记录的重放识别先于协议校验——协议升级不得阻断已成功意图按原 key + 原版本重放，否则前端换新键重确认会产生重复订单。 |
| LEG-06 | `ENFORCEMENT=off`（记录模式）：不强制，前端不门控提交（`legalRequirement.enforcement` 随清单下发）；勾选可选，未勾选不携带即不留证。两种模式下**所有携带项**均逐项校验：slug 必须已知（400）、版本必须等于注册表当前版本（409 STALE，无论是否属于本场景必备清单）；通过校验的携带项（含必备之外文档）全部留证——携带旧版本的"同意"绝不被静默丢弃。 |
| LEG-07 | `UserAgreementConsent` 与账号同事务创建；`OrderAgreementAcceptance` 与订单同事务创建。绝不出现"已成交但未留证"。两表只插入不更新。 |
| LEG-08 | `OrderAgreementAcceptance` 以 `@@unique([orderId, document])` 兜底幂等重放/重试；`agreementVersions` 进入幂等请求指纹——同 key 换协议版本 = 不同结算意图 → 409 CONFLICT。 |
| LEG-09 | 证据的 `ip` / `userAgent`（≤512 截断）在 `retentionUntil`（确认时刻 + 180 天）到期后由留存 cron 置空；`document` / `version` / `contentHash` / 时间戳永久保留。行永不删除。 |
| LEG-10 | 前端勾选一律默认不勾（明示同意）；STALE 重试后强制重新勾选——已确认的旧版本不能默示延伸到新文本。 |

## 4. 配置（fail-closed）

| env | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LEGAL_PAGES_ENABLED` | boolean | `false` | 总开关：公开页面 + 同意采集。 |
| `LEGAL_PAGES_ENFORCEMENT` | `off` / `enforce` | `off` | `enforce` = 注册/下单强制要求当前版本确认。 |
| `LEGAL_PAGES_FIXTURE_PATH` | 目录路径 | 未设置 | 测试逃生：以 `<slug>.json` 覆盖内置五份草案。 |

启动守卫（`server/src/config/index.ts`，违例 `process.exit(1)`）：

- `ENFORCEMENT=enforce` 但 `ENABLED=false`：任何环境拒启（"必须同意但读不到协议"的配置矛盾）；
- 生产 `ENABLED=true` 必须 `ENFORCEMENT=enforce`；
- 生产禁止设置 `LEGAL_PAGES_FIXTURE_PATH`（同 `AUTO_PROVISION_ALLOW_INSECURE_TARGETS` 的逃生开关模式）。

## 5. 数据模型

```prisma
model UserAgreementConsent {
  userId         Int
  document       String   // terms | privacy | refund | points-rules | about
  version        String
  contentHash    String   // LEG-02 的 sha256
  consentedAt    DateTime @default(now())
  ip             String?
  userAgent      String?  // 截断 ≤512
  retentionUntil DateTime? // consentedAt + 180 天

  @@unique([userId, document, version]) // 重签新版本产生新行，旧行留存
}

model OrderAgreementAcceptance {
  orderId        Int
  userId         Int      // 冗余便于争议检索
  document       String   // terms | refund
  version        String
  contentHash    String
  acceptedAt     DateTime @default(now())
  ip             String?
  userAgent      String?
  retentionUntil DateTime?

  @@unique([orderId, document]) // 幂等重放/重试天然去重
}
```

两表外键均为 `Restrict`：存在证据的用户/订单不可被物理删除。

## 6. 后端设计

### 6.1 注册表（`modules/legal/registry.ts`）

- 内置草案在 `documents.ts`；`LEGAL_PAGES_FIXTURE_PATH` 可整体覆盖（每 slug 一个 `<slug>.json`，可省略 slug 字段——由文件名锚定）。
- `resolveLegalDocument(slug, version?)`：未知 slug/版本统一 `null`（路由层 404，不区分两者，防枚举）。
- 测试接缝：`__setLegalRegistryForTests` / `__resetLegalRegistryForTests`（同 `__setRedisForTests` 模式）。

### 6.2 公开 API（无鉴权）

```http
GET /api/legal/documents
200 { "documents": [{ "slug", "title", "version", "updatedAt", "contentHash" }] }

GET /api/legal/documents/:slug?version=x.y
200 { "slug", "title", "version", "updatedAt", "contentHash", "sections": [{ "heading"?, "paragraphs": [] }] }
```

- 特性关闭：两个端点均 404（不暴露特性状态）。
- `Cache-Control: public, max-age=300`（内容随部署固定）。

### 6.3 注册接入

- `registerSchema` 增加 `agreements?: Record<document, version>`（`.strict()` 内声明；≤8 条）。
- `registerUser` 在滥用防护之后、邀请码/查重/bcrypt 之前调用 `resolveConsentEvidence('registration', agreements)`——纯注册表比对，拒绝时零 DB 副作用。
- 证据在建号事务内（`tx.user.create` 之后）落库。
- `GET /api/auth/registration-status` 响应增加 `legalRequirement: { required: [{document, version, title, contentHash}] } | null`，三个返回分支统一注入；前端据此渲染勾选区（null = 隐藏）。

### 6.4 下单接入

- `createOrderSchema` 增加 `agreementVersions?: Record<document, version>`；controller 额外透传 `req.ip` / `user-agent`。
- `createOrder` 顺序（R1 修订）：**已完成记录重放识别（peekCompletedIdempotencyReplay）→ 协议证据解析 → 幂等 claim**。重放识别仅命中"completed + 未过重放窗口 + 指纹匹配"，其余状态回落 claim 的完整分类；协议校验失败发生于 claim 之前，不占幂等键。
- `agreementVersions` 进入请求指纹（LEG-08）；空对象与未传等价（归一化空数组不写入 canonical）。
- `OrderAgreementAcceptance` 在订单事务内 `tx.order.create` 之后落库。
- `GET /api/checkout/preview` 响应增加 `legalRequirement`（含 `enforcement` 字段，同注册镜像语义）。

### 6.5 STALE 契约

```json
409 {
  "error": {
    "code": "LEGAL_AGREEMENT_STALE",
    "message": "协议版本已更新，请重新阅读并确认",
    "details": [{ "field": "agreements.terms", "message": "当前版本：1.1" }]
  }
}
```

前端映射为独立 `ConfirmOutcome` `'agreement_stale'`：换新幂等键、重拉预览（新版本随 `legalRequirement` 下发）、**取消勾选**并提示重新阅读（LEG-10）。注册侧同理：刷新 registration-status 并强制重勾。

### 6.6 留存 cron（`modules/legal/cron.ts`）

- 每小时一轮，舰队租约 `legalEvidenceRetention`（多实例单执行者，test 直通）。
- 对两表执行 `updateMany`：`retentionUntil <= now` 且 `ip`/`userAgent` 尚未全空的行 → 双双置空。幂等，重复执行零副作用。
- 审计：匿名化计数写结构化日志（不含被匿名化的内容本身）；行留存即证据链（LEG-09）。
- 测试接缝：`__runLegalRetentionBatchForTests()`。

## 7. 前端设计

| 位置 | 行为 |
| --- | --- |
| 公开路由 | `/terms` `/privacy` `/refund` `/points-rules` `/about` 五个顶层路由，共用 `LegalDocumentPage`。未登录可达；刷新/直达由 SPA fallback 承载。 |
| 文档页版式（R1 重做） | 「法律文书中心」：桌面端 250px 侧栏（文档导航 + 本页目录锚点 + 文档信息卡：版本/更新日期/SHA-256 内容哈希）+ 正文纸面（居中题名、双细律分隔线、衬线章节题名、首行缩进两端对齐正文、文末落款）；移动端折叠为横向文档切换条 + 单栏文书，哈希落款文末展示；装饰光斑 `overflow-x-clip` 裁剪，全断点（390–1920）无横向溢出。 |
| `api/legal.ts` | 摘要列表模块级缓存（404 → `null`，门禁感知）；`agreementVersionsOf()` 把 `legalRequirement` 摊平为请求体。 |
| Footer | 「协议」（terms/privacy/refund）与「支持」（points-rules/about）两组；功能关闭（404）整组隐藏，不渲染死链。 |
| LoginPage | 注册表单在 Turnstile 之后渲染勾选区（链接新标签页打开，不中断注册）；**仅 `enforcement === 'enforce'` 门控提交**（off 记录模式勾选可选、标注「可选」）；仅在勾选后随请求携带版本；STALE → 刷新状态 + 强制重勾；REQUIRED → toast。 |
| PurchaseModal | 预览含 `legalRequirement` 时渲染退款披露条（要点 + 《退款政策》链接）与勾选区；**仅 enforce 时** `missingAgreement` 参与确认按钮禁用；勾选状态经 `onConfirm` 第五参 `agreementVersions` 回传（未勾选 = undefined，服务端只留证真实确认过的文本）；购买与续费两个入口共用。 |

## 8. 测试

- **vitest**（`server/src/__tests__/legal-pages.test.ts`，23 例）：注册表哈希稳定性、公开 API 开关行为、注册 REQUIRED/STALE/落证/记录模式/关闭忽略、下单 REQUIRED/STALE/同事务落证/幂等重放去重/指纹冲突、留存 cron 匿名化与幂等；R1 新增：协议升级后原 key 重放回归（LEG-05 例外）、非必备文档旧版本同样 STALE + 额外当前版本文档留证（LEG-06）、指纹 `{}`/未传等价与键序无关断言、enforcement 字段下发。
- **config 守卫**（`config-production-guards.test.ts`，+4 例）：矛盾配置拒启、生产 off 拒启、生产 fixture 拒启。
- **e2e**（`e2e/legal-pages.spec.ts`，独立栈 `playwright.legal-pages.config.ts`，`LEGAL_PAGES_ENABLED=true` + `ENFORCEMENT=enforce`，独立端口 3104/5179）：五页匿名直达 + 刷新、footer 分组与跳转、注册勾选门控全链路、下单勾选门控 + 退款披露 + 成交、API 层 REQUIRED 契约。运行：`npm run e2e:legal`（数据库默认 `monexus_legal_test`，可用 `LEGAL_E2E_DATABASE_URL` 覆盖）。

## 9. 上线步骤

1. `prisma migrate deploy`（两张证据表）。
2. 部署后端并设置 `LEGAL_PAGES_ENABLED=true`、`LEGAL_PAGES_ENFORCEMENT=enforce`（生产缺任一项拒启）。
3. 部署前端。旧前端在新后端下完全可用（LEG-04/LEG-05 的服务端裁决独立于前端版本；旧前端不携带 agreements 时将被 enforce 拒绝——因此**前后端必须同批发布**，或先在记录模式（off）下发布后端、前端上线后再切 enforce）。
