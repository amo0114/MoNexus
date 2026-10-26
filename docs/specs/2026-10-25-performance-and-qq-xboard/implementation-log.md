# 实施记录

日期：2026-10-25。当前交付推进至第十一批 B4 发布产物与文件核对准备；各批事实和验证按下文记录。网站和机器人新开关默认关闭；本地已接通购买引用与有覆盖范围的付费次数，真实部署/QQ 验收仍待完成，整体项目尚未部署。

## Git 基线

- 主仓库：`/root/projects/MoNexus-new`，原分支 `fix/merchandising-hot-badge-projection`，HEAD `56791c3b34feea7748c0a7fc21e020cc58bf0367`。
- 开始时有 114 个 tracked dirty 路径、125 个 untracked 文件，暂存区为空；不清理、不 stash、不复制其余业务改动。
- 已 fetch 并选择 `origin/develop@9ac9dbd76eb198ba533743269c211eb4eb478b66`；它包含原 HEAD 后的 47 个提交。原工作区的大部分重构已合入，不能整体带入新分支。
- 实施分支：`feat/performance-qq-xboard-20261025`。
- 实施 worktree：`/root/.codex/worktrees/19af/MoNexus-new`。仅从原目录复制三份已批准的计划，后续改动都在此 worktree。
- Node `22.23.1`、npm `10.9.8`；两个 npm 包分别使用锁文件安装独立依赖，没有复制环境文件或密钥。
- 插件仓库 `/root/projects/Mo-lab`：原为干净 `main@167e7f7fe8cad51c0b1580e4869a66d9284a5950`，本批未改动。B0 实施前另建插件 worktree。

结束核对原工作区指纹与开始时完全相同：

```text
git diff --binary SHA256:
d9d6caa2f4d1f5bf18ba82054c287dcf2d5bc5cca221e3e537588e36b68d7d5c
git status --porcelain=v1 -uall SHA256:
58cce6c6cd9a557f5d99900bb2689f3ac98d73e5d8368d6a8614833892709446
```

## 最新 develop 已有的能力

以下不是本批新增，避免重复实现或错误归因：

- 后台、商家、创建/编辑等多数路由已经 React.lazy；入口已有 chunk 失败恢复。
- 候选数据已从逐商品详情改为“两路候选 ID + 一次 `/products/summaries` 批读”，不再有最多 12 次详情 HTTP。
- 候选请求已有 signal、卸载取消和 2500ms 截止。
- cursor 过期恢复、失败游标自动请求暂停、共享商品类型及可见性改动已经合入。

## 第一批实际改动

1. 首次加载、分类切换、搜索清空立即调度商品请求；仅搜索输入使用 250ms 防抖。桌面与灵动岛 Enter 共享提交动作，IME 确认不触发提交。
2. Enter 只结束待执行的防抖，同词请求已经在途或已完成时不取消重发。立即请求不使用定时等待；HTTP 启动前的微任务检查让 StrictMode 丢弃首次重放，避免重复有机商品 HTTP。
3. 商品客户端支持 AbortSignal；查询变更、身份变更及卸载取消旧列表和分页请求，同时保留 epoch 保护。取消不显示加载失败。
4. 普通商品成功即可提交。候选已就绪时沿用原模板；迟到时本 query 保持普通流，不替换卡片。原 `SPEC-CMI-UX-001` 已修订为 0.3.0，说明曝光时序改变。
5. 列表缓存及请求范围增加 user/session/authEpoch 隔离；保存时核对已完成的 query，避免未提交搜索或其他会话复用。
6. 初始两行卡片直接可见，图片 eager；仅首张图片 high priority，其余图片保留 lazy。去掉商城整体首次淡入等待。没有新增虚假的 srcSet，也未实现缩略图变体。
7. 配置注册表九键改为一次批读；保留逐键默认值、存储零值及事务客户端支持，分类 registry 仍独立读取。

## 已执行验证

没有运行前端或后端全量测试，也没有执行浏览器全量 E2E。

- 前端受影响的七个文件共 37 条用例通过：`StorePage.scheduling`（8）、`StorePage`、`StorePage.cmi`、`StorePage.cursor-expired`、`StorePage.request-loop`、`StoreSearchPanel`、`StoreProductCard`。最后一次请求调度调整后重跑五个页面文件，共 27 条通过；未改动的两个组件文件此前 10 条已通过。
- 新回归覆盖：无定时推进的首次请求、registry 到达不重复请求、输入 249/250ms 边界、Enter/clear、IME、分类提交当前搜索、取消与迟到响应、同词在途 Enter、StrictMode、同会话恢复及跨会话隔离、候选永久 pending 与迟到不替换。
- 后端仅 `src/__tests__/config-registry.test.ts`：8 条通过，含缺行/部分/完整配置、零值、一次查询、事务内读取、空键集合；原 registry HTTP 行为回归通过。
- 后端使用本批专用、tmpfs 数据盘的 PostgreSQL 16 容器与全新 `monexus_perf_test` 数据库，初始化既有 107 个迁移后运行。没有连接开发或生产数据库，没有新增 schema/migration。
- 前端 `npm run build -- --manifest` 与后端 `npm run build` 通过；后端包含现有 build runtime import 检查。`git diff --check` 通过。
- 测试结束后已停止并自动删除临时 PostgreSQL 容器，tmpfs 测试数据随之销毁。

## 当前构建体积（不是线上性能验收）

统计本批修改后的 `dist/.vite/manifest.json` 入口、同步 imports、CSS，并核对 HTML modulepreload；gzip level 9。未计入纯异步路由、外部字体、图片和 HTML。

| 文件 | 原始字节 | gzip 字节 |
| --- | ---: | ---: |
| `assets/index-CETUN44R.js` | 500,642 | 157,566 |
| `assets/index-Bns7Q4Yn.css` | 166,122 | 29,228 |
| 合计 | 666,764 | 186,794（182.42 KiB） |

入口 JS 为 153.87 KiB、CSS 为 28.54 KiB，落在方案拟定的 300/45 KiB 入口目标内。但多数拆包来自最新 develop，不能把旧工作区约 536 KiB 到本结果的差值归功于本批。

另执行原 `node scripts/check-frontend-bundle-budget.mjs`：全体 87 个产物为 780.69 KiB gzip，超过原 150 KiB 总资产代理预算，检查退出 1。没有提高阈值或把该失败改报为通过；总资产还包括后台和富文本编辑器等异步文件，与入口闭包是不同口径。完整可重复的预算脚本/CI 与浏览器数据仍属后续 P0。

## 第一批结束时尚未完成

- P0 的浏览器 HAR/trace、真实可见标记及 RUM 出口；线上 LCP/INP/CLS/API P95 未测，不能声称已达标。
- P1 的页面级 Suspense 布局检查、字体自托管，以及更精确的视口媒体调度；主方案多数路由拆包已在基线存在。
- P2 新候选聚合接口、候选短缓存与在途合并。首批没有修改现有两路候选 + summaries 的接口协议。
- P3 真实图片变体、历史媒体处理与持续动画停帧。
- B0–B3 的 QQ / Xboard 查询、关联回填、权益、意图、幂等执行、对账与付费稳定 ID 分支均未实施；没有发放、消费或重置用户流量。
- 后续先做候选聚合，再按 B0 核实插件迁移机制及实际 Xboard 核心版本。实际 QQ 适配器源码位置和部署版本仍需落实；本地插件代码不能替代线上版本证据。

本批未提交、推送、合并或部署；可直接在上述 worktree 审阅差异。后续按独立阶段提交，仍优先定向测试。

## 第二批：P2 候选聚合与 B0 协议基础

继续使用同一 worktree 和 HEAD，没有带入原工作区业务改动。

### P2 已实现

1. 新增 `GET /api/storefront/candidates`。服务端固定 placement、每来源最多 6 条，客户端仅可传严格分类码；受众由既有鉴权决定，未知/不可访问分类返回同样的空结果。
2. 同一次数据库时间用于两路候选筛选；两路选择器并发执行，单路失败保留另一路；去重 ID 仅调用一次公开卡片批量读取，沿用实时可见性、商家状态及字段白名单。没有调用完整商品详情。
3. 分类过滤在取精选限额前执行。独立核验进一步发现原精选会让无准入/过期准入条目占满限额；已用共用游客可见 SQL 在数据库中精确选出 feature ID 后再取卡片，仍保留返回前复核，避免漏掉后面的有效精选。
4. 前端由基线的“两路候选 + 一次 summaries”改为一次聚合 HTTP，旧接口保留。相同分类及完整浏览器身份的在途请求合并；一个消费者取消不影响其他消费者，末位取消中止 transport，并支持 StrictMode 同微任务重订阅。
5. 返回时复核 user/session/authEpoch；不同会话和分类不共享结果。候选失败或迟到继续沿用第一批普通商品先展示的策略，未增加整页等待。更新页面及 auth E2E 的路由 mock，未运行全量 E2E。
6. **缓存取舍**：本批仅合并在途请求，未增加浏览器 30 秒完整卡片缓存或服务端完整响应缓存；保留已有推广 ID 缓存和实时复核。原因是目前没有撤销通知协议，完整响应缓存会延长精选撤销、商家停用和可见性变更的旧数据窗口。聚合响应为 `private, no-store`。后续如需完整缓存，先定义失效契约再实施。
7. OpenAPI 新增聚合 schema 和路径，模块说明记录一致性边界；未改变旧候选接口契约。

### B0 已实现与事实边界

- 用户补充：QQ 为 **AstrBot + NapCat**，Xboard 为“最新版”。已将栈、真实 sender 映射、私聊及异步客户端要求写入方案；未找到现用 AstrBot 业务插件源码，也未拿到可复现部署 digest/commit。
- 新增 `signedProtocolV2.ts`：原始 body hash、链路 audience、POST/完整路径、毫秒时间窗、随机 nonce、常量时间签名校验及单次 JSON 序列化。
- 两组独立 Python 计算的固定向量供 TypeScript/PHP/Python 互验，覆盖中文 UTF-8。该 helper 是纯密码学/时间验证，**尚无 nonce 持久化、业务幂等或路由挂载**，不能单独用于执行授权。
- 插件仓库仅只读核验：已有订单到远端 trade_no 的证据链及订阅快照可复用，但公开状态接口仍按邮箱；插件版本常量不一致、migration 加载及真实核心事务语义仍待隔离验证。未修改插件仓库。
- 完整约定及剩余接入条件见 [签名 v2 与适配契约](./protocol-v2.md)。本批没有查询生产账号、创建用户关联、发放免费机会或执行流量重置。

### 第二批定向验证

- 前端 6 个文件共 **33 条通过**：候选 API 6 条与五个商城页面文件 27 条。最后移除 Promise 占位写法后仅重跑受影响的 API 文件，6 条通过，并重新执行 `tsc -b` 通过。
- 后端最终定向 4 个文件 **29 条通过**：新聚合 8 条、既有候选可见性/精选权益 7 条、签名 v2 14 条。覆盖跨分类名额、两类无效准入占位、游客/成员、热 ID 缓存后停用、来源故障、字段白名单、撤销/版本变化、限额及参数/身份拒绝。
- 聚合测试最初因 fixture 错误使用 instant inventory + unlimited 触发既有数据库 CHECK；修正为 limited 后通过，没有放宽生产约束。
- 前端生产构建通过；之后仅改 API Promise 构造并以最终 `tsc -b` 和 6 条 API 用例复核。后端最终 `npm run build`（含 runtime import）、架构/OpenAPI 检查及 `git diff --check` 通过。
- 使用独立 tmpfs PostgreSQL 16 容器 `monexus-p2-20261025-19af`，仅绑定 localhost，初始化既有 107 个迁移；无新增 migration，未连接开发/生产数据库。测试后停止并自动移除容器。
- 没有运行任何全量测试、全量 E2E 或线上性能验收；没有重跑已知失败的总资产预算，也没有调整阈值。

