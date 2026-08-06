# Spec：对象存储提供商控制台（默认 MinIO + 可逆云覆盖）

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-STORAGE-001 |
| 版本 | 1.0.0 |
| 日期 | 2026-08-06 |
| 状态 | Ready for Implementation |
| 产品 | MoNexus |
| 关联模块 | `server/src/lib/storage`、`server/src/modules/admin`、`src/components/admin/AdminStoragePanel.tsx`、`docker-compose.prod.yml` |

---

## 1. 背景

生产默认通过 Compose profile `selfhost-storage` 运行 MinIO，对象落在 VPS 磁盘卷。现有后端已用 **S3 兼容适配器**（`@aws-sdk/client-s3`）读写公有图片桶与私有交付桶，注释写明可对接 MinIO / AWS S3 / Cloudflare R2 / 阿里云 OSS。凭证与 endpoint 目前仅来自启动环境变量，变更需改部署并重启。

运营希望在**管理员后台**可视化配置外置对象存储（R2、OSS 等），同时保留本地 MinIO 作为冷启动与灾备底座。纯全局「active → fallback MinIO 双读」不适合作为长期路由策略：同 key 多副本、版本漂移与私有交付权限边界会出问题。

### 1.1 SDK 选型结论

| 提供商 | 接入方式 | 本规格决策 |
| --- | --- | --- |
| MinIO | 原生 S3 API | 使用现有 `@aws-sdk/client-s3` |
| Cloudflare R2 | S3 兼容 | 同上；`forcePathStyle` 按厂商文档预填 |
| 阿里云 OSS | S3 兼容模式 / 虚拟主机 | 同上；**不**引入 `ali-oss` SDK |
| 腾讯云 COS | S3 兼容 | 同上；**不**引入 `cos-nodejs-sdk-v5` |
| 自定义 S3 | 标准 SigV4 | 同上 |

单一 S3 客户端降低密钥面与依赖面；厂商差异收敛为 **preset（endpoint 提示、region、path-style）+ 探测用例**，而非多 SDK。

---

## 2. 目标与非目标

### 2.1 目标

1. **部署底座不可破**：env/Compose 始终提供可启动的 MinIO（或等价 S3）配置；无 DB 云配置时行为与今日一致。
2. **后台控制台**：展示当前底座诊断；支持外置提供商 **草稿 → 测试 → 验证 → 激活 → 回滚**。
3. **凭证安全**：AK/SK 加密落库、API 不回显、审计脱敏；主密钥仅 env。
4. **版本化激活**：配置发布带 `configVersion`；多实例通过版本号刷新客户端，而非“毁掉当前单例再碰运气重建”。
5. **对象绑定位置**：新写入对象登记 `providerConfigId + bucketRole + objectKey`；读取优先按对象绑定路由。
6. **env 熔断**：`STORAGE_CONFIG_SOURCE=env` 时强制仅用部署配置，忽略 DB active。

### 2.2 非目标（本版本）

1. 不实现完整历史对象迁移任务编排（Phase 4：复制 / checksum / 改归属）——仅预留模型与 API 占位说明。
2. 不默认开启双写；不把全局 active→MinIO 双读作为长期读路径。
3. 不引入应用层全量媒体反代（可在后续规格统一 media URL）。
4. 不在 `SystemConfig` 数值表中存密钥。
5. 不支持在 UI 中删除 env 底座或修改 Compose 内网 MinIO 根密钥（底座只读展示）。

---

## 3. 架构原则（硬约束）

| ID | 原则 |
| --- | --- |
| ARCH-01 | **部署配置永远是可启动、可恢复的底座。** |
| ARCH-02 | **存储配置切换是版本化基础设施发布，不是普通表单保存。** |
| ARCH-03 | **对象应绑定实际存储位置；不得长期依赖全局 active/fallback 猜测。** |

