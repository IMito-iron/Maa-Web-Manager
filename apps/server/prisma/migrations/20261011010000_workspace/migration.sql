CREATE TABLE "GameAccount" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "label" TEXT NOT NULL,
  "matcher" TEXT NOT NULL, "verified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GameAccount_matcher_key" ON "GameAccount"("matcher");
CREATE INDEX "GameAccount_ownerId_idx" ON "GameAccount"("ownerId");
CREATE TABLE "ManagedTask" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "raw" TEXT NOT NULL, "version" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ManagedTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GameAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ManagedTask_ownerId_idx" ON "ManagedTask"("ownerId");
