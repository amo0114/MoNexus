-- SPEC-STORAGE-001 ST-06: at most one active storage provider config
CREATE UNIQUE INDEX IF NOT EXISTS "storage_provider_one_active"
ON "StorageProviderConfig" (status)
WHERE status = 'active';
