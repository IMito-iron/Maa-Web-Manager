CREATE TABLE "Run" ("id" TEXT NOT NULL PRIMARY KEY,"task" TEXT NOT NULL,"hash" TEXT NOT NULL,"snapshot" TEXT NOT NULL,"status" TEXT NOT NULL,"source" TEXT NOT NULL,"scheduleId" TEXT,"occurrence" TEXT,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"startedAt" DATETIME,"finishedAt" DATETIME,"exitCode" INTEGER,"reason" TEXT,"pid" INTEGER);
CREATE UNIQUE INDEX "Run_occurrence_key" ON "Run"("occurrence");
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status","createdAt");
CREATE TABLE "Schedule" ("id" TEXT NOT NULL PRIMARY KEY,"name" TEXT NOT NULL,"task" TEXT NOT NULL,"type" TEXT NOT NULL,"expression" TEXT NOT NULL,"enabled" BOOLEAN NOT NULL DEFAULT true,"nextAt" DATETIME NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "Setting" ("key" TEXT NOT NULL PRIMARY KEY,"value" TEXT NOT NULL);
