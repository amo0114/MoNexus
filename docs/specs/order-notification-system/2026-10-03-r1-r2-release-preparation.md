# R1/R2 提交与发布准备

日期：2026-10-03。范围：通知修复 R1 身份与会话隔离、R2 公告完整性。

## 状态与授权边界

Status: implementation-started。当前阶段：提交候选整理及本地发布准备。

- 实施分支：`fix/notification-remediation-r1-r2`。
- 实施 worktree：`/root/projects/MoNexus-notification-remediation-r1-r2`。
- 已审查基线：`e4f1f7d84659b271f596559620ac68b2421e573e`。
- 本次提交：尚未创建；暂存区仍为空。
- 发布集成分支：尚未创建；未 push、开 PR、合并或发布。
- 已完成独立代码复审、前端回归、真实 Chromium 双 Tab 回归及 PostgreSQL 16 服务端集成/并发验证。
- 生产版本、远端最新基线、远端 CI、镜像 digest、部署开关及 staging 凭据尚未现场核对。

**本文件不授权生产操作。** 后续 commit、push、移植到发布基线、PR、合并、workflow dispatch 和生产部署各需明确授权。原 worktree 的邮件模板、Xboard 支付桥接、历史支付修正不属于本次提交，R3-R6也未实施。

## 候选提交和范围

### 原子提交建议

建议将已经复审的 R1/R2、对应长期测试、隔离测试入口及本文作为一个完整提交。不要提交中间版本：前端 store/API 调用与后端版本/会话校验有共同契约，拆出不可运行的中间状态不利于回滚。

候选提交标题：

```text
fix(notifications): isolate session completion and version announcement receipts
```

候选提交说明：

```text
Prevent stale or cross-tab authentication work from changing another session,
and record announcement receipts only for the version actually displayed.
Preserve PostgreSQL concurrency and browser regression gates for the rollout.
```

标题遵循已有 `fix(scope):` 风格，不使用 skip-ci，不跳过 hooks，不包含 env、密钥、测试输出或构建产物。

### 分支祖先不是本次范围

本地保存的 `origin/develop` 是 `9473a96a2c5f254a3d38811860c6a27b1257fc2a`，`origin/master` 是 `21828f029a2ca9d529248db7eb4b4c29ed254147`。这些是本地 ref 快照，不是本轮 fetch 后的远端事实。

相对该 develop 快照，本分支已有4个通知修复之外的祖先提交：

- `b1b2b0d`：导航品牌收敛动画。
- `2cdac3e`：商城布局优化。
- `8b3a242`：详情页布局优化。
- `e4f1f7d`：多规格商品审查修正。

不得将本分支直接合并到 develop/master 并称为“只发布通知”。获得授权后，刷新远端基线，在独立的干净集成分支上仅移植本次最终提交；审查冲突及完整合并差异并重新验证。若目标分支已经包含这些祖先，先用 merge-base/日志确认，而非猜测。

### 文件白名单

只提交以下候选文件。实际提交前重新核对diff及未跟踪文件；若出现清单外改动，停止并确认来源。不得使用未核对的全目录 `git add .`。

