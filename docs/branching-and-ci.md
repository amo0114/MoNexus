# 分支模型与 CI 规范

> 自 2026-07-26 起生效（P5 合并后）。默认分支为 `develop`。

## 分支模型

```
feat/xxx ─┐
fix/xxx  ─┼─ PR → develop ──（积累若干特性)── release PR → master ──（tag v*)── 生产
chore/xxx ┘                                        ▲
                                    hotfix/xxx ────┘（紧急修复直接 PR → master，随后回并 develop）
```

| 分支 | 角色 | 进入方式 |
|---|---|---|
| `master` | 生产稳定分支，任何提交都应可直接部署 | 仅接受 `develop` 的 release PR 与 `hotfix/*` PR；打 `v*` tag 发版 |
| `develop` | 集成分支（默认分支），日常开发的 PR 目标 | `feat/*` / `fix/*` / `chore/*` PR，Squash merge |
| `feat/*` `fix/*` `chore/*` | 短生命周期工作分支 | 从 `develop` 切出 |
| `hotfix/*` | 生产紧急修复 | 从 `master` 切出，合并后**必须**回并 `develop` |

## CI 矩阵（`.github/workflows/ci.yml`）

| 事件 | backend | frontend | e2e |
|---|---|---|---|
| PR → develop | 仅 `server/**` 变更时 | 仅前端相关路径变更时 | 默认**不跑**；`e2e/**` 变更或打 `run-e2e` 标签时跑 |
| push → develop（合并后） | ✅ | ✅ | ✅ 集成门——这是 PR 级 e2e 可以省的前提 |
| PR → master（release/hotfix） | 按路径 | 按路径 | 代码有变更即跑（生产门） |
| push → master | ✅ | ✅ | ✅ |

- **`CI OK`** 聚合 job 是唯一需要设为 required 的状态检查：上游 job 被路径过滤跳过时它仍成功，只有真实失败/取消才红。
- **不要在 PR 分支上用 `[skip ci]`**：它会抑制整个 workflow，required 的 `CI OK` 将永远 Pending，受保护分支的 PR 无法合并；纯文档 PR 靠路径过滤即可快速出绿，无需手动跳过。
- **强制跑 e2e**：给 PR 打 `run-e2e` 标签。
- 文档类路径（`docs/**`、`*.md`、`.claude/**` 等未列入过滤器的路径）的 PR 三个重活全跳过，约 1 分钟出绿。

## 镜像发布（`docker-publish.yml`）

- 仅 `master` push 与 `v*` tag 发布镜像（`:master` / `:sha-*` / `:latest` / semver）。
- PR 冒烟构建只在 **PR → master 且 Docker 构建输入**（Dockerfile / nginx.conf / .dockerignore / workflow 本身）变更时触发；日常 develop PR 不再构建镜像。
- `:latest` 显式钉在 master/tag 上（默认分支已是 develop，不能再用 `is_default_branch`）。

## 部署与运维

- `compose-production-deploy.yml`：Docker Compose VPS 的正式生产路径。它在成功的
  `master` 镜像发布后生成受 `production` Environment 审批保护的部署；首次启用前可用
  `workflow_dispatch + dry_run=true` 演练。详见
  [`compose-production-deploy.md`](./operations/compose-production-deploy.md)。
- `cd.yml` / `deploy.yml`：保留为 legacy artifact/systemd/PM2 路线；不得用于当前
  Docker Compose VPS。
- `backup.yml`（定时）、`alert-routing-test.yml`、`sentry-alert-check.yml`（手动）：与分支无关，不变。

## 分支保护建议（需仓库管理员在 Settings 配置）

- `master`：require PR（禁止直推）、required check = `CI OK`、禁 force push。
- `develop`：required check = `CI OK`、禁 force push。