### 当前剩余阶段

P2 的聚合与在途合并已落地，完整卡片缓存按上述原因暂缓。P0 浏览器指标/HAR、P1 字体与页面布局核验、P3 媒体变体仍未完成。B0 仅完成协议基础；能力探测、稳定身份查询、插件及核心隔离契约仍未完成，B1–B3 尚未交付。下一阶段优先完成插件能力/查询契约及 AstrBot 适配，再推进账号回填、赠送与幂等执行。

结束时再次核对：原工作区 diff/status 两个 SHA256 仍与第一批记录完全相同；Mo-lab 工作树仍干净。临时 PostgreSQL 容器已成功停止并自动移除。

本批仍未提交、推送、合并或部署；赠送业务规则尚未生效。

## 第三批：B0 插件只读能力与 MoNexus 客户端

### 基线和隔离环境

- MoNexus 继续使用既有实施分支和 worktree，保留前两批未提交改动；未复制原工作区其余业务改动。
- 插件另建 `/root/.codex/worktrees/19af/Mo-lab`，分支 `feat/qq-xboard-v2-read-20261025`，基线 `main@167e7f7fe8cad51c0b1580e4869a66d9284a5950`。所有插件修改在此，原 `/root/projects/Mo-lab` 保持干净。
- 拉取当前 `ghcr.io/cedar2025/xboard:new` 并固定 digest `sha256:2633d6085768c57b5234b165a57569502728a795888602a7c233ccd3d4eb47b8`；image label revision `935522d28bbeb666824facd8bdd674db8ab37df1`，PHP 8.2.35 / Laravel 12.54.1。核对镜像中的真实 Order/User/PluginManager 源码，不使用标签“最新”代替固定测试基线；仍未读取线上 digest。

### 已实现

1. FakaBridge 统一 config/class 版本为 **1.6.0**；新增默认 false 的 `v2_read_enabled`，旧配置缺键同样关闭。
2. 新增 POST `v2/capabilities`、`v2/user-resolve`、`v2/user-subscription`，严格字段/版本/签名头/路径/body 限额。旧 v1 路由和履约流程不变；未添加任何免费 reset 路由。
3. PHP 复用跨语言签名算法与固定向量，验证实际原始 body bytes；共享数据库 nonce 表用唯一主键原子占用，保留 601 秒并作有界过期清理。缺迁移/存储异常拒绝请求，不回落到 v1。
4. capability 只宣告已实现的只读分支，提供版本、构建摘要及固定 adapter 名；所有重置/取消/付费 v2 能力为 false。schema 检查用于拒绝明显不兼容，不冒充完整核心兼容测试。
5. 账号解析沿历史 `external_order_no → xboard_trade_no → Order.user_id → User.id`，要求成功证据。缺单、缺用户、pending 或证据不完整返回 unresolved；绝不回落历史邮箱，已用过的邮箱被其他人注册也不误绑。成功后撤销的历史仍可提供关联事实，不表示赠送资格有效。
6. 当前套餐按稳定 ID 读取，只返回白名单。字节/ID 使用十进制字符串，PHP 字符串整数加减避免溢出；保留 expires_at 的 0/null 区别，状态区分 active/expired/no_plan/blocked。未知/非法数据不伪造零，reset_count 只表示核心原值，不冒充 MoNexus 免费次数。
7. MoNexus 新 `lib/fakaBridge/accountV2.ts`，复用既有 URL、密钥、timeout 和默认 transport。目标限制为服务端配置 origin 下的固定 v2 路径；严格运行时校验响应及 request ID、订单号、稳定用户 ID，精确复核流量算术。失败只返回有限错误码，不输出响应原文/异常 PII。
8. v2 每次请求从已启用插件的数据库行读取独立配置快照，验签与业务读开关共用该快照；避开 Octane singleton 与 PluginManager 的旧内存配置。v1 缓存行为保留。

### 核验和修正

- 两个只读子代理分别审查插件和客户端，指出错误响应未绑定 request ID、常驻配置缓存可能让开关失效。两项已修正并增加回归断言；未让子代理修改代码或运行测试。
- 新客户端首次测试发现 Zod 在 regex dirty 时仍执行 refine，`BigInt('1e3')` 会抛出。已改 ID 上限为字符串比较、流量算术前显式验证十进制格式；畸形字段现在返回 INVALID_RESPONSE/INVALID_REQUEST。
- PHP 测试使用固定镜像的真实框架/模型/路由器及 PluginManager，关闭网络、只读挂载、SQLite 内存夹具。最终 **81 处断言通过**（包含每次响应的 no-store 断言，不等同于 81 个独立测试）。验证插件 migration loader、重复迁移、安装，以及模拟 1.5.0 缺 nonce migration 后由 update 应用新增迁移。
- 关键 PHP 断言还覆盖邮箱复用后定位原账号、缺单/删用户无邮箱回退、来源状态、64 位 ID/流量与溢出求和、0/null 到期、无套餐/封禁、非法流量、重放、时效/头/query/字段/body 拒绝、缺 nonce 表 fail closed。真实配置类在缓存温热后，DB 关闭查询和换密钥的下一请求均生效。
- MoNexus 定向两个文件共 **25 条用例覆盖通过**：签名 14 条、新客户端 11 条。最后改动只涉及客户端错误响应绑定，已仅重跑该文件 11 条通过；签名文件未改动。
- 最终后端 `npm run build`（含 runtime import）、架构/OpenAPI 检查、两仓库 `git diff --check` 通过。本轮无前端代码改动，没有重跑前端构建、全量测试或 E2E。
- MoNexus 测试仅用独立 tmpfs PostgreSQL 16 容器 `monexus-b0-20261025-19af`，初始化既有 107 个迁移。插件新增一个 migration，MoNexus schema 未变。没有连接开发/生产数据库。

测试限制：PHP harness 没有启动完整 Xboard Kernel/Octane/Horizon，核心表是显式最小夹具，不是完整生产 schema；没有验证 MySQL 并发或生产部署。此证据证明本地只读契约及迁移入口，不证明免费重置的事务原子性，也不代表真实 QQ 旅程验收。

### 交付和下一阶段

- 插件完整契约及运行方式：[FakaBridge v2 只读协议](/root/.codex/worktrees/19af/Mo-lab/docs/fakabridge-v2-read-contract.md)；MoNexus 接入边界见 [protocol-v2.md](./protocol-v2.md)。两仓库测试向量保持逐字一致。
- B1 接下来实现本地 XboardAccountLink/默认选择、历史可信来源扫描及回填、冲突处理和受 QQ 绑定授权的查询；正常老用户复用购买和邮箱证明，不要求全部重新绑定邮箱。
- B2 的权益发放/确认/outbox/插件原生 reset/幂等/取消/对账，以及 B3 的付费入口和 AstrBot 实际命令仍未实现。当前没有给用户发放机会，没有查询生产用户或重置流量。
- 未提交、推送、合并或部署；查询默认关闭，完整功能尚未交付。
- 收尾核对：原 MoNexus diff/status SHA256 仍与初始记录一致，原 Mo-lab 工作树干净；临时 PostgreSQL 容器已停止并自动移除，两仓库固定签名向量逐字一致。

## 第四批：B1 账号关联、历史回填及 QQ 只读查询

### 基线与范围

继续在 `feat/performance-qq-xboard-20261025`、`/root/.codex/worktrees/19af/MoNexus-new` 实施，HEAD 仍为 `9ac9dbd76eb198ba533743269c211eb4eb478b66`。保留前三批未提交改动，没有带入原工作区业务改动；本批未改插件或前端，没有部署、查询生产数据、发放权益或重置流量。

### 已实现

1. 增量迁移 `20261025120000_xboard_account_links`：实例、稳定链接、历史证据、默认偏好、幂等选择、扫描游标共六表。实例 ID 固定 origin，`(instanceId,xboardUserId)` 全局唯一归属；默认和选择记录都通过复合外键保证属于同一买家/实例。保留审计关联，不覆盖历史来源。
2. 可信来源恢复：成功 task 的 trade/完成时间、买家有效交付、正常站内状态，且开通邮箱在下单时已具备归属证明。注册邮箱可以不同；过期于现在但购买时有效的遗留证明可用，下单后才验证的证明不可反向授权。通过插件历史订单定位原 user_id，核对原 trade，不按邮箱重新找人。
3. 同用户多单合并账号并追加证据，来源订单唯一；不同用户并发认领同一稳定账号时阻止现有链接，不抢占 owner，不自动解除冲突。已退款/争议历史可以证明关联，不表示可赠送或可执行重置。
4. `xboard-accounts:backfill` 默认只读预览，单批默认 50、最多 100；按 userId/taskId 排序，输出有限分类汇总、异常任务引用、最后安全游标。应用模式使用共享 cron lease 和逐行 CAS checkpoint，远端故障不跨过失败行；空页重置游标并增加 cycle，支持重扫迟成功来源。单批 dry-run 会投影同批归属冲突，不写链接/游标。跨批 dry-run 不持久化投影，最终应用仍重新核验。
5. 查询开关启用后，每分钟自动处理至多 50 行，启动即尝试一批，退出停止定时器并等待在途批次。新订单关联为最终一致，历史量和远端故障影响等待时间；B2 权益发放仍须另接成功交付事务，不能用这个扫描代替。
6. 三个已挂载的 bot v2 POST：accounts/profile/select-default。原始 bytes 验签、8KiB/禁止压缩、唯一签名头、严格 DTO；Redis 原子 nonce 去重 601 秒，故障拒绝。共享主机 600/分钟与绑定用户 10/分钟限流，响应 no-store。支付 webhook 仍在前，全局 JSON parser 在后。
7. 从当前 QQ 绑定解析用户，不接受客户端 userId/邮箱/URL。查询前后重验绑定 ID、QQ、用户状态和账号归属；他人账号 404。单账号自动选中，多账号无偏好时要求选择。选择 requestId 幂等，异参/换绑复用拒绝，旧重试不覆盖后来选择。
8. 桥接能力/快照 15 秒缓存与在途合并，缓存按实例、URL、密钥和稳定 ID 隔离；瞬时故障最多保留 60 秒旧快照并标记。明确能力撤销清理旧快照，未知流量 null，不伪造零。流量字节保持十进制字符串，保留到期 0/null。
9. B1 不实现赠送计数：freeReset=null、canFreeReset=false、本平台成功次数=null；原生 reset_count 独立放入 xboardAllSources，不能解释为免费次数。
10. 同步环境示例、模块 README、OpenAPI 和签名协议；查询默认关闭。CLI 在关闭用户查询时可先预检/回填。实际 AstrBot 业务插件尚未定位/接入，群聊脱敏和真实 sender 仍须在适配器落实。

### 核验、修正与验证