| ID | 规则 |
| --- | --- |
| ST-01 | 生产启动仍要求 env 的 `STORAGE_*` + 双桶守卫（既有 config 校验保留）。 |
| ST-02 | 公有桶名 ≠ 私有桶名；激活与测试均强制。 |
| ST-03 | 生产测试/激活的 endpoint 必须 HTTPS（自建 MinIO 经部署 allowlist 可放行 http+私网）。 |
| ST-04 | `credentialsCiphertext` 格式带 key version；解密失败不得回退明文猜测。 |
| ST-05 | 列表/详情 DTO 永不包含 secret、完整 accessKey；最多 `accessKeyLast4`。 |
| ST-06 | 同一时刻至多一个 `status=active` 的 `StorageProviderConfig`。 |
| ST-07 | 新上传（公有图 / 私有交付）成功后必须写入 `StoredObject`（或等价列）绑定 `providerConfigId`（env 底座时 `providerConfigId=null` 且 `legacySource=env`）。 |
| ST-08 | 读路径：有绑定 → 用该 provider 客户端；无绑定（历史数据）→ **legacy** 使用 env 底座（临时兼容，非永久双读）。 |
| ST-09 | `STORAGE_CONFIG_SOURCE=env` 时：禁止 activate（或激活被忽略），读写仅 env。 |
| ST-10 | 所有草稿保存、测试、激活、回滚、禁用写入 `AdminLog`，detail 无密钥。 |

---

## 4. 数据模型

### 4.1 `StorageProviderConfig`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | Int PK | |
| type | String | `r2` \| `oss` \| `cos` \| `s3_compatible`（UI 预设；底座 MinIO 不建此行，见 runtime 合成） |
| name | String | 管理员可读名称 |
| status | String | `draft` \| `verified` \| `active` \| `disabled` |
| configVersion | Int | 每次保存/验证递增；激活时写入 runtime |
| publicConfig | Json | 非机密：endpoint、region、publicBucket、privateBucket、publicUrlBase、deliveryPublicEndpoint、forcePathStyle、preset |
| credentialsCiphertext | String? | 加密后的 `{ accessKey, secretKey }` |
| credentialsKeyVersion | Int | 加密所用主密钥版本 |
| accessKeyLast4 | String? | 展示用 |
| lastTestAt / lastTestOk / lastTestSummary | | 最近探测结果（无敏感） |
| verifiedAt / activatedAt / disabledAt | DateTime? | |
| activatedById / createdById | Int? | User id |
| previousActiveId | Int? | 激活时记录被替换的配置 id，便于回滚 |
| createdAt / updatedAt | | |

### 4.2 `StorageRuntime`（单行 id=1）

| 列 | 说明 |
| --- | --- |
| activeConfigId | 当前 active 配置；null = 仅 env 底座 |
| configVersion | 与激活配置版本对齐；实例缓存比对用 |
| updatedAt | |

### 4.3 `StoredObject`

| 列 | 说明 |
| --- | --- |
| id | PK |
| providerConfigId | null = legacy env 底座 |
| bucketRole | `public` \| `private` |
| objectKey | 桶内 key |
| size / checksum / mimeType | 可选 |
| status | `active` \| `deleted` |
| source | `upload_image` \| `delivery_file` |
| sourceId | 可选业务 id（如 DeliveryFile.id） |
| createdAt / updatedAt | |

唯一性：`@@unique([bucketRole, objectKey, providerConfigId])` — PostgreSQL 中多个 NULL provider 视为互异，可接受；应用层对 env 路径用 `(bucketRole, objectKey)` 查询 legacy。

### 4.4 `DeliveryFile` 扩展

- 新增可选 `storageProviderId Int?`（冗余便于交付链路快速路由；与 StoredObject 同步写入）。
- 历史行 null = legacy env。

---

## 5. 凭证加密

```text
STORAGE_CREDENTIALS_ENC_KEY          # 64 hex = 32 bytes；生产 UI 写路径必填
STORAGE_CREDENTIALS_ENC_KEY_VERSION  # 正整数，默认 1
```