```text
docs/specs/order-notification-system/2026-10-03-r1-r2-release-preparation.md
e2e/auth-session-completion.spec.ts
playwright.auth-session-completion.config.ts
scripts/verify-notification-remediation-db.mjs
server/src/__tests__/announcements.test.ts
server/src/__tests__/auth-mfa.test.ts
server/src/__tests__/auth-sessions.test.ts
server/src/__tests__/auth.test.ts
server/src/__tests__/notification-remediation-concurrency.test.ts
server/src/lib/httpError.ts
server/src/modules/announcements/controller.ts
server/src/modules/announcements/routes.ts
server/src/modules/announcements/schema.ts
server/src/modules/announcements/service.ts
server/src/modules/auth/README.md
server/src/modules/auth/controller.ts
server/src/modules/auth/routes.ts
server/src/modules/auth/schema.ts
server/src/modules/auth/service.ts
server/src/modules/auth/sessionService.ts
src/App.tsx
src/api/announcements.ts
src/api/auth.test.ts
src/api/auth.ts
src/api/authCookieLock.ts
src/api/authRefresh.test.ts
src/api/authRefresh.ts
src/api/client.ts
src/auth/pendingAuthSession.ts
src/auth/sessionContext.test.ts
src/auth/sessionContext.ts
src/auth/sessionStorageSync.test.ts
src/auth/sessionStorageSync.ts
src/components/AnnouncementCenter.tsx
src/components/Layout.tsx
src/components/NotificationRealtimeBridge.tsx
src/components/OrderDetailModal.tsx
src/components/admin/PortableBackupPanel.tsx
src/components/auth/MfaEnrollment.tsx
src/components/auth/MfaVerification.tsx
src/components/profile/ProfileIdentityCard.test.tsx
src/components/profile/ProfileIdentityCard.tsx
src/hooks/useAnnouncements.test.tsx
src/hooks/useAnnouncements.ts
src/pages/LoginPage.tsx
src/pages/MerchantApplyPage.tsx
src/pages/ProductDetailPage.tsx
src/pages/ProfilePage.tsx
src/pages/RechargePage.test.tsx
src/pages/StorePage.test.tsx
src/pages/VerifyEmailPage.tsx
src/pages/recharge/RechargeResult.tsx
src/realtime/announcementSyncBroadcast.ts
src/realtime/notificationStream.ts
src/stores/appStore.ts
src/stores/authStore.test.ts
src/stores/authStore.ts
```

本次delta没有 Prisma schema/migration、依赖或lockfile、CI工作流变更。若集成到新基线后的完整release另有migration，必须另外审查；不能用本次“无migration”替整个release作保证。

## 验证证据与复跑

### 本地证据

- 独立复审：此前5项和会话完成P1已修正；最终业务diff无新增可行动发现。
- 前端全量：132文件/1136测试通过，使用串行worker；这是前一轮对当前业务实现的独立结果，提交准备只调整测试及文档，没有修改业务实现。
- 数据库验证已迁入仓库：PostgreSQL 16.15 上12文件/119测试通过，其中10项为真实锁等待并发验证；迁移、容器清理和退出码检查通过。
- 119测试包括认证21、会话11、MFA14、公告15、token18、MFA crypto9、registration flow10、active-user3、identity-foundation3、security-events3、JWT errors2、并发10。
- 前后端 production build均由本轮重新执行通过；后端包含postbuild registry import检查。
- 默认Playwright配置已能收集本次双Tab的2项测试。Cookie断言使用页面origin，不再依赖5191。
- 最终双Tab回归：专用5191配置 `--repeat-each=2`，两场景共4次全部通过、exit0；另在临时5192配置运行两场景均通过、exit0。后者验证非5191 origin，不宣称已执行远端CI整套E2E。
- 打包保留Browserslist数据陈旧、chunk大小及混合dynamic/static import提示；构建成功，但未在本轮进行性能预算认证。
- `git diff --check`通过；没有测试指向开发库或生产库。

数据库并发证据：旧版本read/acknowledge等待更新commit后409且零回执；archive/expiry commit后404；四路acknowledge只一条回执且首时间一致；read/acknowledge竞争不覆盖确认；同用户不同sid/跨用户的错配refresh/logout不影响正常并发旋转、不写Cookie、不误触发全局replay。

浏览器复跑遇到过一次失败：第二Tab尚在冷启动 `page.goto()`，测试仅等待200ms就释放第一Tab并开始5秒后续断言。已改为预加载两个登录页，并通过 `navigator.locks.query()` 确认第二请求真实排队，不增加timeout、不使用自动retry掩盖。随后5191四次及5192两次全部通过；这个更改只改善测试同步，没有改业务锁逻辑。

### 可复跑入口

在项目根目录，使用Node20/npm10；已安装根及server依赖、Prisma client、Chromium及本机Docker。数据库脚本要求本地unix Docker context及缓存的 `postgres:16`，不会自动拉镜像、接收外部DATABASE_URL或读取项目env。

