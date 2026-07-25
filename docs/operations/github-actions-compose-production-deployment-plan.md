# GitHub Actions 自动化 Compose 生产部署方案（待实施）

> 状态：方案，尚未实施。  
> 记录日期：2026-07-25。  
> 适用目标：当前 `/opt/monexus` Docker Compose 生产环境。

## 1. 目的与边界

将目前依赖人工 SSH 的发布流程自动化：PR 合并到 `master` 后，由
GitHub Actions 验证同一提交的 CI 和镜像构建结果；在生产环境审批通过后，
安全地连接 VPS，部署对应的不可变镜像并执行健康检查。

本方案解决“每次上线都要登录服务器执行 `git pull`、`docker pull`、改 `.env`
和重启”的重复操作，但**不会**在第一阶段实现无审批的自动上线。

不在本次方案范围内：

- 更换为 Kubernetes、Watchtower 或托管 PaaS；
- 自动数据库回滚或自动恢复备份；
- 蓝绿/零停机发布。当前单副本 Compose `restart` 会有短暂连接中断；
- 将生产 `.env`、数据库密码、JWT 密钥或 MinIO 密钥保存到 GitHub。

## 2. 当前基线

生产服务器的已验证发布方式为：

```text
工作目录：/opt/monexus
镜像：ghcr.io/amo0114/monexus-server:sha-<短SHA>
      ghcr.io/amo0114/monexus-web:sha-<短SHA>
运行入口：bash scripts/vps-compose.sh
本机健康检查：http://127.0.0.1:18089/api/health/ready
```

生产 `.env` 中由发布流程维护的仅是：

```dotenv
MONEXUS_IMAGE_TAG=sha-<短SHA>
MONEXUS_PULL_POLICY=missing
```

服务端容器启动时已执行 `prisma migrate deploy`，因此应用迁移会在发布重建
服务端容器时自动运行。发布脚本必须继续使用：

```bash
bash scripts/vps-compose.sh config
bash scripts/vps-compose.sh restart
```

不得以 `vps-compose.sh up` 取代 `restart`。后者可能尝试拉取无关的
Postgres、Redis、MinIO 镜像，曾因 Docker Hub 网络超时而影响发布。

仓库现有工作流的职责如下：

| 工作流 | 当前职责 | 自动化 Compose 发布中的定位 |
| --- | --- | --- |
| `ci.yml` | 后端测试、前后端构建、Playwright E2E | 必须成功的发布前置条件 |
| `docker-publish.yml` | 发布 server/web 的多架构 GHCR 镜像 | 必须成功的发布前置条件 |
| `deploy.yml` | artifact + systemd/PM2 的旧部署路线 | 不复用；实施后标记为 legacy，避免误用 |

`docker-publish.yml` 已为 `master` 生成 `sha-<短SHA>` 标签，以及 x86_64
和 ARM64 的多架构 manifest；这正好匹配当前 ARM64 VPS。

## 3. 目标发布链路

```text
PR 合并至 master（精确完整 SHA）
  ├─ CI：构建、单元测试、E2E
  └─ Publish Docker images：server + web，多架构 GHCR 镜像
            │
            └─ 发布闸门：确认同一 SHA 的两个前置流程均成功
                         且两个 sha-<短SHA> 镜像可用
                         │
                         ▼
                 GitHub Environment: production
                     （等待人工审批）
                         │
                         ▼
               SSH 调用 VPS 固定部署入口
                         │
                         ▼
        pull 指定镜像 → 写入 tag → Compose restart → 迁移
                         │
                         ▼
      本机 ready 检查 → 公网健康检查 → Actions 部署摘要
```

整个链路始终使用同一个 commit：服务器上的 Compose 配置切换到完整 SHA，
容器使用与该 SHA 对应的 `sha-<短SHA>` 镜像。不得使用 `latest`、`master`
等可变标签作为正式生产版本。

## 4. 触发、闸门与审批

### 4.1 为什么不能只在镜像发布成功后立即部署

目前 `ci.yml` 与 `docker-publish.yml` 会在 `master` push 时并行执行。
镜像构建先成功并不表示 E2E 已成功。因此部署控制器必须按完整 SHA 查询
同一次 `push` 的 CI 结论，等待其变为 `success`；若失败、取消或超时，
不得创建生产部署。

### 4.2 建议新增的工作流

新增 `.github/workflows/compose-production-deploy.yml`，职责是部署编排，
而非重新构建应用。

自动候选部署的触发建议采用 `workflow_run`：