- 两个只读子代理分别核验签名/授权/缓存和来源/并发/游标。修复预览游标跳过未完成行，补强选择记录复合归属外键。证据买家与来源订单买家的关系在恢复服务中重读校验；冲突证据允许关联到其他 owner 的被阻止链接，这是保留双方认领证据所需。
- 真实 PostgreSQL 首轮发现 advisory lock 返回 void 无法由 Prisma 反序列化，显式转为 text 后通过。配置子进程测试发现空字符串开关不应落入 Required，已复用严格 boolean parser，空/缺省为 false，模糊值拒绝。
- 最终分批定向 **51 条通过**：恢复 16、QQ raw 路由/授权/缓存 14、配置 10、既有支付 simulator 原始 webhook 旅程 3、旧 bot 绑定限流 8。最后改动只影响恢复/回填及异常输出，重跑恢复和 QQ 两文件共 30 条通过；配置最终 10 条通过，未重复运行无关套件。
- 覆盖不同注册邮箱、购买时证明及时间边界、退款关联事实、无效来源、来源在远端等待后变化、同用户去重、跨用户并发阻止、实例改指、dry-run 无写入与同批冲突、游标中断/续跑/cycle；覆盖实际 bytes 篡改、query/重复头/时间窗、并发重放、Redis 不可用、body 限制、越权、多账号及选择幂等、解绑/封禁/冲突、缓存隔离与故障边界、原生次数不冒充赠送。
- 最终后端 `npm run build`（含 registry runtime import）、架构/OpenAPI 检查与 6 条架构规则测试、`git diff --check` 通过。本批无前端代码修改，没有前端构建、全量测试或全量 E2E。
- 使用本批独立 tmpfs PostgreSQL 16 容器 `monexus-b1-20261025-19af`，仅绑定 localhost，初始化全部 **108 个迁移**；生成 Prisma client，校验本批 migration 完整匹配从 HEAD schema 到新 schema 的增量，再增加 CHECK 约束。迁移与约束仅在可丢弃库验证。
- 全库 `prisma migrate diff` 返回 2：仅指出既有 `ProductCategory_guestVisibility_status_sortOrder_id_idx` 存在于 20261021120000 migration、未声明于基线 Prisma schema。这项在 HEAD 已存在，本批没有删除该索引；Xboard 新表没有出现漂移。没有把全库 diff 报为通过或顺便改动分类索引。

验证限制：远端 bridge 和 Redis 使用可控测试替身，数据库为真实 PostgreSQL；未验证生产历史恢复率、真实 Redis 故障切换、完整 Xboard 服务联调或真实 QQ 会话。单批输出按来源行计数，不是去重用户/邮箱统计。自动扫描延迟与完整历史量相关，冲突异常仍需受控人工核验。B0 的固定镜像不能代替线上 digest 证明。

### 剩余阶段

B2 尚未实现：终身一次赠送权益、资格及退款衔接、确认意图、reset outbox、插件原生幂等执行/取消/对账。B3 尚未实现：AstrBot 实际命令、群聊/私聊渲染、稳定账号付费 reset 购买分支及真实会话灰度。P0 浏览器性能证据、字体和 P3 媒体变体仍按原记录待完成。

本批未提交、推送、合并或部署，查询默认关闭，完整赠送重置闭环未上线。原 MoNexus diff/status SHA256 与初始记录完全一致，原 Mo-lab main 干净；临时测试库在收尾停止并移除。

## 第五批：B2 一次赠送、确认、独立 outbox 与原生幂等重置

### 基线与交付范围

继续使用上述两个独立 worktree，MoNexus HEAD 为 9ac9dbd76eb198ba533743269c211eb4eb478b66，插件 HEAD 为 167e7f7fe8cad51c0b1580e4869a66d9284a5950；保留 P1/P2/B0/B1 未提交改动。本批未触碰原工作区业务改动，没有提交、推送、合并、生产访问或部署。所有开关默认关闭。

### 已实现

1. 增量迁移 20261025140000_traffic_reset_benefits 新增 Grant、Intent、ConfirmationRequest、Operation 四表：站内终身一次、预占与消费余额 CHECK、合法状态/尝试次数 CHECK、同意图及用户/requestId 唯一。确认重放的新 requestId 也持久化映射原 operation，不能后来复用到另一意图。
2. 直接成功交付及对账成功交付在原订单/交付/积分事务内发放；历史 B1 apply 共用 helper，查询不发放。尚未确认稳定身份时为 pending_verification，不能执行。基础套餐成功交付及当前有效来源是资格，重置包/退款/争议/取消/撤销不合格；有其他合格来源时更换依据，否则标记未完成操作待取消，保留已消费历史。
3. 意图使用专用服务端密钥 HMAC 派生 6 位 Base32，120 秒，最多 5 次错误；冻结稳定账号、原 QQ 绑定、实例、套餐/重置周期指纹，默认选择变动不改旧目标，支持当前/上一确认密钥轮换。同意图并发确认只有一个预占和 operation。
4. 独立 reset worker 每 5 秒一批最多 20，租约 90 秒、token CAS，HTTP 不进入 DB 事务；派发前再次检查来源/绑定/用户/关联，固定实例/origin/client/远端 ID。最多 3 次自动执行，5/30/60 秒退避，恢复先查远端。远端成功才消费，明确失败/取消才释放；超时、5xx、not_found 均继续预占并对账，取消需远端 tombstone，关新派发后既有操作仍核对。
5. 插件 1.7.0 新增 preview/execute/status/cancel 四个 v2 路由、InnoDB 操作及消费表。actor 与远端账号各有活动终身唯一；同 operation 异语义拒绝。执行/取消通过操作行锁裁决，原生流量/日志/计数、权益消费和成功状态在同连接外层事务内提交，无商业单、余额扣除、佣金或新用户创建。
6. 为固定测试核心增加构建期严格 SHA256 适配脚本：所有 performReset 锁并刷新当前用户，保留未保存购买字段；checkAndReset 在锁内复核周期；缓存/hook 延到外层提交后。原生 false、Eloquent 更新被 veto、核心已改而外层未提交时故障，都会撤销整个事务。afterCommit 不是持久化外发队列，不保证外部 hook 恰好一次。
7. NativeResetAdapter 仅接受精确补丁摘要、同默认连接和五张 InnoDB 表。普通 SQLite 部署不宣告写能力；只有显式隔离测试绑定可用。status/cancel 独立于写开关，但仍需认证、nonce 和事务表；客户端校验响应 requestId/operationId/hash、成功计数增量及订阅不变，不信任畸形成功。
8. 新增已挂载 QQ reset-intents/resets/reset-status，共用原始 bytes HMAC、可信 sender 绑定、Redis nonce 和限流；确认 202 不代表成功。profile 返回真实已发放余额和免费 v2 成功次数；付费历史未知，platformSuccessfulForAccount 仍 null，coverageScope=free_reset_v2_only，原生 reset_count 单列。
9. 成功后清理本进程流量缓存，并阻止旧在途请求回填。其他服务进程仍有既有 15 秒快照窗口，尚无跨进程失效广播。执行资格总是新预检，旧缓存不能授权免费重置。
10. 新增默认只预览的 traffic-reset:reconcile CLI，支持同 operation 恢复；取消需要正常 admin 与 8–200 字符理由，AdminLog 和取消请求原子写入，不直接加次数。新增开关/确认密钥/client ID 配置校验及环境示例，补生产 Compose 对 B1/B2 新变量的透传，未运行任何部署。

### 评审和修复

- 本轮只读审查分别覆盖本地幂等/绑定/预占，以及远端事务/取消/核心适配。修复了“重放的新 requestId 未被永久绑定”、普通 SQLite 写门控遗漏、原生保存被事件 veto 后可能误报成功三项，并补回归；子代理未改代码。
- 真 MySQL 首轮发现 information_schema 返回 ENGINE 大写字段导致适配检查误拒绝，增加显式别名。可复现 runner 初次又暴露 mysqladmin ping 在拒绝认证及初始化临时服务时仍成功，改成目标账号对夹具库认证 SELECT 1 后通过。
- 补充交付时 grant INSERT 故障触发器测试，证明原 task 成功、delivery、冻结积分扣款均回滚，没有为测试放宽业务状态或数据库约束。

### 定向验证

- 后端六个相关文件分批共 **71 条用例通过**：traffic-reset 13、reset client 10、config guards 13、QQ bot 16、原履约 worker 15、原 lifecycle 4。先六文件 68 条，再仅跑新增交付测试所在 worker 15 条、缓存修改涉及 reset/QQ 两文件 28 条、最后新增缓存竞争单用例 1 条；没有全量测试。
- 覆盖终身一次/待确认身份、20 路确认竞争、重复 requestId/绑定/默认目标、确认错误持久化、lease 竞争、远端成功丢响应、关闭派发后恢复、not_found 不释放、远端取消、退款/解绑、计划变化、余额 CHECK、改指拒绝、非法响应及跨语言向量；缓存竞争验证旧响应不会覆盖成功后的新缓存。
- 插件真实 Laravel/Eloquent/路由器/native 夹具：只读 **81 处断言**，SQLite 重置 **73 处断言**，真实 MySQL 8.4.11/InnoDB **92 处断言**。MySQL 用独立连接/子进程与屏障验证 execute/cancel 两种先后、跨 actor/account 终身唯一；验证 native false/veto、提交前故障全回滚、延迟 cron、写关闭后 status/cancel、无商业副作用。断言数不等于独立测试数。
- PostgreSQL 使用独立 tmpfs 容器，109 个迁移应用成功，Prisma client 生成；B2 migration 逐字匹配保存的 B1 schema → 最终 schema 生成增量，再附 CHECK。未重复运行已知基线分类索引漂移的全库 diff，也未删除该索引。
- 最终后端 build（含 runtime import）、架构/OpenAPI 引用检查通过；生产 Compose 用 /dev/null 环境和 no-interpolate 解析，验证八个新增变量存在；两仓库 reset 固定向量逐字一致；两仓库 git diff --check 通过。本轮没有前端代码变化，没有前端构建、全量测试或 E2E。

本地验证仍使用最小核心 schema/框架 harness；没有完整 Xboard Kernel/Octane/Horizon、节点上报、生产历史回填率或真实 QQ 会话证据。固定镜像不能代替实际线上 digest。尚未补齐低基数监控/告警及完整购买并发验收。

### 运维文档与剩余阶段

- [B2 模块与运维说明](../../../server/src/modules/trafficReset/README.md)：配置依赖、发放/预占、对账取消、开关和回退。
- [插件免费重置契约](/root/.codex/worktrees/19af/Mo-lab/docs/fakabridge-v2-reset-contract.md)：核心补丁输入/产物摘要、构建准备、InnoDB 门控、API/测试与部署限制。
- OpenAPI 和协议文档已更新实际 B2 DTO，不把免费次数冒充免费+付费终身总次数。
- **B3 仍未完成**：AstrBot + NapCat 实际命令和群聊/私聊渲染，当前套餐付费重置入口与稳定 ID 商业任务分支（含满额规则），付费历史计数、部署一致联调及真实 QQ 灰度。性能 P0 浏览器指标/HAR、字体、P3 媒体变体仍按前述记录待办。

因此本批完成 B2 的本地实现及定向验证，完整 QQ 查询/赠送/后续付费闭环仍不能宣布上线。两 worktree 全部保留未提交，待后续阶段继续。

本批收尾核对：原 MoNexus diff/status 的 SHA256 仍分别为 d9d6caa2f4d1f5bf18ba82054c287dcf2d5bc5cca221e3e537588e36b68d7d5c / 58cce6c6cd9a557f5d99900bb2689f3ac98d73e5d8368d6a8614833892709446，与初始记录一致；原 Mo-lab main 仍干净。已停止并移除本批两个临时数据库容器及 MySQL socket volume，自动 runner 的独立资源也已清理。

