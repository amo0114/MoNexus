# Spec：AI 辅助新建商品

文档 ID：SPEC-AI-PRODUCT-002；版本：1.0.0；日期：2026-10-07。

## 目标与流程

管理员和已审核商家可以在新建商品入口选择「AI 帮我建商品」：输入公开商品介绍 → 核对集中预填表单 → 经现有创建接口保存一件草稿，并进入编辑页。第一版创建一个主规格，其他规格、图片、交付内容、库存和发布可在草稿中继续配置。人工新建入口保持可用，切换不覆盖原人工表单。

AI 只提取和归拢输入，不负责填补事实。形态和分类是候选建议；全部结果在保存前须由用户明确核对。价格、有效期和交付方式由用户填写/选择；不从模型输出采纳。未知有效期不默认为永久，用户必须明确选择天数或无固定有效期。草稿初始可售量为限量且为 0、仅登录可浏览；不设置自动开通，不生成库存、购买资料或付费交付内容。

## 配置、权限与运行时

这是商品 Copilot 的新建操作，与说明整理共用 `product_content_copilot` 开关及按角色每日配额，后台明确说明共用额度；服务地址、模型、密钥复用统一配置。不同操作使用独立 prompt/schema/validator。

- `GET /api/{admin|merchant}/products/draft-assistant` 返回 `{available:boolean}`，不暴露服务商或密钥。
- `POST /api/{admin|merchant}/products/draft-suggestions`，严格请求 `{description:string}`，1..4000 字符。禁止传入产品 ID、身份、密钥、付费内容和其他编辑器 DTO 字段。
- 继承各自新建接口的 active user / admin + MFA / approved merchant 权限链。没有既有商品读取，不存在跨商品或跨租户查询。
- 仅 `runAiGeneration` 调用 provider，`targetType=product_draft`，`targetId=actorUserId`，用于该用户新建操作的并发去重；不创建占位商品。迁移只扩展 `AiGeneration_targetType_check`。
- 元数据不保存输入、输出或问题原文；生成本身不写 Product/Offer。失败计入调用额度，参数/权限/上下文超限失败不计入。
- 固定 `product-draft@1`、`product-draft-validator@1`、reasoning=none、maxOutputTokens=4000。前端超时 55 秒，现有运行时超时与错误码保持一致。

## Projection

`draftAssistant/projection.ts` 显式构造并标记 AiSafe：

- `facts.templates[]`：本地模板 key/label，productFields/offerFields[] 的 key/label/type、枚举 value/label；不复制 schema 或模板对象。
- `facts.categories[]`：当前可用分类的 id/label。
- `facts.product=null`：商品尚未创建，没有已核实商品事实。
- `declared={}`；`untrusted.description` 为专用公开介绍输入，不读取其他表单内容或数据库商品。
- `truncated`：输入截断为 4000 字符；总 context 上限 24000 字符。仅可继续截断介绍；不可截断治理目录。仍超限则 422 AI_CONTEXT_TOO_LARGE，无模型调用、无配额扣除。

UI 提醒只输入可公开的介绍，不填账号、密码、卡密或实际交付内容；原文仅保留组件内存，不进浏览器持久存储。

## 输出与校验

静态 strict JSON Schema，全部字段 required，未知用 null/空数组。字段：templateKey、categoryId、name、description、offerName、productAttributes/offerAttributes（key + values 字符串数组）、details（highlights、usageInstructions、purchaseNotes、afterSalesInstructions）。没有价格、库存、交付配置、URL、HTML 或身份类字段。

1. Ajv 完整 schema 验证类型、长度和数量；额外字段/不合法结构导致 AI_OUTPUT_INVALID。
2. 形态、分类只能引用本轮目录；未知或不在目录的候选丢弃。
3. 所有普通文本和每个属性值必须是输入中的原文片段，不能编造或改写数值，也不能把 130 截取成 30。枚举仅按模板值/显示标签映射，数字仅接受原文中的规范整数；未知字段、重复键、错误类型、越界属性由模板校验拒绝，不转成事实。沿用说明 Copilot 的 H2/H4/H7 和禁用标记检测，含永久无限、保证退款、价格折扣或链接/联系方式的候选整项留空，即使存在原文；需要表达时由用户手动核实填写。
4. 属性再走本地 `validateTemplateAttributes(mode=draft)`，未识别字段留空。返回丢弃数量及按模板必填项计算的待补充项，不回显被拒绝模型内容。
5. 全部输出是待人工核对的提取候选。原文片段匹配不代表语义、否定关系或字段归属已经核实；集中预览明确标记这一点。保存由用户确认，现有后端模板、分类、交付相容性、草稿和发布门禁仍是权威。

缺失信息或不相关输入返回空候选，用户可补充介绍重试或切回手动；不靠模型输出问题文案或伪造默认值掩盖缺失。生成途中不自动写表单，旧请求、关闭后的响应不可覆盖当前结果。再次生成须明确提示将替换本次预填结果，人工表单独立保留。

## 验证

- Projection：复用 aiProjection 帮助函数，哨兵/键白名单/未知保持/截断/目录超限。
- Validator：无依据文本、编造整数、非法模板/分类/属性、额外敏感字段、重复字段、正常文本与枚举映射。
- 集成：管理员 MFA/商家权限、开关/配额、同用户新建去重、与说明整理共用额度、模型错误、元数据无内容、生成不创建商品，确认后仍由原接口创建 draft。
- 前端：只有显式点击才生成；可编辑预填、缺失交易字段阻止创建、确认前无写入、保存错误可重试、防重复提交、关闭后过期响应丢弃、原人工路径保持可用。
- L3：少量公开合成样本验证真实服务结构提取、原文校验、空输入语义和提示注入边界；不使用真实商品/客户数据。报告只在被忽略的 server/.ai-eval/ 下保存。

结构化输出并不保证事实正确，未知值必须有空值通道。依据：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)，2026-10-07 核对。

## 本地验收记录（2026-10-07）

- 后端：新 Projection/Validator、权限/配额/并发/超时/创建集成、现有内容 Copilot 和 ProductWrite，共 47 个用例通过。
- 前端：辅助创建、原管理员/商家创建页、后台配置，共 42 个用例通过。后续确认页调整另跑辅助创建用例。
- 独立测试库全量迁移重放成功，Prisma schema 无漂移；预览库仅应用新增元数据目标约束迁移。
- 浏览器 API 测试桩冒烟：390px / 1280px 无横向溢出、无页面异常；切回人工表单保留已填内容，不触发业务写入。Windows 侧新建页和后端健康接口均返回 200。
- L3：当前后台配置模型 `gpt-6-luna`，5 个公开合成样本全部通过，p95 8778ms；覆盖固定文字指南、数字文件、人工服务、无关输入、指令注入。报告 `server/.ai-eval/product-draft-1791363658210.json`（不入库、不提交）；使用 `npm --prefix server run ai:eval:product-draft` 可复跑。这是小样本本地验证，不代表所有商品类型和输入都已充分评测。
