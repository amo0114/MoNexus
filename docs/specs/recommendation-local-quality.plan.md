# 本地目录驱动的商品属性建议与推荐准入方案（PR3 / PR4）

| 项目 | 内容 |
| --- | --- |
| 文档 ID | `PLAN-RECOMMENDATION-LOCAL-QUALITY-001` |
| 版本 | `1.1.0` |
| 日期 | 2026-10-15 |
| 状态 | v1.1.0；单元 A 已合入（#257），结论为保留 C0（见 [本地审计报告](../reviews/recommendation-local-quality.md)）；单元 B 已在 `feat/product-attribute-guidance` 本地实施，待 review；C 不建 PR |
| 核验基线 | `origin/develop@297ee6554141a842bff6c4cae479a2ce15cf6449`，`feat: add public merchant storefronts (#256)`；本轮重新 fetch 确认 |
| 方案分支 | `chore/recommendation-quality-local-plan`，独立 worktree，未设置 upstream |
| 实施责任 | 另一个实施 agent 负责审计扩展、后端、前端设计、测试与报告；完成后交回方案编写 agent review |
| 关联 | [原路线 §9](public-product-availability-and-recommendation-quality.plan.md)、[PR2 生产审计](../reviews/recommendation-data-audit.md)、[推荐 V1](product-detail-recommendations.plan.md)、[PR5 事件契约](recommendation-events.plan.md) |
| 工程规范 | [分支与 CI](../branching-and-ci.md)、[测试政策](../testing-policy.md) |

## 1. 决策与目标

采用本地商品目录推进 PR3、PR4，无需等生产目录扩大后才开始。交付分为三步：

1. **本地审计与离线比较**：复用 PR2 工具，确认数据组成，输出当前规则及两种候选准入的差异，形成可复核案例。
2. **PR3 属性填写建议**：在共享参数控件中提供填写说明和经审核的可选名称，保留自由输入、原值和原保存流程。
3. **PR4 准入决策及必要实施**：依据报告选择保留现状，或启用有证据支持的有限收紧。离线比较不直接切换真实接口。

PR3 可在本地审计后实施，不依赖 PR4 必须改规则。PR4 的比较工作现在推进；运行时策略仍需由比较结果支撑。各阶段都可以产出完整、可 review 的结果，不以“生产样本太少”为由停做本地分析，也不为完成 PR 编号强行改变推荐。

本地数据回答的是字段分布、目录兼容性、规则前后差异和具体商品是否相关。点击率、兑换率与增量收益仍需真实使用数据；不把离线推荐位指标写成线上效果。

## 2. 本轮已核验的数据事实

### 2.1 本机目录初步计数

2026-10-15 `06:52:31 UTC` 起，在现有本机应用数据库执行只读事务，仅查询目录元数据计数；没有连接生产、读取库存/交付内容、订单或买家资料，也没有运行 seed、迁移或测试。下表是这一时点的本地观察，实施时须重新记录实际快照范围。

| 维度 | 本轮计数 |
| --- | --- |
| Product 总数 | 860 |
| active、未归档、经营者有效 | 844；与 active 且未归档的数量相同 |
| 审计范围内有 active Offer | 844 |
| public / members_only | 74 / 770 |
| 模板缺失（key、version 均为 null） | 822，约 97.4% |
| 已知模板 | 22：`fixed_content@1` 17、`manual_service@1` 4、`account@1` 1 |
| 有主匹配字段的已知模板 | 18；本次检查这些字段均为非空字符串，不代表语义规范 |
| 分类 | invite-code 279、recharge-card 257、network-node 165、shared-account 143 |
| 平台商品 / 非空商家 ID 数 | 119 / 2 |
| 有 ExternalCatalogLink / 有 Faka Offer | 0 / 0 |

本次只做了范围、结构和来源标记计数，**尚未运行完整名称分布、推荐位模拟、人工相关性标注或候选规则对比**。不据此称 844 件均为真实经营商品、均为测试商品，或已有七模板代表性。

历史的 830 / 759 是 2026-09-29 本机库记录，不是本轮固定分母；当前目录会变，不把数量变化解释为异常。生产报告中 2 件商品的结论仍保留在其原环境、原时间范围内。

### 2.2 对方案的直接影响

