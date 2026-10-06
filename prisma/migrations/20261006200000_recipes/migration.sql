-- CreateTable
CREATE TABLE "RecipeRun" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "host" TEXT NOT NULL DEFAULT '',
    "cwd" TEXT NOT NULL DEFAULT '',
    "brief" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "membersJson" TEXT NOT NULL DEFAULT '[]',
    "snapshotJson" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sourceUid" TEXT NOT NULL,
    "targetUid" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "repeat" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "armed" BOOLEAN NOT NULL DEFAULT false,
    "queueId" TEXT,
    "deliveredAt" INTEGER,
    "fires" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT
);

-- CreateIndex
CREATE INDEX "Handoff_runId_idx" ON "Handoff"("runId");
