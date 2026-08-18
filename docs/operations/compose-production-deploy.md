# 受审批的 Compose 生产部署

> 状态：仓库实现已就绪；首次启用仍须完成 VPS 引导、GitHub Environment 配置和一次手动演练。

该流程面向当前的 Docker Compose VPS。它取代人工登录后 `git pull`、编辑
`.env`、拉镜像和重启容器的日常发布方式，但不会取代数据库备份/恢复演练，也
不会自动回滚数据库迁移。

## 发布路径

```text
master push
  ├─ CI（同一完整 SHA）成功
  ├─ Publish Docker images（同一完整 SHA、amd64 + arm64）成功
  └─ Compose Production Deploy
       ├─ 仅在 COMPOSE_PRODUCTION_AUTO_DEPLOY_ENABLED=true 时继续
       ├─ GitHub production Environment 等待人工审批
       ├─ 固定主机密钥 SSH → 受限 monexus-deploy 身份
       ├─ VPS 仅接受 deploy <40 位 SHA>
       └─ 镜像/迁移/应用健康/私网监控/公网 ready 全部通过才成功
```

`workflow_run` 文件由 GitHub 从默认分支 `develop` 读取。因此，工作流必须先
合入 `develop`，再通过 release PR 进入 `master`；只把它放在 `master` 不会触发
自动部署。

## 安全边界

- GitHub Actions 不读取、上传或覆盖 VPS 的生产 `.env`、数据库凭据或备份密钥。
- VPS 使用一个锁定的 `monexus-deploy` 用户；它不属于 `docker` 组，SSH 公钥带有
  forced command、`restrict` 和 `no-pty`。
- `monexus-deploy` 的 home 与 `authorized_keys` 都由 root 管理，安装器每次只保留
  当前这一把受限部署公钥，因此重复安装安全且密钥轮换不会遗留旧授权。
- 为兼容 SSHD 以该账号读取 `authorized_keys` 的实现，`.ssh` 仅向该账号组开放
  穿越权限、`authorized_keys` 仅开放读取权限；两者仍由 root 所有，部署账号没有
  任何写入权限。
- 该用户通过精确 sudoers 规则只能调用 root 所有的
  `/usr/local/sbin/monexus-compose-deploy`。
- 入口只接受 `dry-run <40 位 SHA>` 或 `deploy <40 位 SHA>`，并再次验证 SHA 是
  `origin/master` 历史中的提交、镜像标签和 OCI revision label 一致。
- 默认沿用 `docker-compose.prod.yml` 的 `WEB_PORT` 暴露方式，不会首次自动发布时
  擅自把已公开的容器端口改成 loopback。只有在宿主 Caddy/OpenResty/Nginx 已代理
  `127.0.0.1:${WEB_PORT}` 后，才可在 VPS `.env` 显式设置
  `MONEXUS_USE_VPS_PROXY_OVERLAY=true` 启用 `docker-compose.vps.yml`。
- CI 使用预置的 `DEPLOY_SSH_KNOWN_HOSTS`；严禁在 GitHub Actions 中使用
  `ssh-keyscan` 临时信任服务器。
- 部署只重建 `server`，确认 Prisma 迁移和健康后再重建 `web`，随后重建私网
  `alertmanager` 与 `prometheus` 并验证 scrape target/rules；不会重建 PostgreSQL、
  Redis、MinIO 或移除 Compose orphan。监控服务不发布宿主端口。
- `METRICS_TOKEN` 与 `SMTP_PASS` 从 root-owned VPS `.env` 原子写入
  `/opt/monexus-monitoring/secrets`，目录为 `0700`，Compose 只把对应文件挂入
  各自消费者。不得用 `docker compose config`、`docker inspect` 或日志打印密码。
- Alertmanager 的非机密路由配置由同一 root-owned 入口原子生成到
  `/opt/monexus-monitoring/config/alertmanager.yml`；生产预检先限制所有插值字段，
  密码始终只通过 `smtp_auth_password_file` 读取。

## 首次引导

在已评审、已进入 `master` 的仓库版本上完成以下步骤。首次引导需一个独立的临时
root 访问方式；引导结束后应立即移除它，日常工作流不得使用 root SSH。

1. 为 GitHub Actions 生成专用 ED25519 密钥。私钥只保存到 GitHub `production`
   Environment secret；公钥作为安装器的唯一参数。
