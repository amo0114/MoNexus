# 推荐数据质量只读审计报告

| 项目 | 内容 |
| --- | --- |
| 关联方案 | [PLAN-PRODUCT-AVAILABILITY-001 §9 PR2](../specs/public-product-availability-and-recommendation-quality.plan.md) |
| 状态 | 审计脚本已就绪；**线上数据尚未运行**，第 4 节结论待填写 |
| 脚本 | `npm --prefix server run recommendation:audit -- [--format=json\|md] [--samples=N]` |
| 实现 | `server/src/modules/products/recommendationAudit.ts`（复用推荐的同一套候选 SQL 和策略表） |

## 1. 目的与边界

为 PR3（创建字段名称建议）和 PR4（弱匹配准入调整）提供事实依据。本轮只做以下几件事：

- 只读：脚本只执行 SELECT，不更新商品，不做自动清洗，不调整推荐规则。
- 只看目录元数据：商品名、分类、模板与公开属性、商家名、外部导入记录。不读库存条目内容、固定交付内容、订单或买家资料，也不调用 Xboard。
- “待确认”项只是供人工核实的线索，不代表应合并或改写。例如 Steam 与 Steam Wallet 不会被自动视为同一服务。
- 测试库或本地演示数据的统计不能当作线上结论。

## 2. 数据入口（运行前确认）

| 选项 | 要求 |
| --- | --- |
| 首选：已授权的数据库快照 | 记录快照时间、来源环境和授权人；在隔离环境恢复后运行 |
| 备选：已授权的生产只读账号 | 账号必须只有 SELECT 权限；不得使用应用写账号 |

当前尚未确定数据入口。拿到授权后，在报告第 4 节填写以下内容：入口类型、快照或查询时间、授权人（填角色，不写个人信息）。不得把连接串或凭据写进本文件、日志或提交。

## 3. 运行方式

```bash
# 在具备应用配置的环境中（脚本复用应用的 Prisma/config），DATABASE_URL 指向快照或只读账号
REDIS_ENABLED=false npm --prefix server run recommendation:audit -- --format=json --samples=50 > audit.json
REDIS_ENABLED=false npm --prefix server run recommendation:audit -- --format=md  --samples=20 > audit.md
```

- JSON 是事实来源，包含全部待确认样本。Markdown 是第 4 节可以直接粘贴的正文。
- 输出里含商品名和商家名，原始 JSON 不提交到仓库；本报告只放汇总和必要样本。
- 推荐模拟会对每件范围内商品执行 2 次候选查询。商品较多时，尽量在快照上运行，避免占用生产库。

### 指标口径

| 章节 | 口径 |
| --- | --- |
| 范围 | `status=active`、未归档、经营者有效（平台自营或商家 active）；包含 public 和 members_only；另行标注是否有启用套餐 |
| 完整度 | 按分类 × 模板（`key@version`，无策略即 legacy/unknown）分组；主匹配字段用推荐 SQL 的同一归一化规则判断已填/缺失；manual_service、appointment 没有主键，记为“—” |
| 名称分布 | serviceName、contentCategory 分别统计；按规则归一化值分组并列出原始写法。疑似同义使用更宽松的键（NFKC、大小写、空白、标点）和包含关系，仅作线索 |
| 旧模板占比 | templateKey/version 为空或不在策略表中的商品占比，按分类拆分 |
| 推荐位 | 每件商品作为基准，以登录用户视角调用与接口相同的候选 SQL，统计前 6 个位置，**在可售过滤之前**（可售过滤只会进一步减少）；“同店弱匹配占位”指前 6 中有同店 tier<3、而跨店 tier3 落在第 6 位之后 |
| 来源 | 外部导入以 `ExternalCatalogLink` 为准；另列“有 Faka 套餐但无导入记录”；导入名称中的周期/套餐/版本词只做标记。AI 创建来源**无法区分**：`AiGeneration` 只记录调用，不记录内容是否被采用 |

## 4. 线上审计结果（待真实数据运行后填写）

- 数据入口 / 时间 / 授权：待填写
- 范围商品数 / 有启用套餐：待填写

### 4.1 分类 × 模板完整度

待填写（粘贴 `--format=md` 第 2 节）。

### 4.2 旧模板占比

待填写。

### 4.3 serviceName / contentCategory 名称分布与疑似同义

待填写。逐条列出待确认项，并注明人工核实结论（确认同义 / 不同实体 / 待业务判断）。

### 4.4 推荐位占用、推荐不足与同店弱匹配占位

待填写。

### 4.5 来源

待填写。AI 创建来源固定为“无法区分”（见第 3 节口径）。

## 5. 结论与后续输入（待填写）

只写由第 4 节数据支持的事实。例如：哪些分类或模板的主键缺失集中，哪些写法差异值得在 PR3 提供名称建议，弱匹配占位的规模是否足以支持 PR4 的准入调整。证据不足时直接写“暂不调整”。

## 6. 脚本验证记录

- `recommendationAudit.test.ts` 使用固定样例：同店强/弱匹配加跨店强匹配、大小写和首尾空格写法、`Net-flix/netflix` 宽松同义、`steam ⊂ steam wallet` 包含关系、数字类型主值缺失、已归档排除、一条 Faka 导入记录及名称周期词。验证了完整度、名称分组、旧模板占比、同店弱匹配占位样本、来源统计和 Markdown 渲染。
- 推荐相关的 `recommendations.test.ts` 仍全部通过（候选 SQL 只额外返回分数，排序与准入不变）。
- 线上运行：**未执行**（数据入口未授权）。
