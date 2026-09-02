# MoNexus：1Panel + OpenResty + Docker VPS 部署手册

本手册记录 MoNexus 在一台公网 Linux VPS 上的实际部署路径。它适用于由 1Panel
管理 OpenResty/Nginx 的主机，也适用于 ARM64 VPS。此路径不需要 GitHub Pages、
Render、Neon、R2、Cloudflare Tunnel，也不要再额外运行 Caddy。

示例域名为 monexus.oai-o.com，请替换为自己的子域名。

## 目标架构

~~~text
浏览器
  -> Cloudflare DNS / CDN
  -> 1Panel OpenResty（VPS 公网 80 / 443）
  -> MoNexus web（Docker，127.0.0.1:18089）
     -> /api     -> server（Docker 私有网络 3000）
     -> /uploads -> MinIO（Docker 私有网络 9000）
  -> Postgres + Redis + MinIO（Docker named volumes）
~~~

仅 OpenResty 对外开放 80/443。Postgres、Redis、MinIO、Express 和 18089 都不应
直接暴露到互联网。禁止存在绕过 OpenResty 与 bundled Nginx 直达 Express 的第二条
路径，否则固定 `TRUST_PROXY=2` 不再安全。`WEB_PORT=18089` 必须只绑定 `127.0.0.1`。

## 0. 可信客户端 IP（必须先于限流与注册防滥用）

生产链路是 Cloudflare → 1Panel OpenResty → bundled Nginx → Express。Cloudflare
**不计入** Express hop，因为它不与 Express 建立 socket。OpenResty 必须先把
Cloudflare 官方 CIDR 上的 `CF-Connecting-IP` 还原为 `$remote_addr`，再**覆盖**
（而不是追加）转发给 bundled Nginx 的 `X-Forwarded-For`。

