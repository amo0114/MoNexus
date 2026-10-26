# 实际部署核对与分阶段发布步骤

初次核对日期：2026-10-25（Asia/Shanghai）；2026-10-26补充数据库只读预检与SQLite兼容。通过用户提供的SSH访问，只读检查相关容器、镜像身份和源文件；第十三批还以原生PDO只读方式读取SQLite元数据。没有部署、重启、调用业务API、启动应用框架、执行生产DDL/DML或发送QQ消息。下方原始检查记录之后，新增了本轮执行进度；以执行进度和实施记录为当前状态。

## 2026-10-26 执行进度

用户已授权代理执行。Xboard 已从固定输入构建并升级至补丁镜像，FakaBridge 1.8.0 与三个新增迁移已落地；v2 查询已启用，免费/付费执行关闭。Web/Horizon 同一持久 SQLite 文件，商城旧发布已恢复健康。AstrBot 新插件已通过上传安装接口定向加载，原 31 个插件登记状态保留，三个新功能开关关闭。

签名 v2 capabilities 和既有 v1 套餐目录均已返回 HTTP 200，buildId 与本次清单一致；执行能力关闭。持续检查 Web/Horizon 重启计数均为 0。数据库备份及恢复验证已完成；真实 Kernel 在生产 SQLite 副本上完成升级演练。升级时发现上游入口脚本 chown 共享 Redis 目录，已通过 PHP 只读 Redis 挂载与恢复正确属主修复，BGSAVE 成功。后续必须保留 `/root/Xboard/compose.override.yaml`，不能只使用基础 compose 绕过此覆盖文件。

MoNexus PR #307 的修复提交 f14f5e3 已通过全部必需 CI，合并到 develop（2dcf38a）；master 发布 PR 正按既有流程准备。新应用与 Prisma 迁移尚未部署。自有测试账号、真实 QQ/重置/付款及性能指标仍待完成。详细证据见 [第十四批实施记录](./implementation-log.md)。以下第 1/2 节保留升级前核对结果，作为变更对照；第 3 节起是各阶段操作说明，不能将尚未执行的步骤当作完成。

## 1. 升级前结论

本地实现与线上 Xboard 基础版本匹配，可以沿现有固定镜像方案准备升级；线上尚未安装本次功能，不能直接打开开关。

| 部分 | 实际核对结果 | 上线前处理 |
| --- | --- | --- |
| Xboard web / horizon | 同一基础镜像、同一核心文件摘要；尚无重置事务补丁 | 两者共同切换至经过核对的补丁镜像，重建进程 |
| FakaBridge | 文件配置版本 1.5.0、PHP 常量 1.3.1；缺少本次新增的 13 个文件 | 完整升级至本地 1.8.0 快照，执行插件升级迁移并验证原配置保留 |
| 插件目录 | `/root/Xboard/plugins` 挂载到两个容器的 `/www/plugins` | 必须更新宿主机 FakaBridge；只换镜像仍会被旧挂载覆盖 |
| MoNexus | 仍运行 `d4c5032` 发布；与开发基线 `9ac9dbd` 源码树相同 | 将本次改动按现有发布流程构建前后端并应用增量迁移 |
| AstrBot / NapCat | 4.27.2 / 4.7.78，现有签到插件 1.2.0；未安装新适配器 | 单独安装 Xboard 适配器 0.2.0，保留原签到插件 |
| 生产 Xboard 数据库 | SQLite3.53.4、WAL；数据库插件登记1.4.0、启用；三张v2新表及商业身份字段尚无 | 使用第十三批SQLite补丁/插件；应用新增迁移并核对同一持久文件与运行连接条件 |
| MoNexus 数据库及真实 QQ | 本次未检查/验收 | Prisma迁移、历史证据覆盖、真实会话仍是发布门槛 |

## 2. 升级前镜像与文件证据

### Xboard

