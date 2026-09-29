-- Opt-in status rules (out of stock -> UNLISTED, restocked -> ACTIVE). Every
-- column defaults to "off" / zero, so existing shops and existing job rows keep
-- exactly the behaviour they had before.
ALTER TABLE `TagAutomationSetting`
  ADD COLUMN `statusRulesEnabled` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `BulkSyncJob`
  ADD COLUMN `statusRulesEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `unlistMutationBulkOperationId` VARCHAR(191) NULL,
  ADD COLUMN `activateMutationBulkOperationId` VARCHAR(191) NULL,
  ADD COLUMN `unlistJsonlPath` TEXT NULL,
  ADD COLUMN `activateJsonlPath` TEXT NULL,
  ADD COLUMN `toUnlist` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `toActivate` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `unlisted` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `activated` INTEGER NOT NULL DEFAULT 0;
