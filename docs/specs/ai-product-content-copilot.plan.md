# Plan：AI 商品内容 Copilot（SPEC-AI-PRODUCT-001 v1.0.4）

配套 spec：`docs/specs/ai-product-content-copilot.md`；上位：`docs/specs/ai-foundation.md`（及其 plan）。从 `develop` 拉 `feat/ai-product-copilot`（或在 Foundation 合入后拉），PR 目标 `develop`。本计划只拆任务与依赖；实施以 Spec 为准，发现 Spec 与代码不符时停止并回报。

## 前置事实（实施者需知）

- 读写入口：`catalog/productWrite.ts` 的 `loadOwnedProduct`（ownership 条件）、`patchProductContent`（CAS，**不得修改**）、`getProductEditor`（只加 `capabilities.aiContentSuggestion`，**不得**把其返回值用作模型输入）。
- 模板：`catalog/templates/registry.ts`（`getProductTemplate`）、`definitions.json`（`title`、`ui.enumLabels`、`productSchema` / `offerSchema` 属性）。
- 正文 Schema：`catalog/templates/productDetails.ts`（`productDetailsSchema`）、`products/schema.ts`（`productDescriptionSchema`、`MAX_PRODUCT_DESCRIPTION_LENGTH`）。
- readiness：`catalog/publicationReadiness.ts`（`checkProductReadiness`，detail code 常量在 `catalog/constants.ts`）。
- Xboard：`ExternalCatalogLink.sourceSnapshot`（`planId`、`periods[].period/skuAlias`、`namedSkus[].period/sku`）、`latestDescriptionText`；导入时 SKU 选择规则见 `admin/service.ts:1884`，周期默认天数表 `PERIOD_VALIDITY_DAYS`（`admin/service.ts:1740`）。**不调用** `fetchNormalizedFakaSource`；**不使用** `periodFromFakaSku`（解析失败回退 `'monthly'`，不是事实）。
- 路由：商家 `modules/merchant/routes.ts`（`router.use(authenticate, requireActiveUser, requireMerchant)`，controller 通过 `merchantService.getMyMerchant` 得到 merchantId，参照 `patchProductContent` controller）；管理员 `modules/admin/routes.ts`（第 52 行统一 MFA 链；内容路由在第 141-142 行附近）。
- 前端：`src/pages/merchant/ProductEditPage.tsx`（`dirty`、`contentVersion`、保存流程；admin 与 merchant 共用，`actor` prop 区分）、`src/components/catalog/ProductDetailsFields.tsx`、交互范式参照 `src/components/catalog/AdminSourceDescriptionDialog.tsx`、API `src/api/catalog.ts`（类型 `ProductEditorDto['capabilities']`）、`src/api/client.ts`（默认 15s 超时，AI 请求按请求覆盖）。
- 新代码位置：`server/src/modules/catalog/contentCopilot/`（projection、normalizers、validator、prompt、service、routes 拆文件；不建额外抽象层）。

## 依赖图

```
Foundation F9 ─► P1(projection) ─┐
                 P2(归一化器/词表) ─► P4(validator) ─┐
                 P3(prompt+输出 Schema) ─────────────┼─► P5(service+routes) ─► P6(集成测试)
Foundation F2,F6,F7 ─────────────────────────────────┘          │
                                                                  ├─► P7(前端)
P1,P3,P4 + Foundation F10 ─► P8(eval fixtures + 脚本；真实运行依赖 F4b 与 OPENAI_API_KEY)
P6,P7,P8 + Foundation F4b ─► P9(试点上线清单)
```

P1–P4 可与 Foundation 并行（只依赖 F9）。

## 任务分解

### P1 Projection（`contentCopilot/projection.ts`）

