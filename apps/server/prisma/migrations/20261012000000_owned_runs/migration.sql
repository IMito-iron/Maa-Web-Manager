ALTER TABLE "Run" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Run" ADD COLUMN "managedTaskId" TEXT;
CREATE TABLE "ManagedRun" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
 "taskName" TEXT NOT NULL, "snapshot" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued',
 "source" TEXT NOT NULL, "occurrence" TEXT, "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
 "delivered" BOOLEAN NOT NULL DEFAULT false, "reason" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "startedAt" DATETIME, "finishedAt" DATETIME
);
CREATE UNIQUE INDEX "ManagedRun_occurrence_key" ON "ManagedRun"("occurrence");
CREATE INDEX "ManagedRun_ownerId_createdAt_idx" ON "ManagedRun"("ownerId", "createdAt");
CREATE INDEX "ManagedRun_status_idx" ON "ManagedRun"("status");
CREATE TABLE "ManagedSchedule" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
 "name" TEXT NOT NULL, "type" TEXT NOT NULL, "expression" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "nextAt" DATETIME NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ManagedSchedule_ownerId_idx" ON "ManagedSchedule"("ownerId");
CREATE TABLE "RunCancellation" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