1. 仅监听 `Publish Docker images` 完成；
2. 仅接受 `event=push`、`head_branch=master`、本仓库来源的运行；
3. 取得 `workflow_run.head_sha`；
4. 通过 GitHub API 轮询同 SHA 的 `CI` 运行，直至 `success`、失败或超时；
5. 确认 server 与 web 的 `sha-<短SHA>` manifest 均可读取；
6. 进入绑定 `production` Environment 的部署 job，等待审批。

这样不会让 PR、fork、PR 构建产物或不受保护分支获得生产 SSH 凭证。部署
workflow 不下载或执行来自 PR 的 artifact。

### 4.3 分阶段启用

为降低首次上线风险，按以下顺序启用：

1. **阶段一：手动演练**。工作流只支持 `workflow_dispatch`，输入一个已验证
   的 `master` SHA，且仍需 production 审批；支持 `dry_run=true`。
2. **阶段二：真实手动发布**。用一个已发布镜像完成一次真实部署，验证日志、
   健康检查和回退过程。
3. **阶段三：自动生成待审批部署**。启用上述 `workflow_run` 闸门；合并后自动
   等待你的批准。
4. **阶段四（可选）**：仅在稳定运行一段时间且明确接受风险时，取消 required
   reviewer，变为完全自动部署。

日常推荐停留在阶段三：合并 PR → 等待绿灯 → GitHub 点击
**Review deployments / Approve and deploy**，无需 SSH。

### 4.4 并发保护

部署 job 设置：

```yaml
concurrency:
  group: production-compose-deploy
  cancel-in-progress: false
```

这保证已等待审批或正在运行的部署不会被新提交取消，更不能与另一次 Prisma
迁移并发执行。VPS 脚本还会使用本机文件锁作为第二层保护。

## 5. GitHub Environment 与凭证

创建 GitHub Environment：`production`，并配置 required reviewers（至少为
仓库管理员）。SSH 凭证只绑定部署 job 的该 Environment，使其在批准前不可见。

建议配置如下：

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `DEPLOY_SSH_HOST` | Environment secret | VPS 主机名或 IP |
| `DEPLOY_SSH_PORT` | Environment variable/secret | SSH 端口 |
| `DEPLOY_SSH_USER` | Environment secret | 专用部署账号 |
| `DEPLOY_SSH_PRIVATE_KEY` | Environment secret | 专用 ED25519 私钥 |
| `DEPLOY_SSH_KNOWN_HOSTS` | Environment variable | VPS 固定 SSH host key |
| `DEPLOY_BASE_PATH` | Environment variable | `/opt/monexus` |
| `PRODUCTION_HEALTHCHECK_URL` | Environment variable | 外网 ready 健康检查 URL |

`DEPLOY_SSH_KNOWN_HOSTS` 应预先从可信控制台或已验证会话取得并固定，不能在
Actions 运行时通过 `ssh-keyscan` 临时信任，以降低中间人攻击风险。

生产 `.env`、备份密钥、数据库密码和 GHCR 读取 Token 都只存留在 VPS。若 GHCR
包是私有的，VPS 只需一次性 `docker login ghcr.io`，使用最小范围
`read:packages` Token；不把镜像写入凭证交给服务器。

## 6. VPS 专用部署入口

在 VPS 创建固定入口：

```text
/usr/local/sbin/monexus-compose-deploy
```

Actions 仅通过 SSH 调用：

```text
deploy <完整40位SHA> <sha-7位短SHA>
```

脚本的设计要求：

1. 使用 `set -euo pipefail` 与 `flock`，阻止并发部署；
2. 严格校验完整 SHA、镜像标签格式，以及标签是否等于该 SHA 的前 7 位；
3. 检查 `/opt/monexus/.env` 存在，检查受 Git 跟踪的工作目录无未提交修改；
   忽略 `.env` 等本地机密文件；
4. 以 `git -c http.version=HTTP/1.1 fetch` 拉取远端，验证目标 SHA 是
   `origin/master` 可达的提交，并 detached checkout 到该精确 SHA；
5. 先拉取且验证两个目标镜像，任何一个失败都不改 `.env`；
6. 在不输出其内容的前提下安全备份当前 `.env`，记录旧 tag、目标 tag、完整
   SHA、时间和 Actions run URL 到权限受限的部署状态文件；
7. 仅更新 `MONEXUS_IMAGE_TAG` 与 `MONEXUS_PULL_POLICY=missing`；
8. 执行 `bash scripts/vps-compose.sh config`，随后执行
   `bash scripts/vps-compose.sh restart`；