## 第六批：B3a AstrBot + NapCat 适配器及确认响应丢失恢复

### 基线与范围

继续使用上述两个独立 worktree，HEAD 均未变化，保留 P1/P2/B0/B1/B2 未提交工作；没有提交、推送、合并或生产操作。用户确认的栈为 AstrBot + NapCat；原业务插件源码在限定项目目录内仍未找到，因此在 Mo-lab 新增独立分发目录 astrbot-plugins/astrbot_plugin_monexus_xboard，而非把 Python 插件塞进 MoNexus 前端/后端发布包。

本批划分为 B3a（可安装机器人、查询与免费确认/进度）；B3b（稳定账号付费购买与履约）仍未完成。只读探索已经定位全部 B3b 触点：checkout preview、订单 schema/幂等指纹、商品/规格容量投影、邮箱校验表单、商业 task 稳定目标快照、worker/status/revoke，以及 Xboard 商业订单入口。固定核心的商业 open() 未检查 performReset 返回 false，正式付费接通前还需适配与测试。没有把旧邮箱预填购买链接当成完整闭环。

### 已实现

1. 独立 AstrBot 包 0.1.0：metadata.yaml、配置 schema、httpx 依赖和八个 QQ 命令入口。支持 aiocqhttp，查询/免费重置开关默认 false。包含我的套餐/查流量、我的账号、切换套餐账号、重置次数、重置流量、确认重置、重置进度；购买命令明确暂未开放，等待 B3b。
2. 可信 sender 取 event.get_sender_id()，不接受命令里的 QQ/邮箱/userId；群聊在接触客户端/上下文前返回私聊提示，不查后端、不返回账号/流量/验证码、不自动发私信。命令停止继续传播，不依赖 LLM 解释确认码。
3. Python 原始字节 HMAC v2，复用两端固定签名向量。严格固定 HTTPS origin/路径和有限 action，不跟随重定向、不使用环境代理，响应最多 128 KiB；连接 3 秒、阶段 8 秒、含有限重试总计 30 秒。网络/5xx 最多三次，同 body/requestId、每次新 nonce/时间戳；用户回复只映射有限错误，不透传远端文本或配置。
4. 最小 SQLite 上下文存于 AstrBot data/plugin_data/astrbot_plugin_monexus_xboard，按站点/QQ 分开，同用户本机串行。确认前保存原意图/目标/请求号，重启与超时重放保持原号，不保存明文确认码和完整套餐快照。数据库写失败阻止确认发出，未知结果阻止创建新意图。切换默认不改变已签发意图；序号来自刚展示的本人 UUID 列表、10 分钟有效。
5. 新增已签名 POST /api/bot/v2/xboard/reset-intent-status，严格平台身份+intentId，从本人原 QQ binding/实例找已提交的 operation。只读本地，过期及新请求/派发关闭后仍可读；他人/旧绑定统一 404。operation=null 只表示当前未观察到，不释放、不重建、不当失败。
6. 机器人“重置进度”可用原意图找回丢失的 operationId，所以关闭新的免费重置后仍能只读恢复。无后台轮询/主动消息，用户主动查询，避免消耗共享用户每分钟配额。202 显示等待/处理中，只有真实 succeeded 才显示成功。
7. 次数分开显示共享赠送可用/处理中/已使用、当前账号免费成功记录、原生全来源重置；付费历史明确尚未计入。未知/异常流量不伪造 0，缓存和查询时间可见。解绑/归属变化清除机器人本地旧上下文，不动后端权益/操作审计。
8. 按文件白名单生成可复现 ZIP，不包含配置密钥、运行数据库、测试或 pycache；Mo-lab 增加 Python/Ruff 缓存 ignore。安装说明强调 monorepo 根不是单插件 Git 安装入口，应上传 ZIP 或复制子目录。

### 核验和验证

- 三个只读探索分别核验购买链、插件商业生命周期和 AstrBot 现状。主线程经 GrokSearch 核验官方插件/命令/配置文档，未把文档 API 当成实际运行验收。一次源码抓取等待过长被停止，官方文档替代抓取成功；未采用未读取的 GitHub 源码内容下结论。
- 独立适配器审查发现不确定选择的原目标从新列表消失时可能卡住；增加“不带序号的切换套餐账号”按原 UUID/requestId 恢复，明确不可选时清理该选择等待，补消失目标回归。原状态未知时仍不直接换目标。
- **33 条 Python 定向用例通过**（仅 tests/astrbot）：签名向量、源 URL/头/原字节/fresh nonce/同 body 重试、禁止身份覆盖、群聊零后端访问、未知/缓存/计数口径、目标冻结、重复并发确认、错误码与到期、响应丢失/重启/停新写后只读找回、null 保持待核对、账号目标消失恢复、总超时、存储失败、跨站/跨 QQ 状态隔离；入口用 API doubles 验证八个 aiocqhttp 命令与真实 sender；安装包可复现/白名单/编译检查。
- MoNexus **只重跑 xboard-bot-v2.test.ts 的 16 条用例通过**；扩展原签名确认旅程覆盖 intent-status 未确认不写操作、已确认找回、意图过期/新请求关闭后读取、no-store、额外字段拒绝、他人/解绑重绑 404。没有跑全量测试。
- 后端 build（含 runtime import）、架构/OpenAPI 引用检查、两仓库 git diff --check、Ruff check/format check 通过。Ruff 0.14.2 只装在临时工具目录，未改运行依赖。无前端代码变化，不重跑前端构建或 E2E；插件 PHP/native 未变化，不重复 B2 夹具。
- 本轮没有数据库 schema 改动；只在新建 tmpfs PostgreSQL 容器 monexus-b3-20261025-19af 应用已有 109 个迁移做路由/授权定向验证，未连接开发/生产数据库。

安装包本地产物：/tmp/astrbot_plugin_monexus_xboard-0.1.0.zip，10 个条目、16905 bytes，SHA256 0f9c6b1650bf87c74d0409246454a1b1c0d76cbb0674442299c1c5125b645b00。包源码及 [安装说明](/root/.codex/worktrees/19af/Mo-lab/astrbot-plugins/astrbot_plugin_monexus_xboard/README.md) 在插件 worktree 保留。

### 仍未交付

**B3b 稳定 ID 付费 reset 尚未实现**，包括正确 Offer 链接、网站按本人关联账号结账、商业任务快照/幂等、插件商业 reset 按 ID 执行/状态/退款、满额但不新增订阅人数的专用门槛、付费历史次数；不应启用购买入口。

适配器测试使用受控 HTTP 与 AstrBot API doubles，尚未安装完整 AstrBot/连接 NapCat/发送真实 QQ 消息；仍须实际版本、Xboard digest、部署一致联调与内部灰度。性能 P0 浏览器/HAR、字体及 P3 媒体变体仍按前记录待完成。B3a 本地包不代表全部功能已经可以上线。

收尾：原 MoNexus diff/status 的两个 SHA256 与前批完全一致，原 Mo-lab main 仍干净；本轮 tmpfs PostgreSQL 已停止并自动移除。两个实施 worktree 的代码及文档全部保留未提交，安装包仅本地构建，无生产部署或真实消息发送。

## 第七批：B3b1 稳定账号付费重置的商业协议与 transport

### 基线及本批边界

继续使用两个既有独立 worktree，MoNexus HEAD 9ac9dbd76eb198ba533743269c211eb4eb478b66、Mo-lab HEAD 167e7f7fe8cad51c0b1580e4869a66d9284a5950 均未改变；保留前六批未提交工作。B3b 涉及网站、商业 worker、多种对账及 PHP 原生事务，本批先交付可独立验证的两端底层商业协议；**未接入网站下单/worker/QQ 购买命令，不能称为 B3b 完成或开放付费入口**。

### 实现

1. 插件 1.8.0 新增 paid-reset-preview/paid-reset/paid-reset-status/paid-reset-revoke，复用原始 bytes HMAC、共享 nonce、严格 DTO 和 no-store；不接受邮箱身份。user_id 保留十进制字符串，支持超过 JS 安全整数的 ID；plan_id 按既有 SQL INT 限制。preview 新鲜读取本人稳定账号对应套餐，执行在锁内重验。
2. 增量 migration 2026_10_25_160000 给 faka_orders 增加 protocol_version（旧单默认 1）、client_id、xboard_user_id、semantic_hash、result_payload。外部单号继续全局唯一，同号异账号/SKU/plan/client/period 拒绝；HTTP request_id 不参与业务 hash。两仓库 paid-reset-v2.json 使用独立 Python 固定向量。
3. 付费重置沿用核心 createFromRequest/paid/dispatchSync/open，正常商业价格、折扣、Xboard 余额及佣金机制保留，不创建 Xboard 用户，不消费或补发免费权益。有效套餐、未封禁、正额度、相同计划且配置可售 reset 价格才允许；现有账号 reset 跳过新增订阅人数限制，普通新购不变。
4. 同一外层事务覆盖 bridge 行、核心商业单、流量/计数及日志；固定商业核心 SHA 并复用 B2 原生补丁 SHA。提交前复核商业目标及完成状态、清零、reset_count +1、日志 +1、套餐/额度/到期不变，防止 pinned core 忽略 native false 导致假完成。原生 false、用户保存 veto、提交前故障全部回滚。相关模型同默认连接、所需表 InnoDB；未知核心/非事务表不宣告写能力，普通 SQLite 不开放。
5. execute/revoke 锁同一外部单号行；未知 revoke 原子写 tombstone，迟到执行不再运行。执行后退款只标记商业操作 revoked，保留冻结成功快照，不使原套餐过期，也不伪造流量恢复。status/revoke 独立于付费执行开关和当前套餐/SKU 是否存在，仍需认证、nonce、bridge 总开关与事务存储。not_found 仅表示未观察到，不能直接据此退款。
6. v1 支付/状态/撤销拒绝 v2 行，v2 也拒绝既有 v1 号，避免未知结果重试降级邮箱。另修复既有 v1 reset_traffic 退款误使原套餐过期的问题；普通套餐撤销逻辑保留。
7. MoNexus paidResetV2.ts 严格核对 envelope、request/订单/user/SKU/plan/hash，完成/已执行撤销必须有完整证据与次数增量；预执行撤销不得带伪造证据。调用方显式提供冻结 client ID；成功 transport 不等于履约成功，必须判断 operation.status。新模块尚未挂载用户端路由或商业 worker。

### 核验与定向验证