- 算法：AES-256-GCM，密文 `v{n}:<iv_hex>:<tag_hex>:<ct_hex>`（n = key version）。
- **不**复用 `WEBHOOK_SECRET_ENC_KEY` 字节，但可复用相同代码结构（独立模块 `storageCredentialsCrypto.ts`）。
- dev/test：缺省时由 `JWT_SECRET` 派生，便于单测；生产若启用 UI 写操作则必须显式主密钥。
- 备份恢复：解密失败应在控制台诊断中可见，不得拖到首次用户上传才暴露。

---

## 6. 运行时解析

```text
resolveWriteBackend(role):
  if STORAGE_CONFIG_SOURCE == env → env adapter
  if runtime.activeConfigId → DB config adapter (role → bucket)
  else → env adapter

resolveReadBackend(storedObject | legacy key):
  if object.providerConfigId → that config (even if no longer active)
  else → env adapter   // legacy only
```

客户端缓存：

- 进程内 map：`configId|version → adapter`。
- 每次 `getStorage` / `getDeliveryStorage`：若本地 `runtimeVersion` 落后于 DB（TTL ≤ 2s 或请求路径轻量读），则刷新。
- **禁止**激活时 `cached = null` 后无替代客户端窗口；应先建新客户端，CAS 切换指针，旧客户端可保留至 in-flight 结束（简单实现：双槽 previous/current）。

多实例：本版采用 **短 TTL 版本检查**；Redis Pub/Sub 为可选增强，不阻塞交付。激活用 DB 事务 + `UPDATE ... WHERE status='active'` 保证单 active，并用 runtime 行锁/条件更新 CAS。

---

## 7. 探测（测试连接）

前缀：`__monexus_probe__/{uuid}/`

最小能力（按桶角色）：

| 检查 | 公有桶 | 私有桶 |
| --- | --- | --- |
| Put / Head / Get / Delete 探测对象 | ✓ | ✓ |
| 预签名 GET（短 TTL）可下载 | 可选 | ✓ 必做 |
| 公有 URL（若配置 publicUrlBase）匿名可读 | ✓ | — |
| 私有对象匿名 URL 应失败 | — | ✓ |
| 两桶名不同 | ✓ | ✓ |

- 不强制整个桶的 List 权限（最小权限友好）。
- Range GET：若 SDK/后端已用完整 GET，本版记录为推荐项；大文件 multipart 依赖既有 `@aws-sdk/lib-storage` 时在探测中可选 put 小对象即可。
- 清理失败：`lastTestSummary` 含警告；不得静默残留无限增长（探测 key 固定前缀便于 GC）。

SSRF：

- 解析 hostname → IP；拒绝 loopback / link-local / metadata / 未允许的私网。
- 生产默认 HTTPS；禁止跟随到未校验目标的 redirect（AWS SDK 通常直连 endpoint）。
- 部署 `STORAGE_ENDPOINT_ALLOWLIST`（逗号分隔 hostname 后缀）可放行自建 MinIO。

---

## 8. API（均在 admin + MFA 路由组下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/storage/status` | 底座诊断 + runtime + UI 是否可写 |
| GET | `/api/admin/storage/providers` | 列表（脱敏） |
| POST | `/api/admin/storage/providers` | 创建 draft |
| PATCH | `/api/admin/storage/providers/:id` | 更新 draft/verified（不可改 active 的密钥以外字段时需重新 verified） |
| POST | `/api/admin/storage/providers/:id/test` | 探测；成功可升 `verified` |
| POST | `/api/admin/storage/providers/:id/activate` | 版本化激活 |
| POST | `/api/admin/storage/providers/:id/rollback` | 滚回 previousActive（若仍 verified/disabled 可恢复） |
| POST | `/api/admin/storage/providers/:id/disable` | 禁用非唯一灾备配置 |

### 8.1 Status DTO（白名单字段）

