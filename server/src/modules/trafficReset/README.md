# 一次赠送流量重置（B2）

本模块实现 `welcome_traffic_reset_v1`：每个 MoNexus 用户终身一次，多个 Xboard 账号共享；免费重置独立于商业订单，不扣积分、不延长到期时间、不增加总流量。按已验证购买证据及稳定 Xboard 用户 ID 定位，注册邮箱无需与 Xboard 邮箱一致。当前只完成本地两端代码及隔离验证，尚未接入真实 AstrBot 会话或部署。

## 发放与资格

`benefits.ts` 在直接成功交付、对账成功交付的原事务内 upsert 权益；数据库失败会使交付、冻结积分扣款及权益共同回滚。历史 B1 回填的 apply 分支共用此 helper。查询只刷新已有权益，不隐式发放。

来源须为成功、有 trade/完成时间、有效交付、正常用户的基础套餐购买，周期为 monthly/quarterly/half_yearly/yearly/two_yearly/three_yearly/onetime；重置包、退款/争议、取消/撤销不可作为当前资格。稳定关联未就绪时创建 pending_verification，available=0；后续回填完成后才可用。已有可信关联证据不因站内邮箱变化丢失。

退款/争议/重新处理时刷新来源；有其他合格购买就换来源，否则撤销未用资格并请求取消未完成操作。已消费记录不删除，重新购买/换绑不会再赠送。远端报告活动已经消费会永久封住本地该权益，普通刷新不能重新激活。

## 确认和执行

- `intents.ts`：使用专用 HMAC 密钥派生 6 位 Base32 确认码，120 秒有效，数据库只存 tokenHash/keyId，最多 5 次错误。意图冻结账号、原 QQ 绑定、实例、套餐和订阅指纹；默认账号后来改变不改旧意图。
- 确认按 User → ChatBinding → Grant → Intent 锁序，预占一次并创建独立 operation。intent 唯一、用户/requestId 唯一；成功重放时的新 requestId 也持久化映射，之后不能挪给别的意图。数据库 CHECK 保证 reserved+consumed<=1。
- `worker.ts` 按 Grant → Operation 锁序认领 90 秒租约，token 防旧 worker 回写，HTTP 在事务外；实际派发前再查绑定、用户、关联、来源和开关。固定 operationId/远端 ID/clientId/origin，配置改指不会重投到新站点。
- cron 每 5 秒一批最多 20，首次派发记 attempts，恢复先查原 operation。5/30/60 秒退避，自动执行最多 3 次，之后继续查状态等待核对。
- 远端确认 succeeded 才 reserved−1、consumed+1；明确 failed/cancelled 才只释放预占。超时、5xx、not_found 都保持 needs_reconcile 和预占。放弃必须获得同 operation 的远端取消 tombstone，不能直接改次数。
- 成功后清除 worker 所在进程的账号流量缓存；旧在途响应不能回填缓存。其他进程仍可能在现有 15 秒缓存窗口内显示旧快照，写资格始终走新预检；尚无跨进程即时失效广播。

QQ 接口复用原始字节签名、可信 QQ sender 绑定、Redis nonce 和 no-store。新增 POST `reset-intents`、`resets`、`reset-status`；确认返回 202，包括重放，202 不表示远端已成功。未绑定为 200 `{bound:false}`。当前共享绑定用户 10 次/分钟，尚无独立意图 3 次/分钟桶。DTO 和错误以仓库 OpenAPI 为准。

`profile.freeReset` 是已发放的真实余额，无 grant 为 null；`freeSuccessfulForAccount` 仅为当前账号免费 v2 成功次数。B3b4 新增 `paidSuccessfulForAccount`，复验完整商业证据后统计付费 v2，`platformSuccessfulForAccount` 为两者之和、`coverageScope=verified_v2_only`；执行后退款仍计，旧版付费/站外未覆盖，超过1000条付费任务时 truncated=true、显示下限；Xboard 原生 reset_count 单独展示，不能混成免费/付费次数。

## 配置与发布顺序