- 两个只读审查分别核验 PHP 事务/旧协议隔离，以及跨语言 DTO/响应绑定。修复响应未按 action 限定状态的缺口：新执行只能接受 completed/failed/已有 revoked，revoke 必须明确 revoked；补定向回归。主线程另补商业 open 后再次核对稳定目标，SKU 映射 plan_id 与 SQL INT 范围一致。
- PHP 定向商业夹具：SQLite **86 处断言**、真实 MySQL 8.4.11/InnoDB **106 处断言**。最终 MySQL 含最后的商业目标复核，使用真实镜像的 Laravel/Eloquent/OrderService/OrderHandleJob 与 patched native，最小核心 schema。多独立进程验证重复执行一次、执行/撤销两种锁顺序；覆盖大 ID、邮箱更名/旧邮箱复用、无新用户、满额 reset、原生 false/veto、提交前故障、回滚后同号恢复、关闭写后核对/撤销、未知 tombstone、业务拒绝终态及非事务商业表门控。
- 初次只读回归因测试中残留 1.7.0/迁移数断言失败，已更新为当前 1.8.0/四个插件迁移；初次 MySQL 夹具在最后 MyISAM 门控测试因 255 字符唯一 trade_no 超过其索引上限失败，夹具改为实际约束范围的 64 字符后通过，没有放宽生产门控。
- 改动涉及插件 capability、迁移和 v1 隔离，因此仅重跑既有只读 **81 处断言**与免费 SQLite **73 处断言**，全部通过；未重复不受影响的 AstrBot/Python 或免费 MySQL 套件。
- MoNexus 仅新增 paid-reset-client.test.ts，**22 条通过**：跨语言 hash、大 ID、签名固定路径、新 nonce/HTTP ID、目标冻结、篡改/脏 decimal/超界/证据、action 状态约束、取消前后差异、preview 绑定及额外身份拒绝。没有运行前后端全量测试或全量 E2E。本批没有网站页面改动，不重复前端构建或浏览器旅程。
- 后端 build（含 runtime import）、架构/OpenAPI 引用检查通过。PostgreSQL 使用独立 tmpfs 容器 monexus-b3b1-20261025-19af，应用既有 109 个迁移仅供现有测试 setup；本批没有 MoNexus schema 改动或额外全库 diff。

协议与运行边界见 [插件付费契约](/root/.codex/worktrees/19af/Mo-lab/docs/fakabridge-v2-paid-reset-contract.md)。这些测试没有完整 Xboard Kernel/Octane/Horizon、第三方 hook、生产数据、真实 Redis 或 QQ 会话证据；afterCommit 仍不是持久化外发队列。实际线上 Xboard digest 尚未知，独立付费开关默认 false。

### 下一接入步骤

- 商业 task 增量模型：冻结 protocol/link/instance/origin/remote user/plan/client，outbox、worker、全部 status/revoke 与 snapshot CAS 同步接入；v2 unknown/not_found 不能沿用 v1 的 404 自动退款。
- 网站本人关联账号结账：目标贯穿 offer、preview、幂等指纹、登录/充值回跳；后端验证稳定归属及当前计划，只有该 reset 分支免重复邮箱 OTP 和新购容量限制，价格/库存/权限仍保留。
- QQ 当前套餐正确 Offer 链接、付费成功计数覆盖范围、真实 AstrBot/NapCat 与部署一致版本联调；购买命令保持未开放。性能 P0/P3 仍按既有待办。

未提交、推送、合并或部署。原 MoNexus diff/status SHA256 仍分别为 d9d6caa2f4d1f5bf18ba82054c287dcf2d5bc5cca221e3e537588e36b68d7d5c / 58cce6c6cd9a557f5d99900bb2689f3ac98d73e5d8368d6a8614833892709446；原 Mo-lab main 干净。临时测试数据库在收尾停止并移除，不保留生产连接或新增线上数据。

## 第八批：B3b2 稳定账号商业任务、履约与退款对账

### 基线与范围

继续沿用两个独立 worktree，MoNexus HEAD 9ac9dbd76eb198ba533743269c211eb4eb478b66，Mo-lab HEAD 167e7f7fe8cad51c0b1580e4869a66d9284a5950；保留前七批未提交工作。本批只接商业任务底层，**网站结账仍未传入 paidReset，QQ 购买命令仍关闭**。已有 v1 订单不推断身份、不迁移成 v2；不能据此宣称付费购买闭环已经完成。

### 实现与约束

1. 增量 migration `20261025180000_paid_reset_tasks` 给 FakaBridgeTask 增加 protocolVersion、link/instance/origin/remote user/expected plan/client 快照、paidResetResult 与 resultVersion。旧行默认 v1；CHECK 限定 v1/v2 字段组合与 decimal 范围，触发器禁止切换协议、改写 v2 订单/目标/SKU/显示邮箱。刻意不添加 link FK，避免删除/阻止关联后丢失原任务撤销目标。
2. outbox 显式接收 `paidReset.accountLinkId` 才创建 v2；检查正常买家、本人 active link、固定实例来源和 reset SKU/period，冻结稳定 user_id，不用注册邮箱作目标。邮箱只取 link 用于展示。plan SQL INT 范围与 B3b1 保持一致；reset_price alias 必须显式传入 canonical reset_traffic period。
3. paidTask 统一执行/状态/撤销 transport，冻结 client ID 与语义目标。新执行前重验归属及用户状态；status/revoke 不依赖 link 当前仍 active。当前 instance/origin/client 与快照不符时拒绝外呼，不能把原任务转向新实例；恢复原受信配置后由同一任务继续，撤销耗尽可走既有 MFA 管理动作强制重试。
4. worker v2 首次执行，后续先读 status；未观察到可在次数内重发同号同目标，绝不回退 v1。成功证据、交付、capture 同一 Order→Task 事务写入；paid reset 不消耗也不新增 welcome 机会。精确 decimal JSON 保存原始证据，原展示 DTO 的 numeric 转换不参与授权或校验；null 到期显式保留无限期，超界时间不投影成新到期日。admin 到期同步对 paid reset 不请求实时订阅来覆盖历史结果。
5. HTTP 404、unknown、not_found、脏响应保留冻结积分；达到执行上限后转对账，取得 durable revoke tombstone 或明确 failed 终态才自动释放。取消发生在首次发出前也排入撤销，避免迟到请求越过本地取消。撤销五次未确认标记 failed，保留冻结资金待处理，不把 404 当作撤销成功。
6. 退款与在途执行并发时保留租约，成功迟到只写证据并排入撤销，不再交付/扣款。退款到来时也保留活动 revoke 租约。已执行再撤销保留交易号、before/after 和成功时间；不使用户原套餐到期。后续空 tombstone 或不同证据不能抹除已保存执行，冲突转人工核查。
7. Claim、结果写回和对账快照加入冻结身份/resultVersion 检查；迟到成功不能清除新 revoke 租约，迟到 status 不能退款或覆盖新执行。普通 v1 主路径保留，成功 CAS 未写入时现在返回 skipped，避免虚报成功。

