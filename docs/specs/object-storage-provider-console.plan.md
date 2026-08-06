# Plan：对象存储提供商控制台（SPEC-STORAGE-001 v1.0.0）

配套 spec：`docs/specs/object-storage-provider-console.md`。分支自 `develop`，PR 目标 `develop`。

## 实施顺序

1. Prisma migration：`StorageProviderConfig` / `StorageRuntime` / `StoredObject` + `DeliveryFile.storageProviderId`
2. `storageCredentialsCrypto` + endpoint SSRF 校验 + provider presets
3. Runtime 解析器改造 `getStorage` / `getDeliveryStorage`（版本缓存、写/读分离）
4. Probe 模块 + admin storage service/routes/controller/schema
5. 上传与交付登记 `StoredObject`
6. 前端 `AdminStoragePanel` + API client + 导航
7. 单测 + 关键路径集成测
8. env.example / secrets-management 文档补丁

## 非本 PR

- Phase 4 迁移 worker
- Redis 配置变更广播
- 统一 media 反代域名
