-- 复审 P2-4：订阅到期拒绝在审计里必须与窗口拒绝可区分（仲裁"付费期内
-- 无法下载"投诉时，两种规则的拒绝不可混淆）。
ALTER TABLE "FileGrantLog"
  DROP CONSTRAINT "FileGrantLog_outcome_allowed_check";
ALTER TABLE "FileGrantLog"
  ADD CONSTRAINT "FileGrantLog_outcome_allowed_check"
    CHECK ("outcome" IN ('granted', 'denied_state', 'denied_window', 'denied_revoked', 'denied_subscription'));