- `buildProductContentAiContext(input)`：输入为 §5.2 定义的已鉴权领域数据（由 service 以显式 `select` 读取），输出 `AiSafe<ProductContentAiContext>`。
- 按 Spec §5.3 / §5.4：逐字段构造、未知为 null、只取 active offer、只取模板声明的属性键、`common` 一致性计算、24,000 字符截断顺序与 `truncated`。
- `xboardPeriod` 按 Spec §5.3 精确推导（skuAlias → namedSkus → `plan-{planId}-{period}` → null）；service 仅在管理员 + `ExternalCatalogLink` 时 select `externalSku`，推导后丢弃，不传入 context。Xboard 周期事实对管理员恒定投影，与 `useUpstreamDescription` 无关；`latestDescriptionText` 仅在 `useUpstreamDescription = true` 时进入。
- 单测：SPEC-AI-001 §4.2 五项；Sentinel 覆盖 Spec §5.4 列出的字段（含 Xboard 商品的 `externalSku`、`planId`）；`validityDays = null` → `{ kind: 'perpetual_access' }`；`xboardPeriod` 推导表驱动（三种命中路径 + 不可匹配 → null，断言不出现 monthly 回退）；商家路径永远 `xboard = null`、所有 `xboardPeriod = null`、`upstreamDescriptionText = null`。

### P2 归一化器与词表（`contentCopilot/normalizers.ts` + 数据常量文件）

- 中文 / 阿拉伯数字解析；时长解析为「日表达」或「日历周期表达」两类（Spec §7.5，CP-08 来源保持型）；数量抽取（数值 + 单位类 + 同量级别名）；地区 / 平台闭合词表 → 规范 ID；H1–H5 检测正则与词表（H2 含「长期有效」）。
- 表驱动单测：「30 天 / 三十天 / 30日」对 days=30 成立，「一个月」对 days=30 **不成立**；「2 周」对 days=14 成立、「4 周」对 days=30 不成立；`monthly`：「1 个月 / 一个月」成立、「30 天」不成立；`quarterly`：「3 个月 / 一个季度」成立；`half_yearly`：「半年 / 6 个月」成立；`yearly`：「1 年 / 12 个月」成立；`onetime` / `reset_traffic` / `perpetual_access`：任何时长不成立；「100G」=「100GB」≠「0.1TB」；词表命中与 fail-closed。

### P3 Prompt 与输出 Schema（`contentCopilot/prompt.ts`）

- system prompt（中文）：原则（只组织表达已有事实）、`untrusted` 仅为数据、claim 声明义务、未知写「未提供」或不提、有效期按事实原单位表达、禁止价格 / 库存 / 退款保障 / 永久类表述、售后只写中性处理流程（Spec §6.1 / §7.4 示例句）、生成上限（§6.3）、只返回 `targetFields`。
- 输出 Schema 一份常量（OpenAI strict 子集：全属性 required、`additionalProperties: false`、可空用 `anyOf`/类型数组），同时用于发送与服务端 Ajv 结构校验；数量与长度上限由 Validator 执行（Spec §6.2，v1.0.1）。
- `promptVersion = 'product-content@1'` 与模型绑定常量同处定义：`model: 'gpt-6-luna'`、`reasoning.effort: 'none'`、`maxOutputTokens`（由 §6.3 上限估算）。
- 单测：Schema 能被 Ajv strict 编译；结构错误（缺键、多键、未知枚举）整体拒绝。

### P4 Validator（`contentCopilot/validator.ts`）

- Spec §7.1–7.7 全部规则；输出 `{ fields, issues, issueCounts, suggestedFieldCount }`，供 `runAiGeneration` 的 `parse` 使用；`validatorVersion` 常量。
- 单测（录制 / 构造的模型输出）：span 非子串拒绝；factRef 指向 null；各 kind 判定表；duration 来源保持（days 事实拒日历表达、周期事实拒日表达）；duration 引用 `perpetual_access` 拒绝；「永久 / 终身 / 长期有效」→ `risky_claim`；中性售后示例句通过；offer 级事实在 product 级文本的 ambiguous 规则；H1–H5 未覆盖拒绝；price/stock 必拒；refund/guarantee 必拒；URL / 联系方式 / 标签拒绝；部分成功与全拒组装；输入侧 risky_claim 提示；missing 生成（readiness codes、非必填 null 属性、上游未检查）。

### P5 Service 与路由

