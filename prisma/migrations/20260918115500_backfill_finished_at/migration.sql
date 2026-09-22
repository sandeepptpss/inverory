-- Jobs that finished under the previous implementation have finishedAt NULL,
-- because the column did not exist when they were written. The UI then measures
-- their duration against "now", which grows for as long as the page is open.
-- updatedAt is the last time the job was actually touched, so it is the best
-- available stand-in for when it stopped.
UPDATE `BulkSyncJob`
SET `finishedAt` = `updatedAt`
WHERE `finishedAt` IS NULL
  AND `status` IN ('completed', 'failed', 'cancelled');