所有新开关默认 false，生产 Compose 已透传。查询需桥接 URL/密钥、BOT_SHARED_SECRET、Redis 和固定 XBOARD_INSTANCE_ID。实例首次落库后不得改指 origin；client ID 两端一致，默认 monexus，投入使用后不可更换以绕过活动唯一性。

| 配置 | 作用 |
| --- | --- |
| TRAFFIC_RESET_GRANT_ENABLED | 新交付及历史 apply 发放；关闭不删除已有 grant |
| TRAFFIC_RESET_REQUESTS_ENABLED | 创建新意图/新确认操作；依赖查询开启及专用确认密钥至少 32 字符 |
| TRAFFIC_RESET_DISPATCH_ENABLED | 新远端执行；关闭后已尝试操作继续查状态，可继续远端取消 |
| TRAFFIC_RESET_CONFIRM_SECRET | 专用服务端确认密钥，不下发机器人 |
| TRAFFIC_RESET_PREVIOUS_CONFIRM_SECRET | 轮换期间保留旧密钥，至少覆盖旧意图有效期 |
| TRAFFIC_RESET_CLIENT_ID | 固定客户端作用域，须与插件 v2_client_id 相同 |

先核对实际Xboard digest，并按插件 [重置契约](https://github.com/amo0114/Mo-lab/blob/feat/qq-xboard-v2-read-20261025/docs/fakabridge-v2-reset-contract.md) 构建经过校验的核心适配；普通未补丁镜像不会宣告执行能力。第十三批已按现用SQLite/WAL补齐执行适配：同一文件型main/连接、synchronous至少NORMAL、无attached/关键TEMP遮蔽；MySQL仍要求相关表InnoDB。应用nonce/重置/商业迁移，web/horizon使用同构建及同一持久数据库文件。MoNexus应用B1/B2增量迁移，先预览再受控apply回填，随后开放查询及受控执行。生产历史恢复覆盖、完整Xboard联调及真实QQ仍待验收。

暂停新功能时先关 requests、grant，再按需关 dispatch；保留桥接依赖和 worker 做已有操作对账，不能回滚到没有 reset worker 的版本后放任未知操作。插件关闭 v2_reset_enabled 后 status/cancel 仍可用（依赖认证、nonce 和事务表），不要删除幂等/消费记录。应用回退不执行删表迁移。

## 对账及取消

从仓库根运行；数据库及桥接环境由操作者明确选择。默认仅读取本地状态，输出不含邮箱、QQ 或远端原文。

```bash
npm --prefix server run traffic-reset:reconcile -- --operation <UUID>
npm --prefix server run traffic-reset:reconcile -- --operation <UUID> --apply
npm --prefix server run traffic-reset:reconcile -- --operation <UUID> --apply --cancel --admin-user-id <ID> --reason '人工核验后的取消理由'
```

取消要求正常 admin 和 8–200 字符理由，AdminLog 与 cancelRequested 同事务。CLI 不绕过当前租约或执行开关，不提供次数加一。查询 not_found 后取消仍可能返回 succeeded，必须按真实远端终态记账。开关关闭但曾派发的操作仍可对账；从未派发且未取消的 queued 会继续等待 dispatch 开启。

## 验证与限制

定向文件：traffic-reset.test.ts、traffic-reset-client.test.ts、xboard-bot-v2.test.ts、config-xboard-guards.test.ts、faka-bridge-worker.test.ts、faka-bridge-lifecycle.test.ts；使用可丢弃 PostgreSQL，远端/Redis 为可控替身。PHP 真实框架/native adapter 和 MySQL 并发见插件契约。没有全量测试、生产写入或部署。

B3a/B3b 的 AstrBot 命令、私聊/群聊边界、稳定 ID 付费分支及有覆盖范围的次数已本地实现；仍需真实会话灰度、部署一致核对，观测指标/告警也尚未补齐。现阶段不能宣布完整功能可上线。


B3a 补充：已有可安装的 AstrBot 适配器及纯只读 reset-intent-status，通过本人原 binding 的 intentId 找回确认响应丢失的 operation；未观察到时 operation=null，不能释放预占。新请求关闭后仍可读，具体契约及安装见方案 protocol-v2 第 8 节。B3b1–B3b4 付费分支也已本地接通，仍未部署/真实 QQ 验收。
