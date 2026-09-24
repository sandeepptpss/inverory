-- Shopify accepts tags and collection titles up to 255 characters, and the
-- settings form validates tag names against that limit. These columns were
-- created at Prisma's MySQL default of VARCHAR(191), so a 192–255 character tag
-- passed validation and then failed the database write with a generic
-- "Could not save the settings" error on every retry. Widening is lossless.
ALTER TABLE `TagAutomationSetting` MODIFY `tagName` VARCHAR(255) NOT NULL DEFAULT 'out-of-stock-hidden',
    MODIFY `collectionTitle` VARCHAR(255) NULL;

ALTER TABLE `BulkSyncJob` MODIFY `tagName` VARCHAR(255) NOT NULL,
    MODIFY `collectionTitle` VARCHAR(255) NULL;