9. 在 90–120 秒内轮询本机 `/api/health/ready`；
10. 成功时输出 tag、commit、容器状态和健康响应；失败时输出
    `vps-compose.sh ps`、server/web 的有限最近日志，并以非零状态退出。

服务端启动阶段的 `prisma migrate deploy` 保持不变。脚本不调用任何会清空、
重置或重新 seed 生产数据库的 Prisma 命令。

建议创建专用 `monexus-deploy` Linux 用户，禁用密码登录，并限制其只拥有
`/opt/monexus` 与 Docker 所需的权限。Docker 组本身具备高权限，故该账号和
私钥仍应按高敏感凭证管理。

强化选项是在 `authorized_keys` 对该部署公钥使用 forced command：只允许执行
上述部署入口，禁止端口转发、agent 转发、X11 和 PTY。该项可在基础方案稳定后
再启用。

## 7. 健康检查与可观测性

部署成功必须同时满足：

1. Compose 中 `server` 为 healthy；
2. VPS 本机请求成功：
   `curl -fsS http://127.0.0.1:18089/api/health/ready`；
3. Actions 从公网请求 `PRODUCTION_HEALTHCHECK_URL` 成功，验证 OpenResty/
   反向代理和外部网络路径。

Actions Summary 至少记录：

- 完整 commit SHA 与 `sha-<短SHA>`；
- server/web 两个镜像引用；
- 触发来源、审批人、开始/结束时间；
- 本机与公网健康检查结论；
- 失败时的容器状态和日志链接（不得输出 `.env` 或 Token）。

## 8. 失败处理与回退

发布前镜像拉取或配置校验失败时，`.env` 不应变更，现网保持原状。

若重启或健康检查失败：

1. 工作流标记失败并保留诊断信息；
2. 状态文件保留上一个成功 tag 和本次目标 tag；
3. 不做自动代码/数据库回退；
4. 暂停后续发布，先确认迁移是否已执行、数据库与应用是否向后兼容；
5. 优先使用小型 forward fix；如确认兼容，可在受控手动工作流中选择上一个
   已知健康的 `sha-<短SHA>` 回退并重新审批。

自动回退被刻意排除：数据库迁移可能不可逆，即使旧镜像可启动，也不能假定它
能安全使用新 schema。回退与恢复必须遵循
[rollback-runbook.md](./rollback-runbook.md) 和现有备份/恢复演练流程。

## 9. 实施清单

### VPS 准备

- [ ] 验证现有备份和恢复演练可用；
- [ ] 创建 `monexus-deploy` 专用账号与独立 ED25519 密钥；
- [ ] 配置 SSH 禁止密码登录，并保存可信 host key；
- [ ] 在 VPS 一次性完成 GHCR `read:packages` 登录（若包私有）；
- [ ] 安装、审查并以 `dry_run` 验证 `monexus-compose-deploy`；
- [ ] 确认 `/opt/monexus` 没有需要保留的受跟踪本地改动。

### GitHub 准备

- [ ] 创建 `production` Environment 并设置 required reviewer；
- [ ] 写入上述 Environment secrets/variables；
- [ ] 保护 `master`：PR 合并、CI 必须通过；
- [ ] 新增 Compose 部署工作流的手动模式；
- [ ] 将旧 artifact/systemd `deploy.yml` 明确标记为 legacy 或禁用其生产入口；
- [ ] 更新 Compose 发布、回退与值班文档，避免两套部署说明并存。

### 验收演练

- [ ] 对已发布的 master SHA 执行 `dry_run`；
- [ ] 执行一次 production 审批的真实部署；
- [ ] 验证迁移、两层健康检查、Actions Summary 和部署状态文件；
- [ ] 在非紧急条件下演练一次受控代码回退；
- [ ] 仅在以上全部通过后，启用自动生成待审批部署。

## 10. 实施后的日常操作

正常发布：

```text
合并 PR 到 master
→ 等待 CI 与 Docker publish 成功
→ GitHub Actions 中批准 production 部署
→ 查看自动生成的部署摘要
```

紧急重部署或回退：

```text
GitHub Actions → Compose Production Deploy → Run workflow
→ 选择已验证、属于 master 历史的完整 SHA
→ 审批 → 自动部署与健康检查
```

除非 GitHub Actions 或 VPS 本身不可用，运维人员不再需要通过 SSH 手动拉镜像、
编辑 `.env` 或重启 Compose。

