-- CreateTable
CREATE TABLE `BulkSyncJob` (
    `shop` VARCHAR(191) NOT NULL,
    `tagName` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `queryBulkOperationId` VARCHAR(191) NULL,
    `addMutationBulkOperationId` VARCHAR(191) NULL,
    `removeMutationBulkOperationId` VARCHAR(191) NULL,
    `removeJsonlPath` TEXT NULL,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `toTag` INTEGER NOT NULL DEFAULT 0,
    `toUntag` INTEGER NOT NULL DEFAULT 0,
    `tagged` INTEGER NOT NULL DEFAULT 0,
    `untagged` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
