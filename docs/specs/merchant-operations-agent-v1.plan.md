# 商家经营 Agent V1：实施与验收计划

版本0.2.0，2026-10-07。依据：[SPEC-MERCHANT-AGENT-001](./merchant-operations-agent-v1.md)。状态：方案待评审，无Agent实现、真实模型评测或部署完成声明。

## 1. 分支与 PR 顺序

1. `feat/merchant-workbench` 保持Node20、2207350的工作台V1范围，单独PR到develop，打run-e2e。Agent方案不提交到该分支，不在那里合入AI。
2. 独立Node22 chore PR合入develop，承担运行时/依赖升级、Docker/CI与现有功能回归。
3. 商品AI助手feat PR在Node22基线上合入develop，承担Provider、AI配置/迁移、内容Copilot及与工作台的编辑器接缝回归。
4. 上述三项完成后，从合并后的develop创建 `feat/merchant-operations-agent`，记录真实起点SHA，Agent只做自身增量。

当前方案独立暂存于 `docs/merchant-operations-agent`，工作区 `/root/projects/worktrees/monexus-merchant-agent-plan`，从本地develop的ffc7546建立，仅含这两份文档。可单独评审，依赖合入后将文档迁入Agent分支；不把文档分支作为实现分支来绕过依赖顺序。

- 2207350仅是需求/历史验收基线，不是Agent未来实现起点。旧Node20验证不重写；各后续PR对各自新基线负责。
- 不更改主工作区、工作台实现或AI工作区的未提交认证UI改动。
- 本期任务编号A0–A3，与旧工作台PR1–PR3分开。方案阶段不推送、开PR、合并、升级或操作数据库；实施和外部操作按后续授权执行。

## 2. A0：已合入依赖的基线核验与 Agent 规范调整

### 输入与产物

输入：依赖已经合入的develop及工作台/Node22/商品AI三个PR与SHA。c0964c2仅为调研观察，不直接合入Agent或工作台；上游尚未合入时停留在文档评审，不复制Provider或新建平行基础设施。

产物：新Agent分支、依赖清单、基线核验记录、Foundation与配置/元数据修改设计。A0不再执行工作台与AI分支间的运行时整合。

### 任务

1. 核对三个依赖PR已合入，记录起点和迁移顺序；从该develop新建Agent分支。后续通过正常merge/rebase同步develop，不导入未合入的功能分支。
2. 检查已经统一的Node22/npm10、engines、lockfile、Docker/CI runtime；发现依赖基线问题回到对应PR/修复，不在Agent里重新做一次Node升级。
3. 核对ProductEditPage保留workbench定位与AI差异采纳、dirty/CAS保护，publicationReadiness共享评估仍在；按实际接缝运行针对性基线测试。
4. 修订Foundation：task容器、应用层工具、独立feature/target/flag/quota、Agent计数/HMAC语义；原商品Copilot仍单次调用。
5. 新增merchantAgentEnabled=false和merchantAgentReasoningMode=default，Agent只配merchant额度0。后台显式说明工作台环境开关重启生效、AI运行时开关保存生效。
6. QUOTA_KEYS改成显式supportedRoles/部分角色键映射；不支持角色在配置读取前403拒绝，原Copilot两角色行为不变。
7. Provider/task请求显式表达none/default，旧runAiGeneration签名可保留兼容映射，三种adapter按有效模式发送/省略参数。元数据反映实际模式；不能只改TypeScript类型却漏改Chat硬编码none。
8. 注册Agent feature/target CHECK；新增nullable计数列及Agent限定的accepted为空、suggested 0..6、issueCounts固定键非负约束。按Spec §9.1实现初始run输入HMAC，保持旧hash用途域与行为。

### 验证与出口

- 核验已有依赖版本而非重做前三个PR；修改task/配置/Provider/配额时必须跑其原有回归。
- Agent新增迁移fresh replay与从依赖基线升级分别验证；只使用明确授权的可丢弃库，不能将DATABASE_URL默认值当授权。
- A0不是Agent完成。后续PR涉及权限/限流等横切路径仍按testing-policy打run-e2e，与运行时已单独升级不冲突。

