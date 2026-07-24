import { z } from 'zod'

const passphrase = z.string().min(12, '备份口令至少 12 个字符').max(256, '备份口令过长')

export const createPortableBackupSchema = z.object({
  passphrase,
}).strict()

export const importPortableBackupSchema = z.object({
  passphrase,
  confirmation: z.literal('RESTORE_PORTABLE_BACKUP', {
    errorMap: () => ({ message: '请输入 RESTORE_PORTABLE_BACKUP 以确认导入' }),
  }),
}).strict()

export const portableBackupIdParamSchema = z.object({
  id: z.string().uuid('备份任务标识无效'),
})