- Compose 目录 `/root/Xboard`，配置 `/root/Xboard/compose.yaml`。
- 容器 `xboard-web-1` 使用 Octane，`xboard-horizon-1` 使用 Horizon。这里只核对启动参数分类，没有证明所有 scheduler/consumer 均已清点。
- 配置镜像 `ghcr.io/cedar2025/xboard:935522d`。
- 实际 image ID：`sha256:a297206b557072edadebd4ae84fc60bc0c9946864ff536b3c8a74c85199b7d31`。
- RepoDigest：`ghcr.io/cedar2025/xboard@sha256:2633d6085768c57b5234b165a57569502728a795888602a7c233ccd3d4eb47b8`。
- OCI revision：`935522d28bbeb666824facd8bdd674db8ab37df1`。

两个容器分别按不可变容器 ID 读取，结果一致：

| 文件 | 线上 SHA256 | 与发布输入比较 |
| --- | --- | --- |
| `/www/app/Services/TrafficResetService.php` | `147f535d7cb3a5cefb2569d6e03102be0ab71b89f21ea4d6ca79c683fe18a26d` | 等于原始核心；待换为第十三批SQLite补丁摘要 `75feffb645e22def3f2afb8789b141cb848e5b970e9bc468d5f704993c5798c9` |
| `/www/app/Services/OrderService.php` | `50d712e59c90b60d71269dc08cb95aecd0b0808dde912145ee585fc2ec91b6bf` | 与已验证商业核心一致 |

宿主机 `/root/Xboard/plugins/FakaBridge` 共发现 10 个文件，仅含 July 的原始迁移。相对本地发布清单，缺少 3 个 v2 Controller、7 个 v2 Service 及 3 个 October 迁移。`config.json` SHA256 为 `46981e088ce19d8d4614939e8fe13995a72f029765ab0e2d9527abce9bc01201`；`Plugin.php` 为 `a0c9b37263775b573a588f2671eefdcb7823f0e65406c79477990bdf4892ce8b`。文件版本冲突不能用于推断数据库登记版本或内存已加载版本。

web容器未发现更高优先级的 `/www/plugins-core/FakaBridge`。这不代替发布时对所有容器执行完整文件检查。第十三批使用PDO SQLite只读打开标志、query_only与只读事务核对元数据：数据库插件登记版本1.4.0、is_enabled=1；只有July原始Faka迁移，nonce/operations/consumptions表和faka_orders商业身份字段均不存在。核心User的reset_count/last_reset_at/next_reset_at及日志表存在。没有输出配置密钥或业务记录。

实际SQLite为3.53.4/WAL，web配置synchronous=normal、busy_timeout=30000，主文件位于已知持久数据挂载内。第十三批用户明确选择保留SQLite，已补齐受约束的SQLite执行适配和文件型多进程验证；生产迁移、内存加载及实际签名能力仍未验收。共享文件身份需在发布前按web/horizon重新核对，不能仅凭同名路径认定同一数据库。

### MoNexus

生产 Compose 目录为 `/opt/monexus-releases/d4c503299f7324c461028831d229753000d5bad0`，使用其中 `docker-compose.prod.yml` 和 `docker-compose.vps.yml`。

| 容器 | RepoDigest | OCI revision |
| --- | --- | --- |
| `monexus-server-prod` | `ghcr.io/amo0114/monexus-server@sha256:d4cc33bb831d6a0fd6dc705e77a3ca29697a8f62cb3a92d1f1b7526d72e1d2b8` | `d4c503299f7324c461028831d229753000d5bad0` |
| `monexus-web-prod` | `ghcr.io/amo0114/monexus-web@sha256:3a80656d2c29e75d25020ebd120204095e30fcbc9ec683f1eeffcf08a36ee576` | 同上 |

本地 Git 核对：`d4c5032` 的第二父提交为 `9ac9dbd76eb198ba533743269c211eb4eb478b66`，`git diff d4c5032 9ac9dbd` 为空。二者历史不同但源码树相同，无需仅为合并提交号重建开发 worktree。这是 Git 树和镜像元数据证据，不是对线上全部运行文件的逐一校验。

生产 server 启动参数包含 `prisma migrate deploy` 与 `node dist/main.js`。因此启动新 server 即可能迁移生产数据库，不把它当作无副作用的镜像试跑。

### AstrBot / NapCat

