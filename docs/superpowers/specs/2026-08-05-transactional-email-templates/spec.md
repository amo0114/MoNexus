# Spec: 事务邮件品牌模板

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-MAIL-TPL-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-05 |
| 状态 | Frozen for Implementation |
| 产品 | MoNexus |
| 前置规格 | SPEC-OPS-REGMAIL-001（邮件运营面 / MAIL-01~04）、SPEC-RAP-001（验证链接与 OTP 语义） |
| 配套文档 | [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) · [checklist.md](./checklist.md) |

---

## 1. 目的与问题陈述

### 1.1 目的

将 MoNexus 全部用户可见 / 商家可见的事务与运营邮件，从散落的纯文本拼接升级为统一品牌、双格式（`text` + `html`）的模板呈现层，在不改发信策略与安全边界的前提下提升可信度与可读性。

### 1.2 已核实的现状

| 事实 | 影响 |
| --- | --- |
| `MailMessage` 已支持可选 `html`；`SmtpMailer` 会转发 `html` | 基础设施就绪，缺呈现层 |
| 全部 9 类业务发信点仅传 `text`，无共享 layout | 邮件在客户端呈现为朴素系统通知 |
| 验证链接、OTP、业务提醒文案内联在各模块 `buildMail` / `mailer.send` | 风格不一致，改品牌需改多处 |
| 站点有 indigo/CTA token 与 Ledger Knot 品牌资源 | 邮件通道未复用 |
| 无营销邮件 / 群发 / 退订产品 | 本波不发明营销能力 |

### 1.3 成功标准

1. 注册表中的 9 个 kind 全部经 `renderMail` 产出，且 `subject` / `text` / `html` 齐全。
2. HTML 使用 table 布局 + inline CSS，含品牌顶栏、正文区、页脚；关键动作有主 CTA 按钮或 OTP 大号块。
3. 动态字段全部 HTML escape；商品名等用户/商家可控字符串不得破坏结构或注入标签。
4. 调用点替换后，现有 auth / provision OTP / admin mail / 业务提醒测试通过，并断言 `html` 含关键片段。
5. 不改变 token 构造、限流、MAIL-01~04、console/SMTP 选择逻辑。

---

## 2. 范围

### 2.1 范围内

| 域 | 本波交付 |
| --- | --- |
| 呈现层 | `server/src/lib/mailer/templates/**`：tokens、escape、layout、render、各 kind |
| 用户向邮件 | 邮箱验证链接、密码重置、Xboard 开通邮箱 OTP |
| 运营向邮件 | 管理员投递测试（仍遵守 MAIL-04） |
| 商家/业务邮件 | 低库存、履约超时、预约提醒、订阅到期前/后、自动开通失败 |
| 测试 | 模板单元/快照、调用点回归 |
| 预览 | `scripts/preview-mail-templates.mjs` 导出静态 HTML |

### 2.2 范围外

| 项 | 原因 |
| --- | --- |
| 营销群发、受众圈选、退订中心 | 独立产品；合规与队列另立规格 |
| 后台模板 CMS / 可视化编辑 | 运营编辑面过大；v1 代码模板 + 评审 |
| 多语言 i18n 框架 | 现产品中文为主；`locale` 可预留但不实现 |
| React Email / MJML 依赖 | 决策 D-02：零依赖 TS 模板 |
| SMTP 凭证后台编辑、改 mailer 超时/租约 | 前置规格与基础设施边界 |
| 验证链接 fragment 语义、OTP 安全协议、限流 | 只改呈现 |
| 前端页面视觉大改 | 与邮件通道无关 |

### 2.3 冻结决策

| ID | 决策 | 结论 |
| --- | --- | --- |
| D-01 | 范围 | 仅事务 / 运营邮件模板化 |
| D-02 | 实现栈 | 零新依赖，手写 table HTML 的 TS 模板函数 |
| D-03 | Logo | HTTPS 绝对 URL：`${appBaseUrl}/brand/ledger-knot/mark-light.png` |
| D-04 | 覆盖 | 全部 9 类一次交付 |
| D-05 | 预览 | 单元断言 + 本地 preview 脚本导出 HTML |

---

## 3. 领域规则与不变量

| ID | 规则 |
| --- | --- |
| TPL-01 | 用户/商家可见邮件必须经 `renderMail(kind, vars)` 得到 `MailMessage`；业务模块禁止直接拼 HTML。 |
| TPL-02 | 每封邮件 `text` 与 `html` 同时存在；`text` 为完整可读正文，不依赖 HTML。 |
| TPL-03 | 所有动态字符串经 `htmlEscape`；链接 base 仅 `config.appBaseUrl`（或调用方传入的已校验 URL）。 |
| TPL-04 | OTP / raw token 不得写入 logger、AdminLog、console mailer 的可检索字段；console 保持现有「不打印正文」行为。 |
| TPL-05 | 测试邮件遵守 MAIL-04：无 token、无订单、无配置；可使用品牌壳 + 固定文案。 |
| TPL-06 | HTML 兼容：table 布局、inline CSS、无 JS、无外部字体依赖；宽度约 600px。 |
| TPL-07 | 模板内容随代码版本发布；不存 DB。 |
| TPL-08 | Logo 使用绝对 HTTPS URL；图片失败时 alt + 站点名仍可读。 |
| TPL-09 | `subject` 保持中文、信息密度与现有接近，允许微调为更清晰标题，但不得移除「验证码/重置/订单号」等关键语义。 |