- 这批目录适合验证 legacy 兼容和推荐覆盖变化。若策略使未知模板基准一律无候选，按本次组成会使至少 822 个基准为空；这是规则的确定性后果，**不是已跑出的全量比较结果**。
- 已知模板只有 22 件，且缺少 redemption_code、subscription、digital_file、appointment 的范围样本；不能用总量掩盖这些空白。
- 不存在可靠的“人工 / AI / 测试造数”商品来源列。ExternalCatalogLink 只能确认记录到的导入；无记录不证明从未导入，文案风格和相似标题也不能证明 AI 或种子来源。
- 仓库 `seed.ts` 的四个平台商品和一个示例商家商品，本身不能解释 800 多件目录。固定名称、ID 或创建时间只能提示核查，不能自动排除。

因此先对全范围保留事实统计，再按可核实来源和模板分组解释；来源未知不阻止审计，但不能进入“已确认真实经营样本”的分母。

## 3. 范围与不变量

本轮不新增数据库表、商品来源字段、标准服务 ID、别名映射服务或管理后台；不迁移、批改、自动补全历史商品。建立独立标准实体属于以后另行评估的工作。

不改变分类、七模板 Schema/必填条件/版本、模板绑定后的形态锁定、发布状态机、套餐履约、可售三态、库存、结算及订单事务。PR3 不改变匹配语义；PR4 不加入语义搜索、向量、LLM、行为排序或个性化。

推荐仍为：同分类、既有权限与 active Offer 条件、每组排序后最多 64 个候选、合格同店优先再跨店补足、最多 6 件。不同已知模板和已填写但冲突的主值继续排除；平台 `merchantId=null` 分桶保留。不可售过滤继续复用公开投影，unknown 保留原位置。

全部实现由接手 agent 承担。本文约定业务行为、数据口径、进入条件和必要验证；代码锚点及落点是实施参考。模块划分、内部命名、前端布局与控件表现可结合项目决定，不逐项请求设计确认，不新建通用治理框架。

## 4. 已核对的代码锚点

| 代码 / 符号 | 事实及复用方式 |
| --- | --- |
| `server/src/modules/products/recommendations.ts` / `RECOMMENDATION_POLICIES`、`normalizedStringAttribute`、`queryRecommendationCandidates` | 模板策略、SQL 归一化和评分的唯一来源；归一化只去首尾 ASCII 空格、折叠 ASCII 大小写 |
| `server/src/modules/products/recommendationAudit.ts` / `loadScope`、`nameDistribution`、`recommendationSlots` | 范围、名称统计与 member 候选模拟已有实现；保留并扩展，不另写一套推荐 SQL |
| `server/src/scripts/auditRecommendationData.ts` | 已有 `--format=json\|md`、`--samples=1..200`；样本截断不影响总数，但现有输出不是全部配对清单 |
| `server/src/modules/products/service.ts` / `getProductRecommendations` | 合并最多 64+64 个候选，统一补全，过滤 unavailable，再取前 6；不是仅对预先前 6 做过滤 |
| `src/components/catalog/TemplateAttributeFields.tsx` | product/offer 共用控件；目标字段目前是 text input，写入经原 onChange |
| `PresentationStep.tsx`、`AdminPlatformProductWizard.tsx`、`ProductInformationSection.tsx` | 商家人工创建、平台人工创建和双方商品编辑复用上述控件 |
| `src/components/catalog/ProductDraftAssistant.tsx` | 商家/平台 AI 草稿在保存前也用同一参数控件；再次生成仍有现有逐字段采纳流程 |
| `server/src/modules/catalog/draftAssistant/validator.ts` | AI 参数要求来自原文；本轮不改 prompt、提取校验或模型配置 |
| `server/src/modules/admin/service.ts` / `importAdminFakaPlan` | 导入以商品名填 serviceName；请求没有 attributes 编辑能力，本轮只审计并通过既有编辑页人工确认 |
| `server/src/modules/catalog/fakaSync.ts` | 同步不应覆写本站参数/文案；本轮不改变导入和同步协议 |
| `server/src/modules/recommendationEvents/token.ts` | 当前签发和验签都写死 `pdp-rec-v1`；运行时改规则时需要一起处理版本兼容 |
| `server/src/modules/recommendationEvents/report.ts` | 已按 strategyVersion 分组，事件表为字符串，无须新增表或报表口径 |

## 5. 第一步：本地只读审计与离线比较

### 5.1 数据入口与来源核查

使用本机目录的固定快照或隔离副本；不把保存了业务配置的本机应用库当作可丢弃测试库。分析过程仅 SELECT，不对源库运行 Vitest、seed、迁移、清表、重置或数据清洗。