| 项目 | 证据 |
| --- | --- |
| AstrBot | `/AstrBot/pyproject.toml` 与 `/AstrBot/astrbot/__init__.py` 均为 4.27.2 |
| AstrBot RepoDigest | `soulter/astrbot@sha256:6ff58843ffcb285da4031fb6f11a27a581c89c84eadcf2db08b4d795d45b1487` |
| NapCat | `/app/napcat/package.json` 为 4.7.78 |
| NapCat RepoDigest | `mlikiowa/napcat-docker@sha256:215a6b6a752088a9b1ffdabb22ae519be3fa9b48e13ee490da14f5be35cbf71e` |
| AstrBot Compose | `/volume1/docker/astrbot/compose.yml` 及 `compose.override.yml` |
| 持久数据 | `/volume1/docker/astrbot/data` → `/AstrBot/data` |
| 现有 MoNexus 插件 | `astrbot_plugin_monexus_checkin`，metadata 1.2.0 |
| 新适配器 | 未发现 `data/plugins/astrbot_plugin_monexus_xboard` |
| 依赖 | 通过标准库读取已安装包 metadata，httpx 为 0.28.1，符合本地约束 |

静态读取确认 `AstrBotConfig`、`Star`、`Context`、`register`、公开 `event/filter` 子包、AIOCQHTTP 枚举及所用事件方法存在；没有导入 AstrBot 或加载新插件。现有签到插件的直接命令为商品/我的积分/打卡/搜索/检查配置/确认/签到/绑定/解绑，与本包命令无直接重名；没有检查所有插件的别名、命令组或真实分发行为。

4.27.2 在本包声明的 `>=4.16,<5` 范围内，只能确认静态兼容前提。未读取 OneBot 配置或 QQ 登录状态，因此没有证明实际反向 WebSocket 和真实消息链路正常。现有 overrides 挂载须保留，不以重建 AstrBot 的方式覆盖自定义逻辑；NapCat 本次无升级必要。

## 3. 发布前准备（先完成，再进入维护窗口）

1. 冻结并审查两个 worktree 的最终差异，记录最终提交/构建身份，完成发布流程要求的检查。现有本地测试只按受影响模块补充，不重复执行全量测试；未提交代码与已有 ZIP 不是已发布版本。
2. 按 [固定构建说明](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/release/xboard-reset/README.md) 在目标主机的新目录构建；从已经核对的固定 digest 出发，不拉取浮动 `latest/new`。核对源包 SHA256 后解压。源码包是构建输入，不可直接作为 Xboard 后台插件 ZIP 上传。
3. 给该主机生成独立 release 目录和 `release.json`。本地 image ID 不能当远端 registry digest，也不能把另一主机重建的 image ID 冒充本机结果。上传/构建与后续切换另行执行，本次未操作。
4. 准备独立的 Compose override，仅给 `web` 和 `horizon` 指定同一审定镜像；保留原有卷、主题、邮件、Redis、端口与命令。不要把整份现有 compose 替换成示例。
5. 在维护前完成Xboard SQLite、MoNexus PostgreSQL、两边部署配置及FakaBridge文件的可恢复备份；SQLite须使用一致性在线备份API，或停止所有写者后取得一致快照，不在运行时只复制主文件而遗漏WAL中的已提交数据。备份含机密，限制权限并验证恢复步骤。AstrBot备份原配置/签到插件，后续新适配器状态目录也要纳入备份。备份放在插件扫描目录之外。
6. 明确维护时暂停新的桥接订单/履约的现有操作方式并处理在途任务，不在旧 worker 工作时替换 PHP 目录。配置稳定 `XBOARD_INSTANCE_ID`、client ID `monexus`、允许赠送的实际 plan ID；不从旧邮箱猜测关联。

阶段顺序：Xboard 兼容升级 → MoNexus 关闭新入口升级 → 迁移/预检 → 账号回填 → 机器人查询 → 内部免费及付费验收 → 扩大开放。不要一次性打开所有开关。

## 4. Xboard 维护窗口内操作

