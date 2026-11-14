-- Moving stopped sessions between hosts (docs/spec/13-conductor.md, CND-3). Additive: one new
-- table. Rollback: drop it; transcripts already moved stay where they landed (harness files).
-- CreateTable
CREATE TABLE "Migration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "peer" TEXT NOT NULL,
    "sourceUid" TEXT,
    "destUid" TEXT,
    "harness" TEXT NOT NULL,
    "harnessId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "sourceCwd" TEXT NOT NULL DEFAULT '',
    "destCwd" TEXT,
    "manifestJson" TEXT NOT NULL DEFAULT '{}',
    "preflightJson" TEXT NOT NULL DEFAULT '{}',
    "progressJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "Migration_idempotencyKey_key" ON "Migration"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Migration_role_state_idx" ON "Migration"("role", "state");