快照方式固定为：用 `pg_dump` 导出本机应用库，恢复到一个独立的本机库（命名如 `monexus_audit_snapshot_YYYYMMDD`），审计只连接该快照库。不用 `createdb -T`（源库有连接时会失败），不对应用库执行任何写入、迁移或清理，应用库保持原样。若快照的迁移版本落后于审计代码，只允许在快照库上补跑迁移，并在报告中记录。

在同一份冻结快照上比较所有策略。导出文件和快照库都含本机用户数据，只留在本机、不进入仓库；审计结束后删除快照库与导出文件。报告记录快照库名、采集时间、代码 SHA、范围条件和数据是否稳定；连接串、凭据和完整本机路径不作为报告正文内容。

来源分为两条轴，不能混为一个猜测标签：

1. **机器可证实的记录**：有 ExternalCatalogLink、只有 Faka Offer 没导入记录、两者均无记录；沿用 PR2 定义。
2. **目录用途证据**：经既有导入/生成脚本、明确记录或项目负责人核实的真实经营、演示/测试，或无法确认。标记保存在本地审计附表，不写回 Product。

只复核能改变解释的少量创建时间簇、已知脚本与代表商品；不要求逐件追溯历史，也不新增 AdminLog/User/订单遍历。没有可靠证据的保持“用途未确认”，不能靠标题正则直接扔掉。

字段范围沿用现有审计的 Product 名称、分类、模板属性、商家公开资料、Offer 启用与外部接入标记、ExternalCatalogLink 记录，必要时增选 Product.createdAt / visibility 作分组。不读库存内容、交付内容、买家数据，不调用 Xboard 或真实模型。

### 5.2 修正既有报告的解释

现有审计取“同店候选 + 跨店候选”的前 6 位，发生在可售过滤之前。它可以衡量 SQL 准入与位置竞争，但**不是最终展示列表**。

当前 `recommendationAudit.ts` 渲染文案中的“可售过滤只会进一步减少展示数”需要改为：

> 本指标是可售过滤前的前六候选。实际接口对完整的最多 128 个候选补全、过滤后再取六件，后续候选可能补位，因此最终商品与位置需要单独核验。

同步修正 PR2 报告的通用口径说明，保留其历史数字和生产环境结论。此前生产样本每个基准只有一个候选，不因此改算历史结果。

本次主分析保持元数据边界，**不为离线比较调用 getProductRecommendations 或 hydratePublicListItems**：后者会读取履约事实并可能触发 Faka 后台探测。可售后表现只在隔离测试库用既有 availability fixture 验证接线，不把测试库存当成目录效果，也不重建第二套可售规则。

### 5.3 输出内容

在原脚本增加一个明确的 `--compare` 模式；普通运行的行为和默认推荐策略不变。不新增公网接口、运行时开关、定时任务或在线影子查询。

比较执行规则在 §7。保留现有名称分布、完整度、旧模板占比和来源统计，并新增：

- member 全范围与 guest 可访问基准分别统计；guest 的基准只含 public 商品，不能请求本来不可访问的 members_only 基准来充样本。
- 按分类 × 已知模板/legacy × audience 拆分；平台自营和真实商家分开，必要时提供经营者分布，避免两个商家或大类主导总平均。
- 各规则的 0..6 位直方图、有候选基准数、空结果数、tier 及同店/跨店位置分布、同店 tier<3 占位且跨店 tier3 落选数。
- 每个基准的候选前六 ID、tier、同店关系，以及相对基线移除/新增/位置变化；这些明细在本地 JSON 中保留，支持人工复核。它们是“可售前候选位”，不用曝光/点击命名。
- 各桶返回 64 条时标记“达到截断上限”；未统计截断前总数就不报告“全部合格候选数量”或全目录召回率。

所有汇总使用完整审计范围；`--samples` 只控制汇总报告中名称和案例列表的长度，不能先截取 200 个基准再声称统计了 844 件。每个截断案例列表都给出总项数、展示项数或截断标记；完整配对明细与汇总样本分开。

建议命令如下，**须在实现 --compare 后使用**；Node 22 / npm 10，数据库地址通过本地环境配置：

```bash
REDIS_ENABLED=false npm --silent --prefix server run recommendation:audit -- --format=json --samples=50 --compare > /tmp/monexus-recommendation-local-comparison.json
```

一份 JSON 作为事实来源，Markdown 从该结果生成；不为两种输出反复查目录。逐基准执行，桶查询保持现有的小规模并发，不增加批处理平台或高并发扫描。