## 3. A1：受控任务运行容器、只读工具与证据协议

### 文件责任范围（拟新增/修改）

| 位置 | 责任 |
| --- | --- |
| `server/src/lib/ai/task.ts`（新） | 统一claim/finalize、配置快照、总deadline、调用预算、cancel、usage聚合 |
| `server/src/lib/ai/generation.ts` | 保持原公开契约，复用task单调用路径；注册Agent feature/target与额度映射 |
| `server/src/lib/ai/{provider,protocol,openaiProvider,compatibleProvider}.ts` | generateStructured仍是结构化入口；扩展none/default请求与三协议有效模式映射，保持旧Copilot行为；不新增原生tool calling或SDK |
| `server/src/modules/merchant/agent/{routes,schema,service,runner}.ts` | 商家turn接口、任务循环、下一步schema与结果 |
| `server/src/modules/merchant/agent/tools/{registry,workbench,products,help}.ts` | 封闭工具、参数限制、归属查询、说明文档 |
| `server/src/modules/merchant/agent/{projection,evidence,validator,prompt,constants}.ts` | 白名单投影、ref登记、输出引用校验、版本与硬预算 |
| `server/src/modules/catalog/contentCopilot/service.ts` | 抽出已鉴权上下文准备；既有生成入口继续复用相同逻辑 |
| `server/src/modules/merchant/routes.ts` | 原权限链后挂载Agent路由 |
| `server/prisma/`、AI配置相关模块 | A0注册项对应实现与迁移 |

文件名可按实际模块约定调整，但责任与不依赖业务写服务的边界不变。

### 实施顺序

1. 先做task公共容器，使用“原内容Copilot调用行为完全不变”的回归约束提取；权限检查、Provider错误脱敏、metadata失败收尾不丢失。
2. 编写工具注册表：固定名称/Schema/描述/适用条件/返回状态，不接收模型提供的模块名或函数路径。
3. 复用workbench service；新增find_products、inspect_product必要查询，不把整个编辑DTO作为工具返回。既有getItem的draft规则对active商品返回ineligible，不能用于通用发布诊断。
4. 建立请求内ref登记与两份投影。测试中同时截获Provider输入和前端返回，验证V级数据只在viewEvidence、S级均不外发。
5. 实现Decision循环：validated decision → gated tool → safe observation → next decision。顺序只由模型决定与安全门约束；不在controller预先拉全店数据。
6. 实现终结型prepare_content：专用prompt/schema与原validator；沿相同task.generate计费、累计usage、截止时间；不调用另一个runAiGeneration。
7. 所有出口统一outcome/stopReason，非法tool/ref、重复工具、超限、关闭、权限撤销均有稳定行为。
8. 中途配置改变不混用模型；关闭开关/权限撤销需禁止继续执行和交付，run计入已消耗额度。
9. HTTP连接取消按Spec §6.4：res.close且未writableFinished中止；req.aborted补充；不得无条件在req.close中止。注册/释放监听器、已断开不写响应、run失败收尾统一实现。
10. 依Spec §9.1构造初始白名单对象与独立HMAC用途域；一run一个64位hex摘要，不在工具返回后覆盖。文案计数、空值和失败后保留规则用集成断言固定。

### 必须先有的自动化测试

- 模型替身连续返回不同Decision，断言确实按观察继续调用，且不允许业务写服务。
- 参数strict、未知工具/引用、非本轮ref、跨商家、执行中转移商品、注销/暂停、关开关。
- 三次工具上限、四次规划/一次生成上限、超时/取消、重复无进展、context上限；所有调用共享默认40秒预算，不按5×15秒累计。
- 真实HTTP客户端在完整POST已接收后断开：阻塞Provider收到abort、后续调用为0、run不遗留pending；正常请求体close/正常响应finish不误取消。
- 三adapter none/default映射、原Copilot配置不变、Agent unsupported admin在读取额度键前拒绝。
- run hash canonical键序稳定、64位hex、消息/版本变化改变hash、requestId变化不改变hash、旧用途域不变；Agent行issueCounts/suggestedFieldCount/acceptedFieldCount满足Spec语义。
- 两条Agent请求并发409、同用户与Copilot额度相互独立、上海日界、metadata无内容、未知usage不算0。
- 超时工具晚返回不再调用模型、不返回已撤销权限对象；Provider拒答/格式错误不自动重试。
- unknown、truncated、无候选、存在多个同名商品不伪装成唯一匹配或已完整检查。

