-- Keeping agents going through temporary failures (docs/spec/13-conductor.md, CND-5).
-- Additive: two new tables. Rollback: drop them (recovery history is lost; no session is touched).
-- CreateTable
CREATE TABLE "Recovery" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "uid" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" INTEGER,
    "resetsAt" INTEGER,
    "markJson" TEXT NOT NULL DEFAULT '{}',
    "lastAttemptJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "RecoveryEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "at" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "detail" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Recovery_state_nextAttemptAt_idx" ON "Recovery"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "RecoveryEvent_key_id_idx" ON "RecoveryEvent"("key", "id");

