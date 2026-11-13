# 运行时配置发布验收

核验日期：2026-11-13。代码分支：`feat/admin-runtime-settings`。
本清单记录可复现步骤及证据边界，不代表生产发布批准。

## 代码基线

- 基线固定为 `2ac1c7c885f04703c0a3dd07eba66d7090166b94`，包含 #353、#354、#356。
- 最后一次基线推进为 #355 的合并提交；相对 `5afed9a` 没有文件内容变化。
- 原实现 HEAD `402b7d7` 是该基线的祖先。16 个上游提交与运行时配置改动路径交集为零；已在独立 worktree 完成变基。
- 原工作区 `/root/projects/MoNexus-new` 的未提交内容不纳入此分支。
- 发布前重新检查 `origin/develop`；如继续前进，核对差异并重跑受影响验证。
- OpenAPI 默认 diff 算法会放大新增 schema 导致的行匹配变化，可用
  `git diff --histogram origin/develop -- docs/superpowers/specs/monexus-api-openapi.json` 审查。

## 自动化证据

- [x] 现有 PostgreSQL 全量迁移可应用于空库。
- [x] 支付基础表从历史 schema 升级；回放列表包含本批新增依赖迁移。
- [x] 带旧履约任务、ready 短链、支付报价/订单/attempt/event/对账批次的数据库升级：原行除新增字段外完全一致，新增绑定为 null，配置表初始为空，并发索引有效。
- [x] 两个持续运行的独立 Node 进程共用数据库：一个通过管理服务激活 PayPal A/B、停收、回滚，另一个无需重启读取新版本，已固定的 A 版本仍可解析。仅本地凭据校验，无外部交易。
- [x] 根密钥轮换、短链历史/进行中请求、履约开通/撤销/对账、支付迟到回调/重复事件/未知创建/退款有受控 fixture 回归，详见运行说明中的验收记录。
- [x] 同步基线后的前后端构建、前端 71 项回归、架构/OpenAPI、Compose 环境覆盖、迁移安全检查通过。
- [ ] 推送后精确 feature SHA 的 GitHub `CI OK` 通过，关键旅程 PR 带 `run-e2e` 标签。

## 受保护预发布

已只读确认默认分支为 `develop`，该分支存在 active 的 `Staging Compose Deploy`。
staging Environment 配有 reviewer；SSH 五个配置名称及 healthcheck 变量名称存在。
仅名称已验证，secret 值、SSH 连接、主机根密钥和服务健康尚未验证。
工作流的 release job 包括 dry-run 也引用 staging Environment，可能等待人工审批。

先推送 feature SHA，再从默认分支工作流发起精确 SHA 的预演：

```bash
runtime_sha=$(git rev-parse HEAD)
gh workflow run staging-deploy.yml --ref develop \
  -f ref="$runtime_sha" -f release_action=deploy -f dry_run=true
```

预演只验证不可变源码归档和发布计划，不连接 SSH，不证明 CI、迁移、主机配置或第三方可用。
后续 live staging 发布必须通过现有 Environment 审批，不修改保护规则或改走非受保护 SSH。

- [ ] 归档和预演均绑定最终 feature SHA；保存 Actions 链接与结论。
- [ ] `CI OK` 通过后，经 staging Environment 审批，用相同 SHA、`dry_run=false` 部署。
- [ ] 严格 staging preflight、容器迁移、loopback smoke、公网 readiness 均通过。
- [ ] 主机使用独立 staging 根密钥、数据库、Redis、桶及 Mailpit，无生产凭据或数据。
- [ ] 在 staging 完成管理员 MFA、保存/测试/激活/停用/回滚；验证数据库接管后无环境静默回退。
- [ ] 新旧集成根密钥同时部署，重包草稿和全部保留历史版本；确认可解密后移除 previous。
- [ ] 独立备份数据库与根密钥，并在隔离恢复目标还原；缺少对应根密钥时应安全失败。

## 第三方与正式上线

- [ ] 短链登录成功后，再用受控商品验证创建权限与分组。
- [ ] staging 履约 A/B 切换后核对旧任务开通、查询、撤销继续使用 A；核实 legacy 目标后才确认迁移。
- [ ] 在商户后台登记账号专用回调并保留旧账号回调；沙箱/受控交易验证回调、入账、查询和退款。
- [ ] 非 Stripe 渠道的本地校验不作为凭据归属、网络或完整业务流程验收证据。
- [ ] 历史 null-binding 支付记录继续保留原环境 adapter 和凭据；每账号最多 8 个保留凭据版本。
- [ ] 正式发布按邮件/通知、短链、履约、支付顺序逐项接管；生产走现有 master 发布及 Environment 审批。

运行时配置细节及恢复方式见[运行说明](./runtime-settings.md)。