```bash
node scripts/verify-notification-remediation-db.mjs
npm test -- --maxWorkers=1
npx playwright test --config playwright.auth-session-completion.config.ts
npx playwright test --config playwright.auth-session-completion.config.ts --repeat-each=2
npx playwright test --list --config playwright.config.ts e2e/auth-session-completion.spec.ts
npm run build
npm --prefix server run build
git diff --check
```

数据库脚本创建随机一次性容器、随机凭据、回环随机端口、512MiB tmpfs；执行现有migration与指定12个suite，再移除容器并检查不存在。schema setup执行TRUNCATE，但只能作用于脚本生成的TEST_DATABASE_URL；Redis关闭、SMTP未配置、支付关闭。不要在生产主机执行测试。

上述脚本不是CI的替代：现有backend job使用PostgreSQL16独立service，并通过 `src/**/*.test.ts` 自动收集新并发文件。双Tab使用真实Chromium和Web Locks，API/JWT/Cookie由fixture模拟，不等同于真实后端浏览器E2E。

### 中断和重复执行

正常成功/失败均自动清理。强制杀进程可能阻止finally运行；若发生中断，先只读列出任务标签容器，再核对本次随机name后单独清理，禁止广泛docker prune或删除其他项目容器。脚本不会接管已有容器，不会删除宿主机数据库。

## 接口兼容与部署顺序

### 三项可见契约变化

1. `/api/auth/refresh`：body可选 `expectedSessionId`；若提供且错配，409 SESSION_CHANGED，不旋转/设置Cookie。旧refresh仍能正常使用，但不具有新客户端归属保护。
2. `/api/auth/logout`：必须提供 `expectedSessionId`；缺失或错配返回409，不能为旧A界面清除B的Cookie。旧网页本地退出不等于服务端家族已撤销，必须刷新后使用新版退出。
3. `/api/announcements/:id/read|acknowledge`：body包含所见 `version`；缺失409 ANNOUNCEMENT_VERSION_REQUIRED，错版409 ANNOUNCEMENT_VERSION_CHANGED；不可见404，不需要确认400。禁止为兼容旧页自动确认最新版。

不存在通知表/回执的历史数据迁移；已存在回执保留，不批量删除/重发；安全邮件、资金流水和交付信息不进入本次改动。

### 版本组合和顺序

- 新前端+旧后端：旧后端会忽略新参数或仍盲写新回执，不能视为正确安全组合，不先发布前端。
- 旧前端+新后端：短期旧logout/read/ack会返回409；需要重新加载。不能因减少409而恢复盲确认或无归属logout。
- 新前端+新后端：正式支持组合；后端就绪后尽快切换对应静态资源。

使用现有发布工具的完整immutable release：先验证API健康和后端版本，再开放对应新前端资源；不要人工长时间混搭两个镜像。SPA入口缓存策略应让刷新拿到新index，带hash的旧资源不得突然删除以免旧Tab加载失败。保持 JWT/MFA 密钥、Cookie域/安全属性和已有会话表不变。

## CI、预发布与生产闸门

### 提交与CI

- [ ] owner明确授权创建候选commit。
- [ ] 白名单、秘密扫描、完整staged diff及hooks复核；当前尚未暂存。
- [ ] owner授权push/移植后，基于最新develop构造仅包含本提交的PR候选；冲突后重新测试。
- [ ] PR开启 `run-e2e`：本次触及认证横切面，按项目testing-policy应合并前执行完整E2E。新增e2e路径目前也会自动触发。
- [ ] 最新候选SHA的 backend 3 shards、frontend、默认E2E、notification realtime、catalog ops、deployment contract及聚合CI OK都完成；本地119项不是全量backend shards证据。
- [ ] 最终release PR到master再次通过完整CI。

### Staging与生产前置