### 5.4 人工相关性复核

无需把 844 件全部两两标注。先查看规则发生变化的基准，按下面几类选代表案例，并为每类标明可用数量和选取方式：

- 已知模板有主值：同义不同写法、主值相同但商品用途不相关、主值冲突。
- 已知模板主值缺失；与“模板没有主字段”分开。
- 同店 legacy 占位与跨店强匹配、legacy 作为基准。
- 无主字段的 manual_service / appointment。

复核按有方向的“来源商品 → 目标商品”记录：同一 `(audience, sourceId, targetId)` 只标一次，`A → B` 与 `B → A` 是两条记录；可记录现规则/候选规则中的位置。标签为“相关 / 不相关 / 信息不足”，附简短依据；不能用 tier3 本身当作人工“相关”标签，也不能按有无同店关系直接判断。

复核依据仅用公开名称、说明、分类和模板属性。信息不足单列，不强行算错或算对。标签与不必要的完整商品文案保存在仓库外；报告保留少量必要案例，不生成训练集或调用 LLM 代替人工结论。

抽样结论只适用于抽到的案例，不写成全量准确率或统计显著提升。若计算标签内占比，明确已标注数量、可判断数量与信息不足数量；没有相关商品全集，不报告“真实召回率”。

## 6. PR3：共享参数填写建议

### 6.1 业务行为

目标是帮助填写现有字段，不增加推荐专用参数。覆盖：

| 模板 | 字段 | 填写提示的重点 |
| --- | --- | --- |
| redemption_code / account / subscription | serviceName | 写适用产品或服务名称；周期、额度和套餐权益仍放各自规格字段，不能把每个周期都变成不同服务名 |
| digital_file / fixed_content | contentCategory | 写实际内容类型，避免把商品标题或套餐名称整句复制为类型；两种模板分别审核适用词条 |
| manual_service / appointment | 本轮不新增主字段 | 不强制补 serviceName/contentCategory；维持现有参数与推荐语义 |

上述为填写说明，不是自动正则清洗。某些版本、地区、服务模式确实可能代表不同服务，不能一概删除词语。例如 Steam 与 Steam Wallet 只是待确认关联示例，不在本轮自动建立别名。

在共享字段控件增加：

1. 简短、非阻断的填写说明；仅目标 product 字段显示，offer 同名键和其他模板不串用。
2. 有经审核词条时提供可选名称；仍是自由文本，用户可输入列表外的值，也可保留 AI 或既有原值。
3. 用户主动选择后，通过原 onChange 改当前未保存表单；不自动保存、发布或修改历史记录。再次输入或清空按现有控件语义处理。

既有必填、长度、发布错误继续由模板与服务端决定。自定义值不标“无效”或“不可推荐”，不要求逐条关闭提示。采用建议不承诺曝光，也不把规范建议并入 publicationReadiness 的阻断错误。

### 6.2 建议词条的来源与最小结构

使用一份小型静态配置，建议放在 `src/components/catalog/attributeGuidance.ts`，按 `templateKey@version + fieldKey` 索引，两个字段分别维护语义。只含简短说明与审核后的显示/写入值，不增加 aliases、正则替换、模糊阈值或推荐 canonical ID。

建议集版本与审核依据写在该配置和交付报告即可；不改模板版本或 registry DTO，不为纯前端说明新增 API。模板 Schema 的 enum 不能用作建议列表，否则会把自由文本变成保存限制。

词条来自本地名称审计和逐项核实，不能把高频值自动升级成标准；频率高也可能是复制或错误。当前仅 1 件 account 和 17 件 fixed_content 有主值，其他模板可以先只有填写说明，不为了覆盖七模板填入一大套通用品牌或内容词库。

每个纳入的建议值在报告中给出适用模板、含义与审核依据。未经确认的同义、包含关系留在审计报告，不进入自动映射。一次建议选择直接写明示值，服务端仍按原 SQL 精确语义匹配，不暗中增强归一化。

### 6.3 入口、AI 与导入边界