模块与运维说明见 [fakaBridge README](../../../server/src/modules/fakaBridge/README.md#stable-account-paid-resets-b3b2)，协议和 Mo-lab 契约同步更新。本批没有修改插件 PHP 或 AstrBot 适配器代码。

### 定向验证

- PostgreSQL 使用独立 localhost/tmpfs 容器 `monexus-b3b2-20261025-19af`，从空库成功应用 **110 个迁移**。没有访问开发/生产数据库。Prisma Client 生成通过；既有 category 可见性索引与 schema 的历史差异未在本批处理，也未宣称全库 diff 为零。
- 新增 `faka-bridge-paid-reset-v2.test.ts` 共 **27 条不同用例通过**：最终主体 25 条通过，新增撤销状态归并的 2 条单独按名称定向通过，没有为最后两条重跑主体。覆盖不同邮箱、大 ID、归属/配置变更、DB 不可改目标、一次 capture、显式无限/秒级到期、超界到期不交付、丢响应 status 恢复、同目标重试、404/not_found/脏响应留款、tombstone 退款、撤销耗尽、取消前后顺序、证据保留与冲突、退款中的 revoke 租约、两种 stale CAS，以及不补发免费权益。
- 原有相关文件 `faka-bridge-worker.test.ts`、`faka-bridge-lifecycle.test.ts`、`faka-bridge-p1-hardening.test.ts` 合计 **45 条通过**。未运行前后端全量测试、全量 E2E 或无关前端构建。
- Node 22.23.1 后端 build（含 runtime import）、架构/OpenAPI 引用检查及 diff 空白检查通过。两个只读子代理分别核对夹具/测试边界和稳定目标/生命周期风险；已明确 checkout 尚未接通，以及配置轮换需先解决旧任务的运维限制。
- 这些测试使用真实 PostgreSQL 与受控 HTTP transport；不等于完整 Xboard/AstrBot/NapCat 联调或真实 QQ 验收。第七批插件的 MySQL/native 证据沿用，没有重复运行未改动的 PHP/Python 套件。CI 与发布所需的关键旅程门禁仍按仓库策略执行，本次局部结果不冒充 CI OK。

### 下一阶段

接网站本人关联账号结账：选择目标贯穿 offer、preview、幂等指纹与登录/充值回跳；服务端重验归属及当前套餐，仅该稳定 reset 分支免邮箱 OTP/新增订阅名额限制，价格/权限/库存仍保留。随后接 QQ 当前套餐正确 Offer 链接、付费次数覆盖说明，再做部署一致版本和真实 QQ 会话验收。性能 P0 浏览器测量、字体/P3 媒体仍按既有待办推进。

本批未提交、推送、合并或部署。原 MoNexus diff/status SHA256 与上批一致，原 Mo-lab main 干净。临时 PostgreSQL 在收尾移除；没有开放新增购买入口。


## 第九批：B3b3 网站稳定账号付费重置结账

### 基线与范围

沿用两个独立 worktree 及原 HEAD：MoNexus `9ac9dbd76eb198ba533743269c211eb4eb478b66`、Mo-lab `167e7f7fe8cad51c0b1580e4869a66d9284a5950`。保留前八批未提交工作。本批接通网站稳定账号购买，不修改 PHP/Python 实现、不新增迁移，不部署、不启用 QQ 购买命令。

### 实现

1. 新增独立 `XBOARD_PAID_RESET_TARGET_V2_ENABLED=false`，环境示例/生产 Compose 同步。开启需稳定实例及桥接 URL/密钥，不要求 bot/query/free 开关或 Redis。仅受支持的 plan-<正 SQL INT>-reset_traffic/reset_price 自动履约规格进入此分支；其他规格与 flag-off 保留旧路径。
2. `paidCheckout.ts` 校验本人 active 关联、当前实例/origin，返回脱敏选择；单账号可自动选，多账号必须选。最多 100 个选择，显式目标在上限外也加入返回；不向浏览器返回 remote user_id 或完整邮箱。
3. 目标版本以 HMAC 冻结站内用户/offer/link/instance/origin/remote user/plan/client/SKU，显示邮箱变更不改变身份。新鲜能力/远端 paid preview 在事务外读取，HTTP 后重验；订单事务内以 link FOR SHARE 再验目标并保持锁直到 task 插入。不凭注册邮箱或默认账号静默转投。
4. checkout preview 的 UUID 与订单 UUID/expected version 成对贯穿 schema、controller、API、幂等指纹及 outbox。稳定分支必须带幂等键，成功原请求仍先回放；同 key 改目标冲突。旧请求不含新字段时保留原指纹字节。task 使用 canonical reset_traffic 与 paidReset.accountLinkId。
5. 只对该分支移除 Xboard 邮箱表单/OTP 和新增订阅容量检查；保留本站邮箱验证、正常用户、商品权限、价格、库存/限购、原表单版本及非邮箱必填项。付费不消耗/补发赠送权益。公共投影不含私人资格，启用开关切换投影缓存命名空间，避免旧满额缓存禁用 reset。
6. 购买弹窗显示本人脱敏账号、付费语义和资格；切换目标重报价/重建幂等意图/重置确认，失败重试保持原 key，旧异步报价不能覆盖新选择。offer/account 贯穿普通及登录受限商品的登录、充值、重新报价回跳；关联失效时提供显式“重新选择账号”。隐藏不适用的续期天数展示。
7. OpenAPI、协议、模块运维与 Mo-lab 商业契约同步。关闭新结账开关不停止原 v2 task 的核对/撤销，禁止降级邮箱；仍需保留原受信实例来源/client/存储直至旧任务结清。

### 定向验证

- 新 `paid-reset-checkout.test.ts` **18 条不同用例通过**：主体 17 条通过，公共可售性最终调整只重跑对应 1 条，新增列表上限目标用例单独通过。覆盖两种 SKU、满额、注册/面板邮箱不同或更名、无需 OTP、JWT HTTP/no-store/严格字段、多个本人账号、他人/阻止/缺失目标、缺能力/关开关、目标/规格竞争、幂等回放与异目标冲突、价格/库存、普通新购原校验和真实网站订单创建 v2 task 后成功 capture/交付。
- 相关后端五个文件 **68 条通过**：faka-bridge-order、checkout-idempotency、faka-capacity-public-read、faka-bridge-paid-reset-v2、config-xboard-guards。串行使用专用 PostgreSQL，不与其他进程共享测试库。
- 受影响前端四个文件累计 **33 条不同用例通过**：原 26 条、首批新增 5 条，以及独立审查后新增的 2 条恢复回归。最后两处修复仅按名称运行“stale URL account”和“member-only product”两条，不重跑全量。涉及购买弹窗、详情页、orders API、返回 URL helper。
- 新 `e2e/paid-reset-checkout.spec.ts` 单条 Chromium 冒烟通过：URL 预选 A，切换 B，确认仅一次订单 POST，携带 B/正确版本/幂等键，无邮箱验证请求。浏览器使用受控 API 夹具，不是实际 Xboard/真实后端全链路验收；后端授权与履约另由真实 PostgreSQL 定向测试覆盖。
- PostgreSQL 容器 `monexus-b3b3-20261025-19af` 仅绑定本机、数据在 tmpfs，从空库应用已有 **110 个迁移**。未连接开发/生产库。没有运行前后端全量测试、全量 E2E 或无关 PHP/Python 套件。
- 最终前后端 build（含后端 runtime import）通过；构建仍提示旧 Browserslist 数据及 >500kB chunk，不把构建成功当作性能验收。架构/OpenAPI 引用和两仓库 diff 空白检查通过。
- 四次只读探索/核验覆盖后端触点、前端触点、稳定身份及 UI 恢复。独立复核发现登录受限商品回跳丢账号、失效账号只能重试两处 P2；主线程修复并补上述回归。未发现其他已确认 P1/P2。

### 尚未完成

下一步是 QQ 当前套餐正确 Offer 的购买链接，以及付费执行次数和历史覆盖说明。然后核对实际线上 digest、插件/核心补丁/web/horizon 一致性，完成真实 AstrBot/NapCat 查询、确认与购买灰度。新网站开关默认关闭，未部署；本批本地证据不能宣称可直接上线。性能 P0 浏览器指标/HAR、字体及 P3 媒体变体仍待完成。

收尾核对：原 MoNexus HEAD、diff/status SHA256 与初始记录完全一致，原 Mo-lab main 仍干净；两个实施 worktree HEAD 未变，全部工作保留未提交。已停止本批 Vite 预览并移除临时 PostgreSQL 容器及 tmpfs 数据；没有提交、推送、合并、生产操作或真实 QQ 消息。


## 第十批：B3b4 QQ 购买重置引用与已核实付费次数

### 基线与范围

继续使用 MoNexus `feat/performance-qq-xboard-20261025@9ac9dbd76eb198ba533743269c211eb4eb478b66` 与 Mo-lab `feat/qq-xboard-v2-read-20261025@167e7f7fe8cad51c0b1580e4869a66d9284a5950` 两个独立 worktree，保留全部前批未提交工作。本批新增后端 QQ 只读购买引用、执行计数及 AstrBot 0.2.0 接入；没有修改插件 PHP/native、网站页面或数据库 schema/migration，没有提交/推送/合并/部署或发送真实消息。

### 实现

1. 新增严格签名 POST `/api/bot/v2/xboard/purchase-reset`，与 profile 相同的 platform/platformId/accountLinkId? 输入，复用原始 bytes HMAC、Redis nonce、绑定用户配额、no-store 和本人多账号选择。需查询及稳定 ID 付费开关，免费赠送/执行开关不控制它。
2. `xboardAccounts/purchase.ts` 用稳定 ID 新鲜读取当前 plan，按 checkout 同样 trim/lower 规则精确匹配 reset_traffic/reset_price；不查注册邮箱、不拿旧快照或默认月付规格替代。SQL 先过滤商品/规格生命周期、归档、商家及本地库存，再按规范化 SKU 每种选一条，最多两种候选；一种 RESET_NOT_FOR_SALE 会继续另一种。
3. 候选通过既有商业能力和新鲜预检，等待后重验绑定/原稳定目标及商品状态。只返回 productId/offerId/accountLinkId/积分参考价，没有任意 URL、SKU、完整邮箱或远端 ID；无匹配/不符合资格返回有限原因/null，不创建订单、不扣款，网站结账仍需全部正式验证。
4. AstrBot `paid_reset_purchase_enabled=false` 独立于免费开关；私聊命令先解析当前账号，再用明确 UUID 请求引用。严格整数/范围、字段及账号一致校验，在本地配置的固定 HTTPS origin 生成 `/product/<id>?offerId=<id>&xboardAccountLinkId=<UUID>`，不接受任意 URL、邮箱或 SKU。未确认的账号切换先恢复；群聊保持零后端调用，不主动发私信。
5. `verifiedPaidExecution()` 复用商业操作严格 schema，并与 task 冻结的 order/user/SKU/plan/client/payload hash 逐项核对；须完整 before/after、真实清零、次数+1、不改套餐/总流量/到期。`resetHistory.ts` 按当前 instance/origin/稳定远端账号及本站买家读 v2 task，按外部单号去重；已执行后 revoked/refunded 仍计，失败、未知、无执行 tombstone、脏证据、他人/其他目标及旧 v1 排除。
6. profile 新增 paidSuccessfulForAccount 与 truncated，platformSuccessfulForAccount 为免费+付费已核实执行和，coverageScope=verified_v2_only。最多最近1000条付费任务；超出明确显示“至少”和已核实下限，不宣称完整终身总数。coverageFrom 是本地所见记录/权益时间，不保证完整统计起点；原生全来源仍单列。关新付费入口仍能查历史。
7. profile 和 purchase 在异步工作后同时核对归属与原稳定目标；账号被改向时拒绝旧结果。profile 更新展示邮箱的条件也绑定原稳定 ID，避免旧快照写入新目标。机器人校验终身一次赠送的余额守恒，拒绝矛盾响应。OpenAPI、两端 README/契约/协议及安装说明同步。

### 定向验证与独立复核

- 新 `xboard-paid-bot.test.ts` 累计 **15 条不同用例通过**：主体11条、稳定目标改向/1000条边界2条、独立复核后的商品匹配2条按名称分别验证。最后 SQL/授权调整后按名称重跑受影响用例，连同原 `xboard-bot-v2.test.ts` **16条**，最终一次 **26条通过、5条未选**。没有为了最后的小修改重跑整个后端套件。
- 覆盖两种 SKU 和大小写/空格归一化、正确 offer/account、严格签名身份/no-store/外来字段、无绑定/他人/blocked/多账号/开关、下架/归档/库存、错误 plan/普通月付不替代、远端失败/能力撤销、等待中解绑/商品下架/稳定目标改向、重复执行证据去重、执行后退款保留、无执行 tombstone/伪造 hash/错误增量/缺字段/其他用户目标排除，以及真实数据库1001条付费任务的统计下限。
- AstrBot 仅 `tests/astrbot` **39条通过**（原33条加本批6条）：新增固定站点本人链接、另选账号、无免费开关仍能获取付费引用、错误类型/恶意 URL/串号拒绝、无商品/资格不符不乱跳、v2计数覆盖/下限/退款说明/总数一致、赠送余额守恒、默认关闭及初始化传递。旧免费确认、未知恢复、群聊、签名、打包测试在同一小套件保留通过。
- 两轮只读探索定位后端/适配器触点；两轮独立复核发现 P2：第一规格不可售未继续第二规格、先截20条再过滤遗漏可售商品、赠送余额渲染允许矛盾数据。主线程全部修复并加上述定向回归。初始购买链接测试失败源于 B1 夹具商品默认 draft，修正测试夹具为 active；没有放宽生产生命周期门槛。TypeScript 另修正测试 Redis double 属性名与接口冲突。
- PostgreSQL 容器 `monexus-b3b4-20261025-19af` 仅绑定 localhost，数据在 tmpfs，从空库应用已有 **110个迁移**；未访问开发/生产数据库。后端 Node22 build（含 runtime import）、架构/OpenAPI引用、Ruff check/format check及两仓库 diff 空白检查通过。
- 没有前端代码变更，不重复前端构建/浏览器冒烟；PHP/native 未变，不重复 MySQL/SQLite runner。受控 HTTP/AstrBot API doubles、真实本地 PostgreSQL 不等于完整 Xboard/真实 QQ 联调或 CI 全部通过。

### 安装包与下一步

AstrBot 版本 **0.2.0**。安装包 `/tmp/astrbot_plugin_monexus_xboard-0.2.0.zip`：10个白名单条目、18485 bytes，SHA256 `0690381e2c64f02e99dd3cff6608b8236646ad88eb8c85b08c57db2bce959bdc`，不含密钥、运行数据库或 pycache。

本地查询/赠送/后续付费的主要代码路径已接通；新开关仍默认关闭、未部署。下一步需要实际线上 Xboard digest 与核心/插件/迁移/web/horizon 一致核对、历史账号预检和真实 AstrBot/NapCat 私聊/群聊及购买灰度验收，随后才能评估上线。旧版付费历史未覆盖；性能 P0 浏览器指标/HAR、字体及 P3 媒体变体仍待完成。

收尾：原 MoNexus HEAD 与 diff/status 两个 SHA256 均与初始基线一致，原 Mo-lab main 仍干净；两个实施 worktree HEAD 不变，改动保留未提交。本批 tmpfs PostgreSQL 已停止并移除，无残留测试数据库服务。


## 第十一批：B4 固定构建输入、源码安装包与容器文件核对

### 范围及实际环境事实

仍沿用两个独立 worktree 和相同 HEAD，未提交、推送、合并、部署或发送真实 QQ 消息。用户在本批明确选择由本人执行服务器操作、由助手提供命令和核对结果；首先只收集容器名称、镜像和不可变摘要，尚未取得当前线上部署证据。

本机只读清单显示：已有固定 Xboard/MySQL/Redis 镜像和停止的旧集成容器，无正在运行的 AstrBot/NapCat 实例；限定项目目录未发现其部署源码。旧生产脚本含历史远端信息，但同时支持同步/重启/真实付费请求，不拿它当当前部署事实，也没有执行或连接这些远端。没有读取业务环境文件或容器 Config.Env。

### 交付

1. Mo-lab 新 `release/xboard-reset/base-lock.json` 与 Dockerfile 固定既有测试镜像 digest、revision、原 TrafficResetService、补丁产物和商业 OrderService SHA256。`scripts/xboard-reset-release.py build` 只接受该核心来源，复用补丁生成器；用最小临时上下文封装核心补丁和 FakaBridge 1.8.0，保持原 entrypoint/CMD，不安装/迁移/启动业务。
2. 输入核对拒绝符号链接、未知插件文件、版本常量/配置不一致、非空默认 bridge 密钥或默认开启 v2 查询/写开关。source copy 后重新核对快照，避免源改动混入。manifest.json 记录全部23个插件文件摘要、22个PHP/JSON运行文件和与实际 capabilities.build_id 一致的构建 ID；相同输入清单稳定，不承诺跨环境的整个镜像二进制一致。
3. `bundle` 生成白名单源码 ZIP，包含构建工具、锁定文件、PHP 文件探针、补丁生成器、说明与插件源文件，附 BUNDLE-SHA256.json；不含环境、数据库、旧生产脚本或机器人登录状态。构包不构建/推送镜像或部署，目标文件/目录已存在则拒绝覆盖。
4. `check` 必须显式指定发布清单、web 和 worker。只选择读取镜像ID/运行状态/容器ID，以本地受信 PHP 代码读取容器文件；不启动框架、不读 Env、不访问DB或网络、不改业务数据。按不可变容器ID执行，并在返回前重验名称绑定，避免滚动替换时把旧镜像身份和新容器文件混在一起。其他scheduler/consumer需逐个另查。
5. 核对覆盖核心文件、插件完整文件集合、runtime buildId、容器镜像ID、缺失/重复容器、发布清单篡改及旧挂载漂移。ok=true 也明确 productionReady=false；不验证常驻内存/OPcache、真实worker启动、插件安装迁移、InnoDB/配置、签名能力、历史回填或QQ。capabilities 会写nonce，不能与本工具的无DB写入检查混称。
6. [构建与操作者步骤](/root/.codex/worktrees/19af/Mo-lab/release/xboard-reset/README.md) 给出从 docker ps、镜像ID/RepoDigests 到后续构建/文件核对的分步命令；未让用户先覆盖当前“最新版”。插件版本字符串只是元数据，源码身份以生成清单和buildId为准，不把1.8.0名称当作已审查源码锁。

### 本地证据

- 新 tests/release 小套件 **7条通过**：输入变化/摘要、未知核心、symlink/意外文件、版本/default secret/默认开关、静态文档漂移、源码ZIP可复现与白名单/哈希、容器替换竞态。只运行本阶段套件，没有重复前后端全量、AstrBot或PHP业务事务测试。
- 新镜像实际 Docker build 成功，构建内PHP检查真实落盘文件；固定核心摘要和插件buildId校验通过。初版仅允许php/json导致已有README被拒绝，随后明确将README列入允许源码并对全部文件做独立摘要，没有放宽环境文件白名单。
- 最终离线镜像 smoke **8个场景通过**：同镜像/文件匹配、实际插件私有buildId算法与Python清单一致、同容器别名拒绝、旧镜像拒绝、旧PHP挂载拒绝、非runtime文档挂载漂移拒绝、预期清单篡改拒绝、worker缺失拒绝。仅临时无网络/只读/PHP等待进程，没有真正启动web/horizon、数据库或访问用户数据；容器均自动清理。
- 独立只读复核指出原探针只覆盖php/json却声称全部文件、名称inspect/exec竞态两处问题；均修复并加上述定向回归。版本号不锁源码的条件性提醒已在说明中明确，不以版本字符串代替完整摘要。
- Ruff check/format与diff空白检查通过。业务代码与OpenAPI未改，不重复前后端构建、浏览器或原生MySQL夹具。

### 本机产物（未发布）

- 本机标签：`monexus/xboard-reset:b4-reviewed-20261025`。
- imageId：`sha256:46facbfae0a52b3925c6f73459c658e4c519ea36d6443d36b705606baefd12ca`，registryDigest=null；没有推送，不能用该ID冒充远端manifest digest。
- 发布证据目录：`/tmp/monexus-xboard-reset-b4-reviewed-20261025`，manifest SHA256 `657c890b28df9d9d78ecf9724fe53838d71027718ad98c8dc673cdb7ea012b66`。
- 插件 buildId：`88dca80e1f2cf51933d457bf4f3f361e9c2affebb52f718df145d1cfd1643b8d`。
- 源码安装包：`/tmp/monexus-xboard-reset-source-b4-20261025.zip`，30个条目、53964 bytes，SHA256 `212e381fd733346d8398fa364468185ebab0950db2d6c230bb3a483bcc0cdeb2`。早期b4-local构建被本条reviewed产物替代，不能混用其旧清单。

下一步由用户提供实际容器列表/镜像ID与RepoDigests，再核对其具体部署形式；随后才能给出对应环境的构建/备份/迁移/一致加载/签名能力及真实QQ测试步骤。所有新功能仍未部署、默认关闭。性能P0/P3及旧版付费历史覆盖限制保持不变。

收尾核对：原 MoNexus diff/status 指纹与初始记录一致，原 Mo-lab main 干净，两个实施 worktree HEAD 未改变；临时 smoke 容器全部清理，早期 b4-local 镜像标签/清单已移除，仅保留 reviewed 本机产物与源码包。改动仍未提交，用户尚未执行真实部署。


## 第十二批：SSH 只读生产核对与实际发布步骤

### 授权、范围与基线

用户提供两台机器的 SSH 访问并授权继续核对。两台均成功以 root 连接；只检查相关容器、镜像身份及源文件，没有读取环境/运行配置密钥、QQ 会话、业务日志或用户数据，没有查询生产数据库、启动应用框架、调用业务 API、执行迁移、重启/部署或发送 QQ 消息。

继续沿用两个独立 worktree；MoNexus HEAD `9ac9dbd76eb198ba533743269c211eb4eb478b66`，Mo-lab HEAD `167e7f7fe8cad51c0b1580e4869a66d9284a5950`。原工作区未改，前批未提交改动全部保留。

### 已实证的部署条件

1. Xboard `xboard-web-1` 与 `xboard-horizon-1` 使用同一 image ID；RepoDigest 与本地固定基镜像 `sha256:2633d6085768c57b5234b165a57569502728a795888602a7c233ccd3d4eb47b8`、revision `935522d28bbeb666824facd8bdd674db8ab37df1` 一致。两边 TrafficResetService 均为已知原始摘要，尚未打事务补丁；OrderService 与本地验证版本一致。
2. `/root/Xboard/plugins` 挂载到两个容器 `/www/plugins`。现用 FakaBridge config.json 为1.5.0、PHP常量1.3.1，10个源文件，缺少本次13个新增文件。web 未发现更高优先级 plugins-core/FakaBridge。版本不一致及源文件缺失不用于猜测数据库登记版本/迁移状态或内存代码。
3. 实际核心 PluginManager 源码确认 update 会禁用、runMigrations、升级登记版本、保留原配置并重新启用；卸载会回滚迁移。发布不能只复制文件/restart，也不能卸载重装。
4. MoNexus 前后端 OCI revision 均为生产 `d4c503299f7324c461028831d229753000d5bad0`，Compose 目录为该 revision 的 `/opt/monexus-releases/` 子目录。此提交的第二父提交是开发基线9ac9dbd，两者 Git 树 diff 为空；不因合并提交号不同重新创建 worktree。生产 server 启动含 migrate deploy，启动新镜像属于生产写操作。
5. AstrBot4.27.2、NapCat4.7.78、httpx0.28.1。只读核对公开 API 源文件/子包与本包所用符号存在，版本/依赖符合声明；新 Xboard 适配器未安装。原 monexus_checkin1.2.0 的直接命令未与新包重名，不据此宣称所有别名/插件分发均无冲突。未读取 OneBot/QQ 配置，不冒充真实会话验收。

### 文档及产物

- 新 [实际部署核对与分阶段发布步骤](./production-readiness.md) 固化线上摘要/部署路径及边界，明确先构建/备份、处理宿主机挂载、执行插件/Prisma增量迁移、共同重建web/horizon、先预览再回填、安装独立适配器及保留对账的回退顺序。
- 明确编译镜像用 `node dist/scripts/backfillXboardAccounts.js`，不是需要src的开发 npm 脚本；query开关启动时会自动apply历史关联，不能标作数据库纯读取。现有实现无用户allowlist，内部主动测试不等于内部限定可调用范围，严格内部灰度需隔离/受控入口或后续补齐allowlist。
- 总览/主方案补充已取得的版本证据；Mo-lab旧v1部署文档增加v2发布指引，避免旧“复制+restart”路径被用于本功能；适配器README同步实际版本及未验收边界。没有修改业务实现、schema或迁移。
- 适配器仅README变化，重新生成 `/tmp/astrbot_plugin_monexus_xboard-0.2.0-production-audit.zip`：10条目、18673 bytes、SHA256 `27bb5cf12fa5dee8534a42c2044b87b88d3ae632d9d273bbe64aee2742845916`。逐条与当前白名单源码比较通过；早先0.2.0 ZIP保留为前批快照，不混用两份hash。
- Xboard插件23个文件与第十一批manifest逐个摘要比较，全部一致；固定镜像/核心/plugin buildId和源包沿用前批产物，无需重建。文档没有将本地imageId冒充registry digest。

### 核验与剩余工作

两个只读子代理分别核对远端Xboard与机器人文件；主线程点验实际核心升级源码、plugins-core优先级及公开AstrBot API。另一个只读复核核对新runbook的cron/grant、Docker编译CLI、开关/对账及InnoDB/迁移要求，未发现指定范围内已确认的重大操作错误。两仓库diff空白检查通过，原仓库基线指纹保持不变；本轮无业务代码变更，不重复任何全量/业务套件。

下一段是冻结发布源码、按现有流程准备最终前后端发布身份，再进入有备份的维护部署和受控内部验收。生产登记版本/启用配置、迁移/引擎、历史恢复覆盖、所有常驻消费者、端到端签名/真实QQ及实际免费/付费执行仍待实证；性能P0线上测量及P3媒体/字体仍未完成。没有提交、推送、合并或生产变更，不能宣布已上线。


## 第十三批：保留现用SQLite，补齐事务执行及并发验证

日期：2026-10-26。沿用两个独立worktree与原HEAD，保留全部既有未提交改动。最初准备冻结候选发布，数据库只读预检发现实际环境不符合旧MySQL写门禁，故先完成兼容修复；用户明确选择“保留SQLite，补齐兼容与并发验证”，没有授权迁移至MySQL。

### 生产只读事实与发布取舍

- 通过vendor autoload及Dotenv仅在进程内解析既有连接信息，没有启动Kernel或插件。PDO使用SQLite只读打开标志、query_only及读事务，仅投影schema/迁移名和插件code/version/is_enabled；没有执行生产DDL/DML、调用业务API、外发消息或输出密钥/业务记录。
- 实际数据库为SQLite3.53.4/WAL，插件数据库登记版本1.4.0、启用；仅July原始Faka迁移，nonce/operations/consumptions三表和商业身份字段尚未安装。User重置计数/周期字段和原生日志表已存在。文件配置1.5.0/PHP常量1.3.1不再被误当成数据库登记版本。
- web的数据库文件位于已知持久数据挂载内，连接配置synchronous=normal、busy_timeout=30000。后续两次SSH连接超时，未取得horizon的同文件身份复核；不猜测原因，也没有改网络/SSH配置。共享持久文件与新运行态仍需发布前核对。
- 本地发布workflow要求同一正式SHA的CI、双架构镜像发布和受审批入口；本轮候选产物不冒充正式发布，也不把未提交源码标为基线commit的完成构建。MoNexus最终源码冻结/发布身份仍留待后续收口。

### 实现

1. `NativeResetAdapter::transactionalTables()`集中检查事务存储。保留MySQL/InnoDB检查；真实SQLite须为单一main文件/WAL、synchronous至少NORMAL、query_only关闭、无额外attached数据库、关键main表存在且无TEMP同名遮蔽。普通内存库仍拒绝，旧隔离测试绑定只豁免内存夹具。
2. 免费与付费复用存储检查，核心User/Plan/TrafficResetLog与商业Order/FakaOrder核对同一默认连接对象，避免跨连接写入逃逸外层事务。status/cancel/revoke继续独立于新执行开关，但仍依赖受支持存储/认证。
3. 桥接写操作的INSERT OR IGNORE在读取可变状态前取得SQLite写锁；核心补丁在performReset及checkAndReset的事务内先执行零行UPDATE，再读取当前用户/周期。没有改变用户行或生产journal配置，保留未保存购买字段、原生日志/计数及外层afterCommit。
4. 新补丁SHA256为 `75feffb645e22def3f2afb8789b141cb848e5b970e9bc468d5f704993c5798c9`，已同步NativeResetAdapter和base-lock；旧e803de1c补丁不与新插件混用。原始核心/OrderService/基镜像摘要保持不变。接口及TypeScript/Python业务协议未改，无新迁移。

### 定向验证与独立复核

- 文件型SQLite/WAL免费夹具 **104处断言**、付费及SQLite扩展 **187处断言**通过，均无隔离测试特权绑定。共享真实数据库文件，每个子进程先断开继承PDO再建立独立连接，并重设事务管理器。
- 覆盖同operation/order重复执行、免费跨账号/actor终身唯一、执行与取消/撤销两种顺序、免费/付费两种顺序、计划重置与免费意图两种顺序、两个陈旧原生模型；实际SIGKILL发生在原生及ledger写入后、外层提交前，验证免费/付费均无部分计数/日志/订单/消费，原业务ID可安全重试。
- 独立测试复核指出旧屏障只有固定休眠、免费等待超时不失败及部分用例无屏障；主线程修复SQLite屏障：竞争连接以busy_timeout=0实际证实写锁冲突，再在真实DML的beforeExecuting处握手，leader取得确认后才继续。缺屏障会失败；所有SQLite多进程唯一性/重复执行用例均使用该机制。busy503另由leader一直持锁直到真实请求返回，再释放，验证原ID恢复及无伪造终态。
- attached、TEMP遮蔽、synchronous OFF、非WAL和query_only均拒绝执行能力。锁失败不被持久化为业务失败，恢复使用同一ID/fresh nonce；仍不能以not_found自动释放本地资金/次数。
- 受影响MySQL定向回归：免费 **97处断言**、付费 **106处断言**通过，保留原商业语义及事务边界；仅可丢弃MySQL8.4.11/tmpfs/socket夹具，收尾自动清理。断言数不等于独立测试数。
- 两轮SQLite设计/测试探索、两份改动独立复核；源码事务复核未发现已确认问题，测试证据问题如上修复。没有修改前后端业务、机器人或API契约，不重复前后端全量/构建、AstrBot或无关只读测试。原仓库基线指纹保持不变。

### 更新后的候选产物（本地，未发布）

- 镜像 `monexus/xboard-reset:b13-sqlite-reviewed-20261026`，imageId `sha256:fd147fa26e3d67ec9ed2a2286b3a477cbfe68f5de269def61f82a7650348a3a5`，registryDigest仍为null。
- 发布目录 `/tmp/monexus-xboard-reset-b13-sqlite-20261026`；manifest SHA256 `98f6016641a81ef80101bf8ab2f97c859ba2efe548143a69dbdddc2ed396eda2`。
- FakaBridge仍为尚未发布的1.8.0快照，runtime buildId更新为 `84461f991ee5bcd7bcf554569ef50de3fcde18e96a2357d9e7b004565f77fa6a`；23个全部文件、22个PHP/JSON运行文件。版本字符串不代替buildId/清单。
- 新源码安装包 `/tmp/monexus-xboard-reset-source-b13-sqlite-20261026.zip`：30条目、54555 bytes，SHA256 `798ac2cb9911466aaabac8062058eb24f265dfbb432377d8dbe349d519db662d`。第十一批旧镜像/源包保留为历史快照，当前候选改用本批，不能混用hash。
- 实际Docker构建及内置PHP文件核验通过，发布工具 **7项**输入测试、离线候选镜像 **8个**文件核对场景通过。check仍为productionReady=false；没有registry push、生产部署或能力探测。
- 同步免费/付费契约、发布说明、runbook和模块说明；SQLite备份要求一致性API或停写后的完整快照，不能运行时只复制主文件遗漏WAL。备份/迁移/部署本轮均未执行。

### 后续门槛

先恢复SSH可达性并完成horizon同库、全部消费者与一致性备份核对，再收口MoNexus正式发布身份/所需CI与镜像、执行新插件/Prisma迁移和真实QQ验收。尚无生产历史覆盖/正式灰度allowlist、掉电/文件系统故障、所有第三方购买/节点写路径的全站证据；不把最小schema文件夹具称为完整生产验收。性能P0与P3仍未完成。

原MoNexus diff/status SHA256与既有基线完全一致，原Mo-lab main仍干净；两个实施worktree HEAD未变，改动保留未提交。新测试服务/文件位于可丢弃容器，未操作旧停止的集成容器。没有提交、推送、合并、生产迁移、重启或真实QQ消息。

## 第十四批：冻结发布、可恢复备份与 Xboard 关闭执行升级

用户授权由代理完成部署与联调。两边实施 worktree 冻结并推送：MoNexus `0e80e36c58233b4fe7b7ca9a298fbb127b688407`，PR #307 → develop；Mo-lab `d8f12a8cf4864840b0b1c8320bc1d7b0b4bc146d`，PR #2 已合并，合并提交 `fb29e5013f8631fa2b8992a34b3032d152ef600b`。原用户工作区 diff/status 指纹保持不变。文档跨仓库链接改为可分发的 GitHub 链接。

### 生产预检与备份

- 已通过两台机器 SSH；Xboard 连接曾间歇超时，后通过连接复用继续操作。Web/Horizon 的 SQLite 物理文件身份摘要相同，均为持久化文件、SQLite 3.53.4/WAL。
- PostgreSQL 只读预检：107 个成功迁移，零失败、零 checksum 差异；仅本次 3 个新增迁移待执行。14 个既有桥接任务均 succeeded，无活动租约或未结清撤销任务。未输出用户记录。
- 私有备份目录 `/root/monexus-release-backups/20261026-qq-xboard-063032`，权限 0700。SQLite 使用在线 backup API 得到一致快照，`integrity_check=ok`；PostgreSQL 使用 pg_dump，自带 TOC 检查后在 network=none、tmpfs 的临时 PostgreSQL 中成功恢复，确认 107 个迁移。临时库已删除。备份包含部署配置及旧插件；不把备份内容写入仓库。
- AstrBot 配置、Compose、现有签到插件已备份到插件扫描目录之外的私有目录。新插件 0.2.0 的 10 个文件已安装，三个开关默认关闭，尚未运行重载或真实 QQ 验收。当前 ZIP SHA256 `467bdf40adb2bfd9b4ad21676eacc1ae19b19e6d40bab67f81fc5778ccd6c234`，包含可分发文档链接。

### Xboard 实际升级

- 目标机从固定源包构建，manifest SHA256 仍为 `98f6016641a81ef80101bf8ab2f97c859ba2efe548143a69dbdddc2ed396eda2`，目标机镜像 ID `sha256:c89dfe6da086d12e3fd0baedf546661f4fad0a056c2aaf82da8b2e67f68a0824`，不冒充 registry digest。
- 在生产 SQLite 备份副本、network=none 的临时容器上启动真实 Kernel，执行 PluginManager 升级：1.4.0 → 1.8.0，三个迁移成功，原配置完整保留，native SQLite 适配、read capability 和免费/付费关闭门槛均通过。副本不挂载生产数据目录。
- 短暂停止商城 server 与 Xboard PHP 进程，确认桥接任务清空后，完整更新宿主插件、执行生产插件升级迁移，共同重建 Web/Horizon。商城原发布恢复 healthy。运行容器镜像/文件检查通过；免费/付费执行仍关闭。
- 持续检查发现上游 `/entrypoint.sh` 会递归 chown `/www`，触及嵌套 Redis 数据目录，导致 Redis RDB 权限错误及 PHP 重启。已将 PHP 对 `/data` 和 `/www/.docker/.data/redis` 的挂载改为只读，保持 SQLite 主挂载可写；恢复 Redis 实际运行 UID/GID 后 BGSAVE 成功。没有关闭 Redis stop-writes-on-bgsave-error，也没有 chmod 777。当前 Compose override 保存在 `/root/Xboard/compose.override.yaml`；后续显式 `-f compose.yaml` 操作须同时带上 override。

### CI 与剩余门槛

- 首轮 PR CI 的后端、前端构建、架构、真实 Redis/对象存储等通过，默认 Playwright 分片 2 的新增付费冒烟失败。原因是 `**/api/**` 同时拦截 Vite `/src/api/auth.ts`，夹具返回 404。已改为 URL pathname 必须以 `/api/` 开头，使用 Vite 开发服务单独执行该用例，1 条通过（12.3s）。没有手动重跑全量测试；更新提交后由现有必需 CI 执行。
- MoNexus 新版本尚未合入 develop/master 或部署，生产仍为 d4c5032；三个 Prisma 迁移尚未执行。正式流程须同 SHA CI/双架构镜像成功并经过 production Environment reviewer。
- 真实免费/付费验收仍等待用户指定自有测试账号及允许的实际消费；不对普通用户试重置。性能 P0 浏览器/HAR 与 P3 字体/媒体仍未完成，不宣称整项上线验收完成。


### 第十四批后续收口

- 修复提交 `f14f5e3f5d3017765de3b6f5be1b48e472236754` 的全部必需 CI 通过，PR #307 合入 develop，合并提交 `2dcf38af8627698e95dafa0bf9e8eb6ab2626373`。从当前 master 创建独立 release worktree，合并 develop 历史，继续 master 发布 PR，不直接从脏目录发布。
- 真实签名 v2 capabilities HTTP 200，request_id/buildId 匹配，resolve/subscription=true、free/paid execution=false；旧 v1 plan-catalog HTTP 200。修复 Redis 挂载后持续检查 Web/Horizon restartCount=0，商城 server healthy。
- AstrBot 4.27.2 对未注册插件调用普通 reload 会退化为重载所有插件，未使用该路径。通过内置上传安装接口只加载新插件，运行登记数 31 → 32，原插件 name/version/activated/root_dir_name 均保持一致；新插件 activated=true、三个配置开关 false。没有重启 AstrBot/NapCat 或发送 QQ 消息。管理请求仅在容器 loopback 内使用短期凭证，未输出/持久化临时 token。
- 生产 `.env` 已私有备份并原子准备稳定实例 ID、monexus client ID 与独立确认密钥，全部 5 个新增开关显式 false；当前旧容器环境不受影响。新 bot 配置已写入 HTTPS origin 与既有 BOT_SHARED_SECRET，权限 0600；不含 Xboard bridge secret，持久状态目录写权限已核对。配置值/密钥未写入仓库。
- MoNexus 新部署、Prisma 增量迁移、账号恢复与真实 QQ/赠送/付费验收仍待后续完成；不能把 Xboard 已升级、bot 已加载称为整个功能已对用户开放。