- [ ] owner授权staging dry-run；使用仓库现有 `staging-deploy.yml`，默认dry_run=true，不猜测环境凭据。
- [ ] staging部署固定完整SHA，完成真实API浏览器登录/MFA/refresh/logout/公告更新冲突冒烟。
- [ ] 记录旧/新server与web镜像digest、build-info commit、待发布完整变更、备份位置和实际可用回滚目标。
- [ ] 只读检查当前生产版本和配置；此前看到的生产版本不能当今天的事实。SSH临时私钥已清理，如需人工访问须重新授权和生成，不复用旧授权。
- [ ] 核对 `COMPOSE_PRODUCTION_AUTO_DEPLOY_ENABLED`、protected environment及其他现有自动deploy入口。push master可能触发镜像发布及自动部署，未核对前不可视为“只push不发布”。
- [ ] 获得生产发布明确授权后，走 `compose-production-deploy.yml`：master可达完整SHA、同SHA的CI与Publish Docker images gate、先dry_run=true，确认后才实际deploy。
- [ ] 同SHA镜像到位后复核release清单，不使用latest或混合镜像；本次不改SSE功能开关、不改支付/SMTP参数。

没有完成以上步骤就不称为生产就绪。当前未调用GitHub API、dispatch工作流或SSH；本地保存ref可能落后，PR草案不是已创建PR。

## 冒烟与回滚

### 必测冒烟

- 普通账号登录、刷新、登出；错误密码不会触发refresh/replay。
- 同一浏览器A/B两Tab、延迟/me、已有会话token轮换、旧页面响应不写新身份。
- 管理员MFA、恢复码保存等待及新Tab替换归属；不记录/截取真实恢复码或TOTP密钥。
- 退出/换账号后铃铛、待显示Toast和角色公告立即隔离。
- 查看公告v1后后台发布v2，旧确认409且不生成v2回执；重新阅读v2后正常确认。
- 回前台、中心打开、跨Tab确认、到期校准；通知功能/realtime开关不因本次发布被改变。
- 真实业务流不因通知变更改变积分、订单或退款结果；生产上不得为冒烟创建真实交易，使用批准的安全账号/环境。

### 失败分流

提交前测试失败：停止提交并记录失败，不能删除失败测试、放宽断言、skip hook或笼统归为机器抖动。CI/staging失败：停在候选发布阶段。生产异常：停止扩量，记录release/version和脱敏request-id，由owner批准切换或hotfix。

### 回滚边界

- 回执和RefreshToken历史行保留；不回滚数据库、清空公告回执或批量注销会话。
- 优先切到已验证的、包含同等身份/版本守卫的镜像对。若无这样的回滚版本，明确说明回到旧版本会重引入已知P1；不能把它描述成无风险自动回滚。
- 旧前端与新后端混搭会造成logout/公告409；旧后端与新前端混搭会失去守卫，不是有效恢复。
- 本次无新schema需降级。新pending marker仅身份tuple，无凭据；不要以全站清localStorage方式消除问题或抹掉另一Tab登录。
- 连接问题可按既有策略降级，但R3兜底缺陷尚在后续范围，不能声称本次已经修复所有实时故障。

## PR 描述草案

标题建议：`fix(notifications): isolate browser sessions and acknowledge displayed announcement versions`。

### Summary

- Bind auth refresh/replay, Cookie transitions and login completion to user/sid/epoch ownership, with a fenced pending MFA completion flow.
- Validate displayed announcement versions under database lock; isolate role/session caches and refresh receipt state without stale GET rollback.
- Keep real PostgreSQL concurrency and Chromium dual-tab regression checks reproducible, without changing funds, mail templates, schema or notification delivery architecture.

### Test plan

- [x] Independent code review and frontend 132-file/1136-test regression evidence.
- [x] PostgreSQL16 repository verifier: 12 files/119 tests including 10 lock-wait concurrency checks; disposable container removed.
- [x] Frontend and backend builds including postbuild registry import.
- [x] Default Playwright test discovery includes the new dual-tab spec.
- [x] Final portable dual-tab regression: two cases repeated twice at 5191 (4 passes), plus both cases at alternate origin 5192 (2 passes); no automatic retries or timeout increase.
- [ ] CI and staging on the actual integrated commit SHA.
- [ ] Protected production gate/dry-run and owner deployment approval.

### Rollout notes

No R1/R2 migration. Backend first, then matching frontend; old clients must reload for versioned receipts and session-bound logout. Existing UI ancestor commits are not part of this PR: transplant only the final remediation commit to the approved integration baseline and rerun gates.
