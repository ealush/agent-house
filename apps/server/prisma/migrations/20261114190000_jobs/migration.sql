-- Scheduled and conditional agent work (docs/spec/13-conductor.md, CND-4). Additive: two new
-- tables. Rollback: drop them (pending jobs are lost; no session or transcript is touched).
-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'scheduled',
    "actionJson" TEXT NOT NULL,
    "triggerJson" TEXT NOT NULL,
    "policyJson" TEXT NOT NULL DEFAULT '{}',
    "nextRunAt" INTEGER,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "armedAt" INTEGER NOT NULL DEFAULT 0,
    "sawBusyAt" INTEGER,
    "lastFiredAt" INTEGER,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'eligible',
    "idempotencyKey" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "scheduledFor" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "owner" TEXT,
    "leaseUntil" INTEGER,
    "sessionUid" TEXT,
    "deliveryJson" TEXT NOT NULL DEFAULT '{}',
    "outcomeJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" INTEGER,
    "endedAt" INTEGER,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "Job_state_nextRunAt_idx" ON "Job"("state", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_state_idx" ON "JobRun"("state");

-- CreateIndex
CREATE INDEX "JobRun_jobId_idx" ON "JobRun"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_jobId_seq_key" ON "JobRun"("jobId", "seq");

