-- CreateTable
CREATE TABLE "MailboxMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromUid" TEXT,
    "toUid" TEXT NOT NULL,
    "threadId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "readAt" INTEGER,
    "ackedAt" INTEGER,
    "createdAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "FleetTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "ownerUid" TEXT,
    "assignedUid" TEXT,
    "space" TEXT,
    "checkoutId" TEXT,
    "dependsOnJson" TEXT NOT NULL DEFAULT '[]',
    "verifyCmd" TEXT,
    "lastVerifyJson" TEXT,
    "result" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "MailboxMessage_toUid_createdAt_idx" ON "MailboxMessage"("toUid", "createdAt");

-- CreateIndex
CREATE INDEX "MailboxMessage_threadId_idx" ON "MailboxMessage"("threadId");

-- CreateIndex
CREATE INDEX "FleetTask_status_idx" ON "FleetTask"("status");

-- CreateIndex
CREATE INDEX "FleetTask_assignedUid_idx" ON "FleetTask"("assignedUid");

-- CreateIndex
CREATE INDEX "FleetTask_space_idx" ON "FleetTask"("space");
