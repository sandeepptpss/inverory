-- Optional collection scope for both sync paths. NULL keeps the existing
-- whole-catalog behaviour, so every existing row is already correct.
ALTER TABLE `TagAutomationSetting`
  ADD COLUMN `collectionId` VARCHAR(191) NULL,
  ADD COLUMN `collectionTitle` VARCHAR(191) NULL;

ALTER TABLE `BulkSyncJob`
  ADD COLUMN `collectionId` VARCHAR(191) NULL,
  ADD COLUMN `collectionTitle` VARCHAR(191) NULL;