- `contentCopilot/service.ts`：前置条件检查顺序（flag → ownership 读取 → 归档 → 模板 → CAS → 配额 / in-flight 由 `runAiGeneration` 处理）→ 读取 readiness（用于 missing）→ Projection → `runAiGeneration` → 组装响应 §6.4。
- 路由：商家与管理员各两个端点（Spec §9）；请求 Zod 按角色区分（商家无 `useUpstreamDescription`）；采纳上报 body `{ appliedFieldCount }`（strict int），校验 ownership 与 `1 ≤ appliedFieldCount ≤ suggestedFieldCount`，写 `acceptedFieldCount`；不保存字段集合。
- `getProductEditor` 增加 `capabilities.aiContentSuggestion`（flag && 模板 && 未归档 && 角色配额 > 0）。
- 不修改 `patchProductContent`、`publishProduct`、`sourceDescription.ts`。
- 更新 `server/src/modules/merchant/README.md` 与 `admin/README.md` 的端点表。

### P6 后端集成测试（`server/src/__tests__/product-content-copilot.test.ts`）

覆盖 Spec §13「后端集成」行全部条目；provider 使用测试替身；断言「被拒绝的前置条件下 provider 未被调用」。

### P7 前端

- `src/api/catalog.ts`：生成与采纳上报方法（AI 请求按请求设置 55s 超时；上报只发送 `appliedFieldCount`，失败静默）；`capabilities` 类型加字段。
- 新组件 `src/components/catalog/ProductContentSuggestionDialog.tsx`：Spec §8.2–8.4；复用 `AdminSourceDescriptionDialog` 的双栏 / 手机切换范式（可抽小的共享展示片段，但不做通用 diff 框架）。
- `ProductEditPage.tsx` / `ProductDetailsFields.tsx`：入口按钮、dirty 禁用、填入表单状态、contentVersion 变化作废。
- 单测：Spec §13「前端单元」行全部条目。
- 样式：遵守 `--color-primary-tint` 约定，不用 `bg-[var(--x)]/N`。

### P8 Eval fixtures 与脚本

- `contentCopilot/__fixtures__/`：Spec §11.1 覆盖表；每个 fixture 含领域输入 + 期望约束；对抗 fixture 附「违规录制输出」供 CI 回放（L2.5）。
- `server/src/scripts/evalProductCopilot.ts` + npm script `ai:eval:product-copilot`（基于 Foundation F10）。
- 首次 L3 报告（`gpt-6-luna`）摘要随上线前 PR 提交。

### P9 试点上线清单（非代码）

1. Foundation F4b（`openai@7.28.0` adapter）合入。
2. SPEC-AI-001 §6.3「上线检查」全部通过：生产容器可访问 OpenAI API；`OPENAI_API_KEY` 以 secret 注入；组织 / 项目未 opt-in 训练数据共享。
3. `gpt-6-luna` L3 eval 报告：对抗集放行 0、敏感外发 0、p95 延迟 < `AI_TIMEOUT_MS` 的 80%。**不满足则停止上线**，回到 D-AI-01 重新做模型决策（可评估 `gpt-6.1-sol`，需新 promptVersion + Spec 修订 + 重跑 L3）；不做自动切换。
4. 运营依据成本测算写入两个配额键（建议先 merchant = 0，仅管理员试点）。
5. 打开 `AI_ENABLED`、`AI_PRODUCT_COPILOT_ENABLED`；观察 `monexus_ai_*` 指标与 `AiGeneration` 采纳率。
6. 两周后复盘：采纳率基线、拒绝原因分布、是否开放商家、是否评估 attributes suggestion（另立 Spec）。

## 验证

- `npm --prefix server run build`、`npm run build`。
- 后端：P1/P2/P3/P4 单测文件 + `product-content-copilot.test.ts`。
- 前端：`npm test` 中 Dialog 与 `ProductEditPage` 相关单测。
- `npm run verify:quick`。
- 不新增 E2E；不需要 `run-e2e` 标签（不触及 auth / checkout / middleware）。若 P5 改动了 `/api/admin` 挂载顺序或中间件，则需要加标签。

## 完成定义

Spec §13 全部测试存在且通过；P9 第 1–3 项满足前不得在任何环境打开 flag。