上线时从 [Cloudflare IP ranges](https://www.cloudflare.com/ips/) 取当前
IPv4/IPv6 CIDR，逐条生成 `set_real_ip_from`。不要把会随时间变化的 CIDR 手抄进
应用代码或仓库常量。

~~~nginx
real_ip_header CF-Connecting-IP;
set_real_ip_from <Cloudflare IPv4/IPv6 CIDR>;
real_ip_recursive on;

proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Host $host;
~~~

关键点：使用 `$remote_addr` 覆盖 XFF，不要用 `$proxy_add_x_forwarded_for` 把用户
可伪造的入站值追加进去。只有来自 Cloudflare 官方 CIDR 的连接才允许用
`CF-Connecting-IP` 改写 `$remote_addr`；源站被直接访问时 `$remote_addr` 保持直连
地址。bundled `nginx.conf` 继续追加一跳，Express 看到的链为：

~~~text
XFF: <canonical-client>, <openresty-to-web-hop>
socket: <bundled-nginx>
~~~

对应环境变量必须精确匹配：

~~~dotenv
DEPLOY_TOPOLOGY=cloudflare_openresty_nginx
TRUST_PROXY=2
API_RATE_LIMIT_MAX=1500
~~~

`TRUST_PROXY` 只接受规范十进制 `0|1|2`，`true`/`false` 会启动失败。确认真实 IP
恢复后再把全局限流从临时 3000 下调到 1500，至少观察 24 小时。条件允许时，主机
80/443 仅允许 Cloudflare CIDR；SSH 端口不受此规则影响。

## 1. 主机前置检查

建议最低配置为 2 vCPU、4 GB RAM、40 GB SSD。GHCR 发布镜像包含 linux/amd64 和
linux/arm64；ARM 主机的 uname -m 通常显示 aarch64。

~~~bash
uname -m
docker --version
docker compose version
ss -ltnp '( sport = :80 or sport = :443 or sport = :18089 )'
~~~

Docker Compose 应为 v2.24.4 或更高版本。本项目的 VPS overlay 使用了 Compose 的
服务端口覆盖语法。

如果 80/443 已被 1Panel OpenResty 占用，这是预期状态。不要停止 OpenResty，不要
再安装会竞争端口的 Caddy。若 18089 已被占用，选择任意未占用高端口，并在环境变量
和 1Panel 上游配置中使用同一个值。

云厂商安全组和防火墙只需允许入站 TCP 80、443 与 SSH 管理端口。不要添加 18089、
3000、5432、6379、9000、9001 的公网放行规则。

## 2. Cloudflare DNS

在 Cloudflare 的域名 Zone 中添加独立记录，不要修改根域名或既有 app、api 记录：

~~~text
Type:   A
Name:   monexus
Target: <VPS 公网 IPv4>
Proxy:  DNS only（灰云）
~~~

先保持灰云，以便 1Panel 使用 HTTP-01 验证签发 Let's Encrypt 证书。HTTPS 验证成功
后再切为橙云；Cloudflare 的 SSL/TLS encryption mode 必须为 Full (strict)，绝不能
使用 Flexible。

## 3. 取得部署文件与验证发布镜像

~~~bash
mkdir -p /opt/monexus
git -c http.version=HTTP/1.1 clone --branch master \
  https://github.com/amo0114/MoNexus.git /opt/monexus
cd /opt/monexus
~~~

http.version=HTTP/1.1 是 GitHub HTTPS/HTTP2 TLS 握手偶发中断时的兼容写法；网络
稳定时普通 git clone 也可以。

每次合并至 master 都会触发 GitHub Actions 的 Publish Docker images。部署前应在
Actions 页面确认 build-server 与 build-web 都成功。使用不可变 SHA tag 前，验证
两个 manifest 均已发布：

~~~bash
docker buildx imagetools inspect \
  ghcr.io/amo0114/monexus-server:sha-<master-短提交号>
docker buildx imagetools inspect \
  ghcr.io/amo0114/monexus-web:sha-<master-短提交号>
~~~

两条输出都必须同时显示：

~~~text
Platform: linux/amd64
Platform: linux/arm64
~~~

如果 GHCR package 是私有的，使用只含 read:packages 权限的 GitHub PAT：

~~~bash
read -rsp 'GitHub PAT: ' GHCR_PAT; echo
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u <GitHub 用户名> --password-stdin
unset GHCR_PAT
~~~

不要在 Actions 尚未完成时把环境变量切到不存在的 SHA tag，否则 docker pull 会报
not found。

## 4. 创建并配置 .env

~~~bash
cd /opt/monexus
cp .env.example .env
chmod 600 .env
~~~

使用编辑器修改 .env。每个密码和令牌都应不同，可分别使用 openssl rand -hex 32 或
openssl rand -hex 48 生成。不要把 .env、密钥或备份上传到 Git。

下面是首次公网部署的核心配置。尖括号必须替换；等号后留空表示明确关闭可选服务，
不要保留模板内的假 URL。

~~~dotenv
POSTGRES_USER=monexus
POSTGRES_PASSWORD=<随机数据库密码>
POSTGRES_DB=monexus

JWT_SECRET=<至少 32 字符的随机值>
FRONTEND_ORIGIN=https://monexus.oai-o.com
APP_BASE_URL=https://monexus.oai-o.com
COOKIE_SECURE=true
DEPLOY_TOPOLOGY=cloudflare_openresty_nginx
TRUST_PROXY=2
API_RATE_LIMIT_MAX=1500

# 仅回环绑定；80 由 1Panel OpenResty 使用。
WEB_PORT=18089

STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_BUCKET=monexus-uploads
STORAGE_ACCESS_KEY=monexus-minio
STORAGE_SECRET_KEY=<随机 MinIO 密钥>
STORAGE_PUBLIC_URL_BASE=https://monexus.oai-o.com/uploads
STORAGE_FORCE_PATH_STYLE=true

REDIS_PASSWORD=<随机 Redis 密码>
REDIS_ENABLED=true
REDIS_REQUIRED=true
REDIS_URL=redis://redis:6379
REDIS_TLS=false
# 注册防滥用必须使用独立于 JWT/MFA 的 key，并使用生产 Turnstile widget。
ABUSE_PROTECTION_MODE=enforce
ABUSE_HASH_KEY=<独立的32字节标准Base64随机值>
TURNSTILE_SITE_KEY=<生产Turnstile site key>
TURNSTILE_SECRET_KEY=<生产Turnstile secret key>
TURNSTILE_ALLOWED_HOSTNAMES=monexus.oai-o.com
METRICS_TOKEN=<至少 32 字符的随机值>

# 没有真实 SMTP/Sentry 时必须清空模板占位值。
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SENTRY_DSN=
VITE_SENTRY_DSN=

# 改成已发布并验证过的 tag。
MONEXUS_IMAGE_TAG=sha-<master-短提交号>
MONEXUS_PULL_POLICY=missing
~~~

运行时允许 SMTP 与 Sentry 为空：邮件会记录到 server 日志，Sentry 不上报。真正的
生产运营前应配置 SMTP 与备份目标；Sentry/GlitchTip 为推荐的可选观测集成。再执行
严格门禁：

~~~bash
npm run prod:env
~~~

严格门禁会要求 SMTP、安全与备份变量；如配置 Sentry/GlitchTip，其 DSN 必须是 HTTPS。
它不应以虚假占位值绕过。

注意不要在 Windows 编辑后直接上传 .env。CRLF 换行会令部分带行尾匹配的替换命令
不生效。若 sed 执行后看似没有修改，使用不依赖行尾的写法：

~~~bash
sed -i 's|^SENTRY_DSN=.*|SENTRY_DSN=|' .env
~~~

## 5. 启动 Compose 栈

包装脚本固定加载生产 Compose、VPS loopback overlay 与自托管 MinIO profile：

~~~bash
cd /opt/monexus
bash scripts/vps-compose.sh config >/dev/null && echo 'Compose 配置正常'
bash scripts/vps-compose.sh up
bash scripts/vps-compose.sh ps
~~~

首次启动会拉取镜像、创建 named volumes，并由 server 自动执行 Prisma migrate deploy。
不要手工重复执行迁移。

验证宿主机本地链路：

~~~bash
curl -fsS http://127.0.0.1:18089/api/health/live
curl -fsS http://127.0.0.1:18089/api/health/ready
~~~

成功时 ready 会包含 database 为 ok，web 的端口显示应类似：

~~~text
127.0.0.1:18089->80/tcp
~~~

这表示应用未对公网直接开放。

## 6. 用 1Panel 配置 OpenResty 反向代理

不要在 Compose 中加入 Caddy。OpenResty 已是这台主机的公共入口，应由 1Panel 统一
管理所有网站。

不同 1Panel 版本的菜单略有差异，按以下语义操作：

1. 进入 网站，选择 创建网站。
2. 类型选择 反向代理；若没有此类型，先创建 monexus.oai-o.com 空白网站，再到该
   网站的反向代理标签页新增规则。
3. 域名填写 monexus.oai-o.com。
4. 上游地址填写 http://127.0.0.1:18089。
5. 保存；若有 WebSocket 选项可启用。
6. 在 HTTPS 页面申请 Let's Encrypt 证书，使用 HTTP 验证。
7. 证书签发成功后开启强制 HTTPS。

不要把上游写成公网 IP、域名或 http://web:80。OpenResty 位于宿主机，稳定可访问的
上游是 127.0.0.1:18089。

验证公网链路：

~~~bash
curl -fsS https://monexus.oai-o.com/api/health/live
curl -fsS https://monexus.oai-o.com/api/health/ready
~~~

成功后将 Cloudflare 改橙云并启用 Full (strict)，再重复 HTTPS 健康检查。如果
Cloudflare 有全局 Cache Everything 规则，必须为 /api/* 增加绕过缓存规则。

## 7. 创建首个管理员，不使用 seed

公网环境不要运行 npm run db:seed。seed 会创建公开已知的演示账号、弱密码和示例
商品，只适合隔离的本地演示数据库。

以下一次性命令提示输入自选邮箱与至少 12 位密码，不将密码写入 shell 历史，也不
显示密码。若邮箱已存在，它会重置该用户密码并提升为管理员，因此只能对确认无误的
自有邮箱执行。

~~~bash
cd /opt/monexus
read -rp '管理员邮箱: ' INITIAL_ADMIN_EMAIL
read -rsp '管理员密码（至少 12 位）: ' INITIAL_ADMIN_PASSWORD; echo
export INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD

docker exec -i \
  -e INITIAL_ADMIN_EMAIL \
  -e INITIAL_ADMIN_PASSWORD \
  monexus-server-prod node --input-type=module <<'NODE'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()
const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.INITIAL_ADMIN_PASSWORD

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('请输入有效的管理员邮箱')
}
if (!password || password.length < 12) {
  throw new Error('管理员密码至少 12 位')
}

try {
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      password: passwordHash,
      role: 'admin',
      status: '正常',
      emailVerified: new Date(),
    },
    update: {
      password: passwordHash,
      role: 'admin',
      status: '正常',
      emailVerified: new Date(),
    },
  })
  await prisma.pointAccount.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, balance: 0 },
  })
  console.log('管理员已就绪：' + email)
} finally {
  await prisma.$disconnect()
}
NODE

unset INITIAL_ADMIN_EMAIL INITIAL_ADMIN_PASSWORD
~~~

随后通过普通登录表单使用自选账号登录。生产构建不应显示开发环境快捷登录；该入口
只对应本地 seed 数据，并不能创建账户。

## 8. 更新、回滚和备份

### 更新

1. 合并 PR 到 master。
2. 等待 Publish Docker images 的 server 与 web 构建都成功。
3. 在 VPS 更新部署文件，并验证新 SHA manifest 的双架构平台。
4. 修改 .env 中的 MONEXUS_IMAGE_TAG。
5. 启动并检查健康状态。

~~~bash
cd /opt/monexus
git -c http.version=HTTP/1.1 pull --ff-only origin master

docker buildx imagetools inspect ghcr.io/amo0114/monexus-server:sha-<新短提交号>
docker buildx imagetools inspect ghcr.io/amo0114/monexus-web:sha-<新短提交号>

bash scripts/vps-compose.sh up
bash scripts/vps-compose.sh ps
curl -fsS https://monexus.oai-o.com/api/health/ready
~~~

### 回滚

把 .env 的 MONEXUS_IMAGE_TAG 改回最后一个已验证的 SHA tag，再运行：

~~~bash
bash scripts/vps-compose.sh up
~~~

不要为代码回滚删除 pgdata-prod 或 miniodata-prod volumes。代码回滚不等于数据库
schema 回滚；新迁移已应用时，要先评估其向后兼容性。

### 单机 Redis

生产 Compose 内的 Redis 是经过批准的单机服务，不运行 Sentinel 或副本。它仅位于
Docker 私有网络，Compose 不发布 `6379`；发布版本会启用 AOF 和每秒 fsync。主机故障
会同时影响 MoNexus 和 Redis，因此这不是高可用设计：公开注册及用户邮件会按
fail-closed 语义暂停，待主机恢复后再继续。不要为了故障临时把
`ABUSE_PROTECTION_MODE` 改为 `off`。

部署后确认 AOF 已启用，命令不会打印 Redis 密码：

~~~bash
cd /opt/monexus
bash scripts/vps-compose.sh exec redis sh -c \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO persistence | grep "^aof_enabled:1$"'
~~~

### 备份

Docker volume 只代表持久化，不代表备份。使用仓库脚本创建 age 加密的 PostgreSQL
备份，并同时快照 MinIO 上传对象；私钥（age identity）不能留在此 VPS，只保存公开
recipient。把加密产物复制到另一台主机时，配置 `rclone crypt` 远端。

~~~bash
sudo apt-get update && sudo apt-get install -y age rclone
sudo install -d -m 700 /etc/monexus /var/backups/monexus
sudoedit /etc/monexus/backup.env

# /etc/monexus/backup.env 至少包含：
# BACKUP_SOURCE=docker-compose
# BACKUP_COMPOSE_ENV_FILE=/opt/monexus/.env
# BACKUP_COMPOSE_PROJECT_NAME=monexus-prod
# BACKUP_AGE_RECIPIENT=age1<仅公钥>
# BACKUP_OBJECT_MODE=compose-minio
# RCLONE_REMOTE=offsite-crypt:monexus   # 可选但生产建议配置

cd /opt/monexus
set -a; . /etc/monexus/backup.env; set +a
bash scripts/backup.sh
~~~

对每一份备份，必须在独立 staging/restore 数据库中运行
`BACKUP=<...sql.gz.age> BACKUP_AGE_IDENTITY_FILE=<离线私钥路径> npm run backup:restore-check`，
再通过 `npm run backup:restore-objects-check` 将对应 MinIO 对象快照恢复到独立
`monexus-restore` Compose 项目并验证图片 URL；两项均成功后才视为有效备份。

## 9. 本次部署踩坑与诊断

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| GH006 Protected branch update failed | master 受保护，禁止直接 push。 | 从分支创建 PR，等待必需检查后合并。 |
| ARM 主机提示 linux/amd64 与 linux/arm64 不匹配 | 镜像没有 ARM manifest，或本机仍使用旧 latest。 | 发布 linux/amd64 与 linux/arm64，使用 imagetools 验证 SHA。 |
| Server 找不到 linux-musl-arm64-openssl-3.0.x，ready 为 503 | Prisma binaryTargets 缺少 Alpine ARM64 Query Engine。 | 在 Prisma schema 增加该 target 后重发 server 镜像。 |
| Server 不断重启并报 SENTRY_DSN Invalid url | .env.example 的 Sentry 假 URL 被原样使用。 | 未配置 Sentry 时设 SENTRY_DSN=，不要保留占位 URL。 |
| failed to bind 127.0.0.1:80 | WEB_PORT 还是 80，与 OpenResty 冲突。 | 设 WEB_PORT=18089，仅让 OpenResty 反代它。 |
| Caddy 无法启动或证书冲突 | OpenResty 已占用 80/443。 | 不部署 Caddy，直接在 1Panel 创建独立反向代理站点。 |
| SHA image not found | 发布工作流未结束、失败，或 tag 写错。 | 等 Actions 全绿，再用 imagetools inspect 验证。 |
| 开发环境快捷登录报邮箱或密码错误 | 它只填 seed 演示值，安全部署没有 seed。 | 创建自有管理员，生产构建隐藏快捷入口。 |
| git 报 gnutls_handshake failed | GitHub HTTPS/HTTP2 在部分网络不稳定。 | 对单次命令使用 git -c http.version=HTTP/1.1 并重试。 |
| Cloudflare 橙云后 HTTPS 循环或 52x | 证书未签发，或 SSL 模式不正确。 | 先灰云签证书；成功后橙云加 Full (strict)，不要 Flexible。 |

## 10. 上线后检查清单

~~~bash
docker compose --project-name monexus-prod --env-file .env \
  -f docker-compose.prod.yml -f docker-compose.vps.yml \
  --profile selfhost-storage ps

curl -fsS https://monexus.oai-o.com/api/health/live
curl -fsS https://monexus.oai-o.com/api/health/ready
~~~

确认：

- web 仅显示为 127.0.0.1:<端口>->80/tcp；
- server、postgres、redis、minio 为 healthy 或符合预期；
- Cloudflare 使用 Full (strict)；
- .env 权限为 600，且不在 Git 内；
- 已创建自有管理员，而非 seed 默认账号；
- PostgreSQL 与 MinIO 均有异机且可恢复的备份。
