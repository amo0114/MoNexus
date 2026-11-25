# Stripe 沙箱预发恢复

- 目标是恢复 `oracle-tokyo-free` 上的 `monexus-staging`，复用已有证书，并确认 Stripe 沙箱所需的应用设置。
- 范围包括预发 Caddy 站点、`/opt/monexus-staging` 的发布目录和独立 Compose 项目。备份预发数据库后可运行仓库提供的数据治理命令。生产、Jellyfin、公开仓库发布和 Stripe Live 配置不在范围内。
- 验收需通过公网 HTTPS、前端首页、API readiness 和预发部署 smoke，并报告沙箱充值和商户配置的实际状态。
- Owner 在 2026-11-25 的本次会话指定 `oracle-tokyo-free` 并授权完成预发恢复。DNS 灰云切换由 Owner 完成。