1. 暂停新桥接流量并核对在途状态，停止相关 web/horizon 及已清点的其他常驻消费者，保留 Redis/数据库。记录旧镜像及 Compose，便于恢复。
2. 用审定快照完整替换宿主机 `plugins/FakaBridge`，保持准确目录名；不把插件备份留在 `plugins` 内，不修改其他插件。旧文件不能在复制中与新代码混用。
3. 使用新镜像的临时 CLI 容器、现有卷和同一生产配置执行插件升级。实际核心 `App\Services\Plugin\PluginManager::update('faka_bridge')` 会禁用插件、执行 `runMigrations()`、保留已有配置并升级登记版本，然后重新启用；本地隔离测试已经覆盖此升级入口。这里会写数据库，不是只读检查。
4. 调用前须受控核对数据库登记版本及启用状态，避免 `update()` 对同版本拒绝、或把原禁用插件意外启用。若登记已经是 1.8.0 但迁移缺失，停止并调查；不得为重跑迁移伪造旧版本。不要 uninstall/reinstall，卸载路径会回滚迁移。
5. 核验新增迁移全部成功：`2026_10_25_000000_create_faka_protocol_nonces_table`、`2026_10_25_130000_create_faka_traffic_resets`、`2026_10_25_160000_add_paid_reset_identity`。确认faka_orders协议/稳定目标字段齐全、nonce表存在；免费/商业路径的User、Plan、Order、日志、FakaOrder、操作和消费表都在同一默认连接/持久main文件，WAL、synchronous至少NORMAL、query_only关闭，无额外attached或关键TEMP遮蔽。MySQL部署才使用相应InnoDB检查，本环境保留SQLite。
6. 保留原 `hmac_secret` 与 v1 配置；明确设置 `v2_read_enabled=false`、`v2_reset_enabled=false`、`v2_paid_reset_enabled=false`。复制默认 config.json 不等于改变数据库里的运行配置，禁止用默认空密钥覆盖已有配置。
7. 重建 web 与 horizon，让核心补丁和插件在新进程共同生效；不能只重启旧镜像。用目标主机自己的 release 目录执行 `xboard-reset-release.py check --web xboard-web-1 --worker xboard-horizon-1`；如另有消费者逐一核对。通过仅证明运行文件，不代替进程健康、迁移/路由及签名验收。
8. 在保持免费/付费执行关闭时启用 v2 查询，核对签名 capabilities 的 buildId、stable-ID 查询能力及迁移可用性。该业务查询会写防重放 nonce，需计入这次生产变更。再核对原 v1 路由及已有订单状态，确认原履约兼容后结束这一段维护。

## 5. MoNexus、回填与机器人查询

1. 按当前发布流程从冻结源码构建 server/web；生产目录使用新 release，不覆盖旧 `d4c5032`。保留 `docker-compose.vps.yml` 的生产覆盖项。新 Compose 必须透传新配置，仅更换镜像而继续使用旧 Compose 不会自动带入新增环境项。
2. 首次发布保持 `XBOARD_ACCOUNT_QUERY_ENABLED`、`XBOARD_PAID_RESET_TARGET_V2_ENABLED` 和全部 `TRAFFIC_RESET_*_ENABLED` 为 false；准备稳定实例/桥接配置、Redis、bot 密钥及至少32字符的独立确认密钥。两条共享密钥分属 bot 和 Xboard 链路，不互相替代，不下发 Xboard secret 到机器人。
3. 备份后应用三个增量 Prisma migration：`20261025120000_xboard_account_links`、`20261025140000_traffic_reset_benefits`、`20261025180000_paid_reset_tasks`。生产启动本身会 migrate deploy，须先核对其他待执行迁移；不使用 migrate dev、reset 或 seed。
4. 查询开关仍关闭时先运行 compiled CLI，避免把镜像不含 `src` 的环境误用开发脚本：

   ```bash
   docker exec monexus-server-prod node dist/scripts/backfillXboardAccounts.js --limit 50
   ```

   默认是预览，不写本地关联/赠送/checkpoint；远端签名请求仍写 nonce。输出按来源行计数，不是唯一用户数。首批无异常不能证明全量已完成；按返回的 `previewNext` 显式传 `--after-user-id` / `--after-task-id` 翻页，记录异常和覆盖范围。