```json
{
  "uiConfigEnabled": true,
  "configSource": "database",
  "bootstrap": {
    "kind": "s3",
    "providerLabel": "MinIO / 环境变量底座",
    "endpointHost": "minio",
    "region": "us-east-1",
    "publicBucket": "monexus-uploads",
    "privateBucket": "monexus-files",
    "publicUrlBaseConfigured": true,
    "forcePathStyle": true,
    "healthy": true,
    "healthDetail": "ok"
  },
  "runtime": {
    "activeConfigId": null,
    "configVersion": 0,
    "writeTarget": "bootstrap"
  },
  "presets": [
    { "type": "r2", "label": "Cloudflare R2", "forcePathStyleDefault": true },
    { "type": "oss", "label": "阿里云 OSS", "forcePathStyleDefault": false },
    { "type": "cos", "label": "腾讯云 COS", "forcePathStyleDefault": false },
    { "type": "s3_compatible", "label": "自定义 S3 兼容", "forcePathStyleDefault": true }
  ]
}
```

---

## 9. 前端

- Admin 导航新增「对象存储」。
- `AdminStoragePanel`：底座卡片（只读）+ 提供商卡片（图标）+ 草稿表单 + 测试/激活/回滚。
- 密钥输入：password 型；编辑已有配置时 placeholder「不变则留空」。
- 图标：内联 SVG 简标（R2 / 阿里云 / 腾讯云 / S3 / MinIO），避免外链与品牌违规大图。
- 文案中文为主；品牌名可保留英文并附中文。

---

## 10. 环境变量增量

| 变量 | 说明 |
| --- | --- |
| `STORAGE_UI_CONFIG_ENABLED` | 默认 `true`；`false` 时 API 拒绝写、UI 只读 |
| `STORAGE_CONFIG_SOURCE` | `env` \| `database`（默认 `database`：允许 active 覆盖写路径） |
| `STORAGE_CREDENTIALS_ENC_KEY` | 64 hex；生产启用写时必填 |
| `STORAGE_CREDENTIALS_ENC_KEY_VERSION` | 默认 `1` |
| `STORAGE_ENDPOINT_ALLOWLIST` | 可选 hostname 后缀 allowlist |

既有 `STORAGE_*` / `DELIVERY_STORAGE_*` **不变**。

---

## 11. 分期与验收

### Phase 1 — 只读诊断

- [ ] status API + 面板展示底座与 writeTarget
- [ ] 无写库

### Phase 2 — 草稿与测试

- [ ] CRUD draft、加密凭证、test、verified
- [ ] 审计与 SSRF 校验
- [ ] 单测：加密往返、endpoint 拒绝内网、探测清理

### Phase 3 — 激活与对象绑定

- [ ] activate / rollback / runtime 版本
- [ ] 写路径走 active；`StoredObject` + DeliveryFile.storageProviderId
- [ ] 读：绑定优先；legacy → env
- [ ] 集成测试：激活后上传登记 provider；旧对象仍走 env

### Phase 4 — 迁移（非本 PR）

- 任务表、幂等复制、checksum、切换归属；可选短窗双写。

---

## 12. 测试计划

| 用例 | 期望 |
| --- | --- |
| 无 active 时上传图片 | StoredObject.providerConfigId null，URL 行为与线上一致 |
| 创建 R2 draft 缺私钥 | 400 |
| test 成功 | status verified，无密文泄漏 |
| activate 在 SOURCE=env | 403/400 熔断 |
| 双 admin 并发 activate | 仅一个 active |
| 解密错误主密钥 | status 诊断可见，不 500 堆栈泄密 |

---

## 13. 文档与运维

- 更新 `docs/operations/secrets-management.md` 增加 `STORAGE_CREDENTIALS_ENC_KEY*`。
- `server/.env.example` 注释示例。
- 本 spec 为唯一真相来源；实施计划见 `object-storage-provider-console.plan.md`。
