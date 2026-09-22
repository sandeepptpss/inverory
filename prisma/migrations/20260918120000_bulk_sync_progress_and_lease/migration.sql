-- Jobs written by the previous synchronous implementation use retired status
-- names and have no lease/progress columns; there is no safe way to resume them,
-- so close them out before the schema changes underneath them.
UPDATE `BulkSyncJob`
SET `status` = 'failed',
    `errorMessage` = 'Sync was interrupted by an app update. Please run it again.'
WHERE `status` IN ('querying', 'mutating_add', 'mutating_remove');

ALTER TABLE `BulkSyncJob`
  ADD COLUMN `addJsonlPath` TEXT NULL,
  ADD COLUMN `exported` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `total` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `mutationProcessed` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lockedBy` VARCHAR(191) NULL,
  ADD COLUMN `lockedUntil` DATETIME(3) NULL,
  ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lastProgressAt` DATETIME(3) NULL,
  ADD COLUMN `lastProgressCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `finishedAt` DATETIME(3) NULL;

CREATE INDEX `BulkSyncJob_status_idx` ON `BulkSyncJob`(`status`);
