CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'member',
  "disabled" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE TABLE "Session" (
  "digest" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "csrf" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" DATETIME NOT NULL,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE TABLE "Invitation" (
  "digest" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATETIME NOT NULL, "createdBy" TEXT NOT NULL, "usedAt" DATETIME
);
CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "actorId" TEXT, "action" TEXT NOT NULL, "targetId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