2. 在 VPS 上以 root 运行：

   ```bash
   cd <reviewed-monexus-checkout>
   sudo bash deploy/vps/install-compose-production-deploy.sh /secure/path/monexus-deploy.pub
   ```

   安装器创建受限账号、root 所有的部署入口和 wrapper、精确 sudoers 规则，以及
   `/opt/monexus-releases` 与 `/opt/monexus-deployments`。不要把部署账号加入
   `docker` 组。
3. 通过可信控制台取得 SSH ED25519 主机公钥，核对 SHA-256 指纹后，构造一个固定
   `known_hosts` 条目。例如非默认端口应采用：

   ```text
   [host.example]:2222 ssh-ed25519 AAAA...
   ```

4. 在 GitHub 创建/配置 `production` Environment，并设置至少一名 required
   reviewer。将以下值仅放进该 Environment：

   | 名称 | 类型 |
   |---|---|
   | `DEPLOY_SSH_HOST` | Secret |
   | `DEPLOY_SSH_USER` (`monexus-deploy`) | Secret |
   | `DEPLOY_SSH_PRIVATE_KEY` | Secret |
   | `DEPLOY_SSH_KNOWN_HOSTS` | Secret |
   | `DEPLOY_SSH_PORT` | Variable |
   | `PRODUCTION_HEALTHCHECK_URL`（HTTPS `/api/health/ready`） | Variable |

5. 保持仓库变量 `COMPOSE_PRODUCTION_AUTO_DEPLOY_ENABLED` 缺失或为 `false`。这样即使
   `master` 有新提交，工作流也只会安全地跳过自动部署。

VPS `/opt/monexus/.env` 还必须有一个有效的 `ALERT_EMAIL_TO`，并保留现有生产
`SMTP_HOST/PORT/SECURE/USER/PASS/FROM` 与 `METRICS_TOKEN`。收件地址不是 GitHub
deploy secret；SMTP 密码与 metrics token 仍不得离开 VPS。

## 演练与启用

1. Actions → **Compose Production Deploy** → Run workflow，选择 `master`，保持
   `dry_run=true`。它只验证同一 SHA 的 CI、Docker publish 和双架构 manifest，
   不进入 production Environment、不会 SSH。
2. 在维护窗口再运行一次，选择同一完整 SHA，设为 `dry_run=false`。审批后工作流
   调用受限入口；入口会保存 root-only `.env` 备份及非机密部署状态，并执行内网
   健康检查，Actions 随后验证公网 ready。
3. 运行 **Production Monitoring Rehearsal**，选择 `value-policy-p0`，输入精确确认
   文本 `REHEARSE_VALUE_POLICY_EMAIL_PRODUCTION`。确认 Actions 报告 firing/resolved
   两次 SMTP acceptance，并在 `ALERT_EMAIL_TO` 邮箱确认两封邮件。
4. 确认 Actions 摘要、VPS 状态文件、迁移、监控演练和公网健康检查均正常后，设置仓库变量：

   ```text
   COMPOSE_PRODUCTION_AUTO_DEPLOY_ENABLED=true
   ```

   之后每个成功的 `master` 镜像发布都会自动生成一个**等待 production 审批**的部署。
   不要移除 required reviewer，除非明确接受无人工闸门的风险。

## 回退与密钥轮换

自动部署不会自动回退，因为 Prisma 迁移未必可逆。需要回退时，在手动工作流输入
一个已验证、仍可从 `master` 到达的旧完整 SHA，先 dry-run，再经 production 审批
部署；先阅读 [rollback runbook](./rollback-runbook.md)。

轮换密钥时，先使用第二把经过审查的临时引导密钥更新 `monexus-deploy` 的公钥和
GitHub Environment secret，执行 dry-run，最后删除旧公钥。不要旋转或暴露 VPS
上的 `.env` 中任何应用机密。

## 本地检查

```bash
npm run verify:compose-production-deploy
```

此检查只验证 Bash 语法、YAML 可解析性、forced-command 拒绝非法输入，以及工作流
的关键安全闸门；不需要 Docker daemon、VPS 或生产凭据。

若生产机上的 root-owned entry point 早于监控实现，首次监控发布需从同一已验证
release checkout 以控制台更新
`/usr/local/sbin/monexus-compose-deploy{,-ssh-wrapper}`，再对同一 SHA 重跑受保护
deploy。不要创建普通 shell 权限或把部署账号加入 docker 组。