- 商家人工向导、平台人工向导、双方既有商品编辑与 ProductDraftAssistant 统一复用共享控件；不在每个入口再做一份独立建议逻辑。
- AI 仍从原文提取属性。建议只在提取后的人工编辑阶段出现，不修改模型 prompt、校验器、sourceQuotes 或生成配额；用户没有选择时保持 AI 原值。
- AI 二次整理继续按已有差异采纳机制处理，不新增来源持久化或“自动再次规范化”。未保存值发生变化时，确认状态沿用现有重置机制。
- 当前没有可靠 AI 商品来源标记，不显示“这个商品由 AI 创建”或按风格推断来源。
- Xboard 导入初始映射本轮不改，不增 import attributes 参数。确认需要规范名称时，在既有商品编辑页手动处理；同步不得覆盖人工参数。不用本地缺少导入样本支持自动剥离周期/套餐词的规则。
- 保存前的形态锁定提示先核对已有位置；有清晰提示就复用，没有则在确认保存处补一句，不新增弹窗审批或重复确认。

前端可使用原生 datalist、建议按钮或符合项目习惯的轻量控件，由实施 agent 决定；保证键盘可操作、已填值可读、手机不挤压、disabled 不可改值即可。不固定列数、像素或组件库，也不为这些说明重做创建向导。

## 7. PR4：离线候选规则与选择条件

### 7.1 三种固定比较规则

以下 C0/C1/C2 仅是本轮离线比较标签，**不是生产的 strategyVersion，也不对外暴露 query 参数**。

| 基准情况 | C0 当前规则 | C1 已知模板锚定（优先评估） | C2 严格参照（诊断上限，不直接上线） |
| --- | --- | --- | --- |
| 已知模板，有主字段，双方主值可比较且相同 | tier3 保留 | 保留 | 保留 |
| 已知模板，有主字段，但基准或候选主值缺失 | tier2 保留 | 保留并单列缺值样本 | 排除 |
| 已知模板，本身没有主字段，候选同已知模板 | tier2 保留 | 保留 | 保留；不要求虚构主字段 |
| 已知模板基准，候选 legacy/unknown | tier1 保留 | 排除 | 排除 |
| legacy/unknown 基准 | 同分类候选按 tier1 处理 | 保持 C0 行为 | 无候选 |
| 不同已知模板，或双方主值都有值但冲突 | 排除 | 排除 | 排除 |

C1 的目标只是在有明确模板的基准上去掉无模板补位，同时保留历史基准兼容；不声称解决全部 tier2 弱占位问题。C1 有方向性：“已知模板 → 无模板”排除，“无模板 → 已知模板”保留，这是兼容策略而不是矛盾，比较报告须明确写出。C2 用于量化更严格门槛的损失，尤其揭示当前 822 个 legacy 基准会失去候选的代价；不能因为“剩下的都是强匹配”就把它判为最优。

三种规则保持已有 tier 含义、次属性分、同店优先和 ID 决胜。C1 不把跨店强匹配无条件提到合格同店之前；若问题主要来自同店 tier2，报告要如实指出本轮有限收紧不能解决，另提业务决定，不能偷偷改排序。

### 7.2 SQL 与比较实现

在现有候选查询内部增加有限的 admission 选择，默认 C0；基准模板判定、主/次属性归一化、tier 计算及基础 WHERE 共用。新增准入条件在 SQL 排序与 `LIMIT 64` 之前应用。不先拿一份截断候选在 JavaScript 重算相关度、套用另一套归一化或冒充完整召回比较。

offline runner 对同一个基准、audience、商家桶调用相同查询的 C0/C1/C2。没有公开参数，也不在推荐请求中多跑两种策略。无需策略注册器、插件接口、通用表达式 DSL 或多轮补查。

当前生产入口在离线阶段显式保留 C0；比较不签发清单凭证、不写事件表、不改 `pdp-rec-v1`。PR3 只改变后续用户主动填写的值，也不升级统计策略版本。

### 7.3 决策表

| 观察 | 决策 |
| --- | --- |
| C1 没有改变任何有意义的案例，或改动只出现在用途未确认的演示数据 | 保留 C0；交付完整比较结果，不为 PR4 增加运行时差异 |
| C1 减少已复核的不相关补位，未排除复核集中已确认相关的商品，且缺口可解释、可接受 | 可提议 C1；列清受益与损失的模板/audience/案例。review 只提供技术结论，是否采用 C1 由 Owner 根据收益和损失单独批准 |
| C1 移除了应保留的 legacy 候选，原因是模板资料尚未补齐 | 保留 C0，并把这些案例作为未来人工治理输入；不自动迁移模板来制造通过 |
| 只有 C2 看起来更纯，但大量基准无候选，或有主字段模板证据不足 | 不采用 C2；保留诊断结果和代价说明 |
| local 样本缺某模板、guest 或导入来源 | 明确“未评估”；可用小型合成 fixture 验证代码契约，不能补进真实目录统计分母 |