出口：仅A1通过不算完整Agent交付；还缺商家实际旅程和模型质量。

## 4. A2：对话与文案审阅闭环

### 文件责任范围

| 位置 | 责任 |
| --- | --- |
| `src/api/merchant/agent.ts`（新） | availability/turn契约、55秒请求超时和AbortSignal |
| `src/stores/merchantAgent.ts`（新） | 仅内存历史、requestId/sessionEpoch、提案TTL与跨页交接 |
| `src/components/merchant/agent/`（新） | 对话、证据卡、实际工具步骤、澄清选择、提案预览 |
| `src/pages/merchant/WorkbenchPage.tsx` | 原列表与经营助手入口；互不阻塞 |
| `src/components/merchant/workbench/{WorkbenchSummary,WorkbenchCard}.tsx` | 轻入口和资源选择，不自动发收费请求 |
| `src/pages/merchant/ProductEditPage.tsx` | 提案接收、版本/dirty校验、接入已有差异视图 |
| 内容Copilot已有差异组件 | 必要时抽出可复用展示/选中字段逻辑，不新造第二套采纳流程 |

### 实施顺序

1. 单次对话turn、取消、404/403/429/409/5xx、session变化与晚响应；availability与规则工作台availability分别管理。
2. 三个任务提示样例只填入问题，不伪装为已执行。点击发送才开始run。
3. 对话中动态资源歧义选择：最多10个候选，清楚展示商品名/状态；selectedResource重新鉴权，不依赖文本“第二个”猜测。
4. 证据卡用服务器事实渲染；模型建议用纯文本；操作链接来自actionRef映射；无任意href/HTML。
5. 完成提案内存交接；编辑器新鲜读取后核对版本、权限、TTL、dirty；默认不勾选，填入后仍不保存。
6. 商家保存成功后，旧待办与Agent相关资源分别重新检查；不标记AI“已发布”。无须为了同步状态再发模型调用。
7. 手机390px与桌面1280px、键盘操作、关闭焦点恢复。现有已知商品列表弹窗焦点问题单独保留记录；新对话/提案不得照搬该缺陷。

### 验证

- 组件测试覆盖：纯提问不生成文案；仅生成意图才可prepare_content；无效提案/版本冲突/dirty禁止应用；勾选字段精确填入；不会修改价格、库存、规格配置。
- 浏览器验证真实路由与内存交接，不在history state/URL里留下文案。
- 新跨端旅程至多一条E2E：合成商品→对话工具调查→文案提案→原编辑器人工选择保存→新鲜检查。CI只用测试Provider，真实后端/数据库；测试替身不能通过生产env开启。
- 为新E2E启用Agent配置应局限到测试fixture，并清理/恢复；是否需修改CI配置在实施时明确列出，不能为了测试永久开启默认开关。当前文档任务不修改CI。

出口：三条旅程在真实前后端+受控模型替身上完成。仍不能据此宣称真实模型可靠。

## 5. A3：真实模型评测与整体回归

### L1/L2/L2.5

- runner/projection/validator单元测试；工具/配额/权限/迁移真实PG集成。
- 录制回放只存人工审阅的公开合成输出，使用明确版本；客户文本不进fixture。
- Agent分支按实际改动重跑工作台原AC01–AC14相关回归，尤其轮询不触发readiness、单项404、旧响应、精确规格导航和敏感哨兵。
- 原内容Copilot单调用次数、额度、超时与字段验证不变；不因task提取让旧调用也循环。

### L3产物

新增 `server/src/scripts/evalMerchantAgent.ts` 与命令 `ai:eval:merchant-agent`（拟），严格实现Spec的24例分组、工具轨迹、逐条rubric和退出码。测试工具可由合成领域fixture支撑；这是模型能力评估，不替代真实API集成。