5. 审核预览后受控 `--apply --limit 50`，按数据库 checkpoint 继续。保持查询开关关闭可避免启动时 cron 自动 apply；查询开启会立即启动回填批次，这本身会写关联，不能称为纯读取开关。先关联、后发放：grant 关闭时先恢复账号，核对后开启 grant 再逐批扫描以幂等发放一次机会；运行期间的新交付按既有唯一约束协同处理。
6. 通过 AstrBot WebUI 安装单独的 0.2.0 插件，或放入 `/volume1/docker/astrbot/data/plugins/astrbot_plugin_monexus_xboard`。保留现有 checkin 插件与持久数据，只重载新插件；无需重启 NapCat。先保持三个适配器开关全关，配置同一站点 HTTPS origin 与 BOT_SHARED_SECRET。
7. 检查新状态目录 `/volume1/docker/astrbot/data/plugin_data/astrbot_plugin_monexus_xboard` 的持久性和写权限。启用 MoNexus 查询与适配器 query，仍关闭免费和付费购买入口。由内部账号主动私聊机器人执行“我的账号”“我的套餐”“重置次数”，同时核对既有绑定/签到仍可用。

## 6. 执行灰度与验收

当前没有用户 allowlist 灰度开关。仅由内部账号发命令不等于后端只允许内部账号。严格内部灰度需采用隔离环境、受控请求入口，或先补齐双方认可的服务端 allowlist；否则必须明确同意该阶段对所有符合条件的用户具备可调用性，再开启全局执行开关。

| 阶段 | Xboard | MoNexus | AstrBot |
| --- | --- | --- | --- |
| 查询 | read 开；reset/paid 关 | query 开；grant/requests/dispatch/paid 关 | query 开；free/paid 关 |
| 发放核对 | 同上 | grant 开，按批 apply；其他写入口仍关 | 同上 |
| 免费执行 | read/reset 开、套餐白名单明确 | grant/requests/dispatch 开，确认密钥就绪 | free 开 |
| 付费入口 | read/paid 开；免费开关独立 | paid target 开，正确商品/规格已配置 | paid purchase 开 |

每一步记录验收时间、构建身份、脱敏用户引用和 operation/order 引用，不记录 QQ、完整邮箱、确认码或密钥。至少完成：

- 注册邮箱不同于 Xboard 邮箱的老用户自动恢复；多账号显式选择，不串号。
- 群聊只提示私聊，不能暴露套餐/确认码或产生业务请求；私聊显示流量与查询时间。
- 免费请求须先确认；成功仅消费一次，总流量/到期不变；重复确认、适配器重载后查询仍指向同一操作。
- 未知结果只读核对，不能把超时视为失败自动退次；取消仅凭远端终态/tombstone 处理。
- 购买链接选中本套餐 reset Offer 和本人 accountLinkId；本人网站正常支付/履约，付费不再次赠送也不扣免费机会。旧 v1 重试保持 v1。
- 次数分免费余额、免费/付费 v2 已核实执行及全来源，旧 v1/站外覆盖限制明确。

故障注入留在隔离环境；不为测超时而中断生产数据库或 QQ。真实流量重置和付费验收分别需要明确的自有测试账号及可接受的实际消费。性能验收另按 P0 的游客/登录冷启动、返回列表及滚动场景测量，本次文件检查不能证明线上 LCP/INP 达标。

## 7. 停止开放与回退

先关新 requests、grant、网站 paid target 和机器人 free/paid 入口；按需关 dispatch。保留 worker、稳定实例/origin/client 和桥接依赖，继续已有免费/付费任务状态核对及必要的远端取消。插件关执行 gate 后保留 status/cancel/revoke 能力，不能禁用整个桥接来代替安全停止新功能。

尚无新操作/商业任务时，才可评估共同恢复旧镜像与旧插件文件。已有未知或未结清 v2 任务后，不直接回退到缺少这些 worker/协议的旧应用；应使用能继续对账的修复版本。回退不卸载插件、不回滚删表、不清空消费/操作/tombstone，不通过恢复旧数据库备份抹去新消费。数据库恢复仅用于经过单独裁决的灾难恢复。

## 8. 本轮未实证的条件

Xboard数据库登记版本/启用状态、现有核心表/字段及缺失新增迁移已只读实证；运行配置开关、Prisma迁移、备份可恢复性、历史归属证明覆盖率、端到端签名/反代、所有常驻消费者、真实QQ会话与内部执行范围仍待实证。当前本地Xboard发布产物改用实施记录第十三批的SQLite快照，第十一批旧清单不与新补丁混用；本文件不把“文件兼容”升级为“已上线验收”。