单元 C（真实准入切换）须 Owner 单独批准后才实施；部署继续走现有发布流程。

不预设“覆盖下降 10% 就接受”“准确率提高 5% 就上线”这样的无依据阈值。报告展示实际计数、配对变化和可判断案例；相同逻辑分支的已确认相关商品被误排除应先解决。缺少证据可以完成审计和 PR3，但保持 C0。

### 7.4 若决定切换真实准入

只有运行时决定采用 C1 时才实施以下接线；没有规则变化则不做：

1. 推荐服务只采用选定的一套准入，仍共用补全、unavailable 过滤、六件截取及现有前端卡片。比较用的三套选择不成为公网运行配置。
2. 策略版本由 `pdp-rec-v1` 升为 `pdp-rec-v2`，新增清单只签 v2；token 格式 `v=1`、HMAC key 和两小时 TTL 不变。
3. 验签允许 v1 和 v2，在原 TTL 内继续接收上线前签发的 v1，并按其原 sv 存储。不能只替换当前 `z.literal('pdp-rec-v1')` 为 v2，导致有效旧清单上报被丢弃。
4. 沿用报表的 strategyVersion 分组，不回写旧事件，不把两个版本合并；不改点击、曝光、归因窗口或订单接口。
5. 回退只切回 C0 和 v1 签发，暂保留 v1/v2 验证兼容，使已签 v2 能在原 TTL 内完成上报。无需轮换密钥、定时移除代码或新增回退开关。

推荐策略版本、模板版本和建议配置版本是三个不同概念。v2 的版本变更可以借助现有 PR5 数据识别，但当前生产是否已启用统计尚未核验，不能把“PR5 已合入”当成“已有可用流量基线”。没有足够真实事件时只报告离线结果。

## 8. 交付文件与实施顺序

建议分为三个可 review 的工作单元，不强求每个单元凑固定提交数：

| 单元 | 建议落点 | 退出条件 |
| --- | --- | --- |
| A：本地审计补充与离线比较 | 扩展 recommendationAudit / auditRecommendationData，候选查询内部有限参数；新报告 `docs/reviews/recommendation-local-quality.md` | 固定范围、全量汇总、C0/C1/C2 差异、来源证据分组、必要人工案例与局限；默认推荐接口不变 |
| B：PR3 属性建议 | TemplateAttributeFields + 小型静态配置，共享入口接线；如缺失则补保存前形态锁定说明 | 自由填写、主动采用、原值保持、人工/AI/编辑入口一致；报告列出实际纳入及暂缺的词条。允许多数模板只有填写说明：没有经核实的词条就不填，不按词条数量验收 |
| C：PR4 运行时策略（有证据才做） | 推荐准入选择、token 版本兼容、既有推荐/事件测试 | 最终规则与依据已 review；无多余开关、无公共 DTO 变化、旧有效凭证仍可用 |

A 的报告是 B 词条与 C 策略的依据。三个单元顺序推进：B 在 A 合入后开工，不把尚未核实的词条包装成标准；C 在 A/B 交付后、经 Owner 单独批准才开工。C0/C1 比较在 A 完成；如果结论为不切换，单元 C 不创建空功能 PR。

本轮方案不新建审计报告占位文件，避免把计划和事实混放。正式报告产生后链接本文，并保留原生产报告的独立结论。

## 9. 适量验证

本轮不新增 E2E 场景、真实模型调用、mutation 测试要求、压力测试框架或全模板全入口矩阵。新增风险优先在既有测试中覆盖：

| 变更 | 最低有效证据 |
| --- | --- |
| 本地审计与比较 | 在 recommendationAudit.test.ts 用一份小 fixture 覆盖三规则差异、member/guest 分母、全量与样本截断的区别；校验 JSON/Markdown 关键口径，不为每种展示格式再造数据 |
| SQL 准入 | 在 recommendations.test.ts 验证默认 C0 不变、已知基准排 legacy、未知基准 C1 兼容、有主字段缺值与无主字段不同；复用同店/平台 null 桶和既有候选截取回归 |
| 名称建议控件 | 扩展 TemplateAttributeFields.test.tsx：适用字段才出现、主动采用写值、保留/自定义不被阻止、disabled 不改值；用代表字段覆盖共享行为，不把同一套断言复制五次 |
| AI 与保存接线 | 在已有 ProductDraftAssistant 测试补一条“AI 原值未采用建议时保持，人工改值经确认原样提交”；现有创建/编辑保存形状未变时复用既有测试，不重跑七模板完整创建 |
| 运行时切换与统计（仅 C） | 现有事件测试覆盖 v2 签发、TTL 内 v1 接收、过期拒绝；报表版本隔离和推荐准入各一处接线断言，复用既有验签/归因矩阵 |