---

## 4. 模板注册表（kind）

| kind | 主题基线 | 关键 UI |
| --- | --- | --- |
| `email_verification` | `MoNexus 邮箱验证` | 主按钮「验证邮箱」+ 备用链接 + 时效说明 |
| `password_reset` | `MoNexus 密码重置` | 主按钮「重置密码」+ 备用链接 + 非本人忽略 |
| `provision_email_otp` | `MoNexus 开通邮箱验证码` | 大号等宽 6 位码 + 10 分钟 |
| `mail_delivery_test` | `MoNexus 邮件投递测试` | 品牌壳 + 固定安全文案 |
| `low_stock` | `【低库存预警】…` | 商品/规格/库存表格式信息 |
| `sla_overdue` | `【履约超时提醒】…` | 警示条 + 订单信息 |
| `booking_reminder` | `【预约提醒】…` | 买家/商家 role 变体 |
| `subscription_expiring` | `【订阅即将到期】…` | 到期时间 + 续费引导 |
| `subscription_expired` | `【订阅已到期】…` | 到期时间 + 续费引导 |
| `provision_degraded` | `【自动开通失败，请人工履约】…` | 错误码 + 人工履约提示 |

> 计数：用户 3 + 测试 1 + 商家/业务 6 = **10 kind**（订阅拆成 pre/expired 两个 kind；原「9 类业务场景」中订阅为 1 类 2 变体）。验收以本表为准。

---

## 5. 视觉契约

采用产品默认 **墨韵（ink）** 色板（`data-theme="ink"`），非 indigo 默认 light。

| Token | 值 | 用途 |
| --- | --- | --- |
| primary | `#34507A` | 花青 — 链接 / OTP |
| cta | `#3D7257` | 松绿 — 主按钮 |
| text | `#22262C` | 松烟墨 |
| muted | `#666E77` | 淡墨 |
| bg | `#EEF0EE` | 冷白宣纸 |
| surface | `#F8F9F7` | 卡纸 |
| border | `#D9DDD9` | 绫绢灰边 |
| warning | `#677220` | 苔黄警示 |

结构：居中品牌锁（logo 上 + 站名下，无色条、logo 无矩形底）→ 标题 → 正文 → CTA 或 OTP → 次要提示 → 居中页脚。

Logo 资源：`/brand/ledger-knot/mark-black.png`（墨韵 black 系列）。

### 5.1 对齐规则

| 区域 | 对齐 | 原因 |
| --- | --- | --- |
| Logo + 站点名 | 居中 | 品牌锁 |
| 主标题 H1 | 居中 | 视觉焦点 |
| 行动类短引导（验证/重置/OTP） | 居中 | 与标题成组 |
| 业务/长正文、安全说明 | 左对齐 | 多行可读 |
| 主 CTA / OTP 块 | 居中 | 行动焦点 |
| 键值表 / 长备用 URL / 警示条 | 左对齐 | 扫描与复制 |
| 页脚系统声明 | 居中 | 次要收尾 |

字体：系统字体栈（不依赖 Orbitron 等 web font）。

---

## 6. API（呈现层，非 HTTP）

```ts
type MailTemplateKind =
  | 'email_verification'
  | 'password_reset'
  | 'provision_email_otp'
  | 'mail_delivery_test'
  | 'low_stock'
  | 'sla_overdue'
  | 'booking_reminder'
  | 'subscription_expiring'
  | 'subscription_expired'
  | 'provision_degraded'

function renderMail(kind: MailTemplateKind, vars: /* kind-specific */): MailMessage
// MailMessage: { to, subject, text, html }
```

`to` 由 vars 提供；`renderMail` 不发送、不访问网络、不读 DB。

---

## 7. 验收标准（可测试）

| ID | 验收 |
| --- | --- |
| A-01 | 每个 kind 的 `renderMail` 返回非空 `subject`、`text`、`html` |
| A-02 | 注入 `"><script>` 类字符串后，`html` 不含未转义 `<script` |
| A-03 | 验证/重置邮件 `html` 含 CTA `href` 与 text 中完整 URL |
| A-04 | OTP 邮件 text 与 html 均含 6 位码 |
| A-05 | 测试邮件内容仍无 token/订单；subject 仍为固定测试主题 |
| A-06 | 相关 vitest 全绿；既有 CaptureMailer 断言适配 `html` |
| A-07 | preview 脚本可为每个 kind 写出可打开的 `.html` 文件 |

---

## 8. 依赖与假设

| ID | 假设 |
| --- | --- |
| A-01 | 生产 `APP_BASE_URL` / `FRONTEND_ORIGIN` 可访问静态 `/brand/ledger-knot/*` |
| A-02 | 不新增 npm 依赖 |
| A-03 | 独立 worktree 与 `feat/email-templates-polish`；无 Prisma migration |
| A-04 | PR 目标 `develop` |