实际模型/协议由管理员选择；Agent主验收有效推理模式为default，并记录服务商是否提供可核实的实际推理配置。none仅作对照，若选择none启用则另跑其完整验收；不能把default等同于保证开启推理。先验证目标协议能正常产出Decision，不能沿用商品文案L3报告充当规划能力证据。真实调用需明确配置和费用范围，不读取未知生产凭据。连接测试成功不算L3通过。

记录配置版本、协议/输出模式/有效推理模式、模型、prompt/validator版本、SHA、日期、每任务tool path、失败原因、p50/p95、known/unknown usage。失败不得隐藏；安全违规任一例即非零退出。完整成功任务的比例与澄清/拒绝分别统计。

典型任务按两轮测量：调查/诊断→用户选择→文案准备。分别对调查run、文案run统计p95，均不得超过有效总timeout的80%（默认40秒对应32秒）。两轮总耗时另列；不能将交互等待算入模型run，也不能把两轮的工具拼成一次虚假的40秒成功轨迹。任何一类超门槛都停止启用，不自行扩大超时或破坏timeoutMs+5秒的409窗口。

### 本地命令安排

实施后以实际文件名为准，先运行时检查，再按顺序跑：

```bash
npm run check:runtime
npm --prefix server run build
npm run build
# 后端在server目录，以明确授权的可丢弃TEST_DATABASE_URL运行：
npx vitest run src/modules/merchant/agent src/modules/merchant/workbench --maxWorkers=1
# 前端在仓库根目录运行：
npx vitest run src/components/merchant/agent src/stores/merchantAgent.test.ts --maxWorkers=1
# 真实模型eval是独立、显式步骤，不放进普通CI：
npm --prefix server run ai:eval:merchant-agent
```

不要直接复制命令而在错误目录/数据库执行；运行前核对库名。从已合入Node22的develop起步，使用同一Node版本执行前后端。构建/DB测试/全量测试顺序执行，避免此前宿主内存压力造成假超时。独立失败要保留首次失败记录与重跑依据。

完整E2E涉及本地monexus_test仍需单独明确范围；优先用已授权环境或PR CI的独立库。CI按testing-policy加run-e2e，不能以“Agent只读”豁免本次权限与限流横切路径变更；Node升级回归由先前独立chore PR承担。

## 6. 验收记录模板

新增 `docs/specs/merchant-operations-agent-v1-verification.md`（实施时创建，不预填通过）：

1. 基线/整合依赖SHA、最终commit、运行时、数据库名与保护措施。
2. MA01–MA12逐项测试文件、具体断言、命令、结果；注明mock/真实DB/真实浏览器/真实Provider。
3. 三条核心任务逐步结果与实际tool sequence。
4. 配额/超时/取消、执行中关闭/撤权、版本冲突与未保存表单证明。
5. L3逐任务与汇总，未通过项不能用“待后续优化”算验收通过。
6. 原待办、内容Copilot、编辑保存、库存、订单回归范围与遗漏。
7. 已知限制：没有长期记忆、默认不全店扫描、同步run硬截止、提案刷新丢失、无经营预测。
8. CI、部署、试点分别记录，尚未执行明确标为未执行。

## 7. 完成标准与后续

只有A0–A3及MA01–MA12所需证据完成，才可称“商家经营Agent V1实现并通过本地验收”。生产验收仍需CI、部署条件、明确试点商家和周期；这些不从文档任务推导授权。

首期试点关注“找对任务、到达正确对象、生成可用提案、人工保存后真实解除问题”，不要用聊天轮数、Token量或卡片点击率代替价值。若明显增加耗时，先改善工具选择和上下文大小，不默认增加模型轮数或更多框架。


## 8. 修订记录

- 0.2.0：工作台→Node22→商品AI→新Agent分支的独立PR顺序；A0改为依赖基线核验；列入推理类型/adapter、supportedRoles额度映射、run HMAC/计数字段、两轮延迟门槛和真实HTTP取消测试。文档移出工作台分支，未修改实现。