数据库集成测试只连接单独的可丢弃测试库。目录数据源及审计快照不得交给含全表 TRUNCATE 的测试 setup，不把生产或本机应用写账号带入测试命令。

按实际改动运行受影响测试、对应端类型检查/构建和 `git diff --check`。只改文档不跑应用测试；只改前端建议不机械重跑后端全量。PR3 人工看一处桌面、一处手机及键盘操作即可，不复制店铺页的屏宽矩阵。

预计 A/B/C 不触及认证、订单或中间件，按测试政策无需新 E2E 或强制 run-e2e；若实施扩大关键路径，依实际范围执行政策。CI 走现有路径过滤，不规避合并后集成门。

## 10. Git 基线与交接

### 10.1 分支安排

| 用途 | 分支 / 基线 |
| --- | --- |
| 本方案 | `chore/recommendation-quality-local-plan`，起始 `297ee6554141a842bff6c4cae479a2ce15cf6449` |
| A：本地审计与比较 | 拟 `chore/recommendation-local-audit`，从开工时最新 origin/develop 创建 |
| B：PR3 | 拟 `feat/product-attribute-guidance`，A 合入后从最新 origin/develop 创建；不建立在方案分支上 |
| C：PR4（需要才建） | 拟 `feat/recommendation-admission-v2`，A/B 交付且 Owner 单独批准后从最新 origin/develop 创建 |
| 所有 PR base | `develop`；远端分支名与对应本地功能分支一致 |

主目录 `/root/projects/MoNexus-new` 的本地 develop 仍是旧 `7dc79aa`，含用户未跟踪文件，不切换、重置或清理。当前已核验远端为 `297ee65`，后续实际开工须 fetch 并记录完整 base SHA；远端推进时核对受影响锚点即可，不重复请求常规基线确认。

以下以 A 为例；B/C 使用表中各自分支与独立 worktree 路径，保留 `--no-track`：

```bash
git -C /root/projects/MoNexus-new fetch origin
git -C /root/projects/MoNexus-new log -1 --format='%H %s' origin/develop
git -C /root/projects/MoNexus-new worktree add --no-track -b chore/recommendation-local-audit /root/projects/worktrees/monexus-recommendation-local-audit origin/develop
cd /root/projects/worktrees/monexus-recommendation-local-audit
git log -1 --format='%H %s'
git branch -vv --list chore/recommendation-local-audit
```

若方案尚未合入，在功能 worktree 只取本文，不合并方案历史：

```bash
git restore --source chore/recommendation-quality-local-plan -- docs/specs/recommendation-local-quality.plan.md
```

路径或分支已存在时检查归属并另取新名，不覆盖既有工作。起始 HEAD 应与刚 fetch 的 origin/develop 相同，不自动跟踪 origin/develop。

### 10.2 Review 与发布

实施完成交回本方案编写 agent review，附 worktree、分支、完整 base SHA、HEAD、主要改动、报告与案例依据、已执行/未执行验证、方案偏差及遗留。前端设计、后端和报告都属于此次 review 范围。

当前授权为方案设计；本轮只提交文档，不实施代码、修改商品、推送或建 PR。后续实施、推送、合并和部署依各阶段已有授权办理；review 通过本身不等于生产发布。

获准推送 A 时显式指定远端同名分支，B/C 同理：

```bash
git push --set-upstream origin chore/recommendation-local-audit:chore/recommendation-local-audit
gh pr create --base develop --head chore/recommendation-local-audit --title 'chore: audit local recommendation quality and compare admission rules' --body-file /tmp/recommendation-local-audit-pr.md
```

推送前核对 upstream 不指向 origin/develop。报告只提交必要汇总与案例，不提交连接信息、完整原始 JSON、数据库快照或本地来源附表。

## 11. 本次设计验证与后续记录

本轮已完成：对照 develop@297ee65 检查审计、候选 SQL、推荐服务、参数控件、人工/AI/导入入口及统计 token；查询本机只读元数据计数，得到 §2 的范围。尚未做全量推荐审计、离线策略比较、词条审核、人工配对标注、功能实现或生产效果评估。

