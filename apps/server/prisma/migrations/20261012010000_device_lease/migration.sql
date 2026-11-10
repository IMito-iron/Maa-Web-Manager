CREATE TABLE "DeviceLease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedBy" TEXT,
  "revokedAt" DATETIME
);
CREATE INDEX "DeviceLease_ownerId_idx" ON "DeviceLease"("ownerId");
CREATE INDEX "DeviceLease_status_expiresAt_idx" ON "DeviceLease"("status", "expiresAt");