本次文档仅做本地链接、结构与 diff 检查，不把实现 agent 未来要跑的测试写成已通过。A/B/C 完成后分别补充实际基线、报告结论、词条范围、采用/未采用的规则、代码提交、定向验证、CI 与限制。

### 11.1 单元 A 实施记录（2026-10-15）

- 分支 `chore/recommendation-local-audit`，`--no-track` 创建，基线 `origin/develop@297ee6554141a842bff6c4cae479a2ce15cf6449`；实现提交 `b1e00f1`。未推送、未建 PR。
- 快照：`pg_dump` → 独立库 `monexus_audit_snapshot_20261015`（导出开始于 2026-10-15T07:07:09Z），审计后删除快照库与导出文件；应用库未写入。
- 结果：范围 844 件，835 件匹配 E2E 测试命名特征、1 件匹配种子示例特征（均为高置信推断，未证明由对应脚本创建）、8 件用途未确认。C1 只改变 5 个登录基准和 1 个游客基准，全部是带 E2E 命名特征或用途未确认的商品；C2 使 822 个 legacy 基准无候选。20 条有方向配对的人工复核全部为“信息不足”。
- 决策：保留 C0，单元 C 不创建功能 PR；B 只提供填写说明，没有可核实的建议词条。详见报告。
- 验证：`recommendations.test.ts` 与 `recommendationAudit.test.ts` 共 11 个用例通过（可丢弃库），后端构建通过，`git diff --check` 通过；未运行 E2E。

### 11.2 单元 B 实施记录（2026-10-15）

- 分支 `feat/product-attribute-guidance`，`--no-track` 创建，基线 `origin/develop@68bff827eb95fff59a2489c2ea5dfb1420de3014`（已含 #257）。未推送、未建 PR。
- 填写说明：新增静态配置 `src/components/catalog/attributeGuidance.ts`（说明集 `2026-10-15.v1`），按 `templateKey@version:fieldKey` 只覆盖商品级主字段，`TemplateAttributeFields` 在对应字段下显示说明并通过 `aria-describedby` 关联。套餐同名字段、未在配置中的模板版本不显示。

  | 模板 | 字段 | 纳入 |
  | --- | --- | --- |
  | redemption_code@1、account@1、subscription@1 | serviceName | 仅填写说明 |
  | digital_file@1、fixed_content@1 | contentCategory | 仅填写说明 |
  | manual_service@1、appointment@1 | — | 不新增主字段说明 |

- 建议词条：**未纳入任何词条**。本地审计只有 1 个用途未确认的 serviceName 值和 1 个测试默认 contentCategory 值（报告 §6），没有可核实的写法。因此本轮不实现候选值控件；以后有经核实的词条时，再在同一配置中加入。
- 不改变的部分：自由输入、原值和既有保存流程不变；说明不校验、不改写、不阻断发布，不修改模板 Schema、registry DTO、AI prompt/校验器或导入同步。商家人工向导、平台人工向导、双方商品编辑与 AI 草稿助手都复用同一控件，自动获得说明。
- 形态锁定提示：编辑页已有“选定并保存后不可更改”，原样复用。创建入口缺少该提示，在商家向导确认页、平台向导与 AI 草稿助手的形态字段下补一句“保存后商品形态不可更改。”，不新增弹窗或确认步骤。
- 验证：`TemplateAttributeFields.test.tsx` 12 个用例通过，新增覆盖：说明只出现在商品主字段；套餐同名字段与其他模板版本不显示；已有值不变；自定义值按输入写出；disabled 时不可修改。`ProductDraftAssistant.test.tsx` 20 个用例通过，新增覆盖：AI 原值旁显示说明且保存时保持原值；人工改值按输入原样提交。`src/components/catalog` 与 `src/pages/merchant` 共 35 个文件 353 个用例通过；前端构建通过。浏览器检查用可丢弃库，在 1280 与 390 宽度下打开商家商品编辑页并选择“卡密与兑换码”：说明可读，键盘聚焦后可输入，无横向溢出。未新增或运行 E2E。

## 12. 修订记录

| 版本 | 说明 |
| --- | --- |
| 1.0.0 | 初始方案 |
| 1.1.0 | 采纳 review：§5.1 固定 pg_dump → 独立快照库并在结束后删除；B 统一为 A 合入后开工；报告与人工复核写明 C1 的方向性并按“来源 → 目标”记录；C 须 Owner 单独批准；B 允许多数模板只有填写说明 |
