-- CreateTable
CREATE TABLE "ReviewStack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoRoot" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "trunk" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "planPath" TEXT,
    "ownerUid" TEXT,
    "ownerKey" TEXT,
    "mergeMethod" TEXT NOT NULL DEFAULT 'merge',
    "state" TEXT NOT NULL DEFAULT 'open',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" INTEGER NOT NULL DEFAULT 0,
    "syncError" TEXT
);

-- CreateTable
CREATE TABLE "ReviewLayer" (
    "stackId" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL DEFAULT '',
    "headRef" TEXT NOT NULL DEFAULT '',
    "baseRef" TEXT NOT NULL DEFAULT '',
    "headSha" TEXT NOT NULL DEFAULT '',
    "baseSha" TEXT NOT NULL DEFAULT '',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "mergeable" TEXT,
    "checksJson" TEXT NOT NULL DEFAULT '{}',
    "needs" TEXT NOT NULL DEFAULT '',
    "currentRevId" INTEGER,
    "reviewedRevId" INTEGER,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "ownerUid" TEXT,
    "ownerKey" TEXT,

    PRIMARY KEY ("stackId", "pr")
);

-- CreateTable
CREATE TABLE "ReviewRevision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stackId" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "patchId" TEXT NOT NULL,
    "files" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "summaryAt" INTEGER,
    "verdictJson" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stackId" TEXT NOT NULL,
    "ownerPr" INTEGER NOT NULL,
    "foundOnPr" INTEGER NOT NULL,
    "revisionId" INTEGER,
    "messageId" INTEGER,
    "path" TEXT,
    "lineStart" INTEGER,
    "lineEnd" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'should',
    "source" TEXT NOT NULL DEFAULT 'you',
    "ghThread" TEXT,
    "ghUrl" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "dispatchId" INTEGER,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ReviewDispatch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stackId" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "targetUid" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "fromRevId" INTEGER,
    "fromHead" TEXT NOT NULL DEFAULT '',
    "queueId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'sent',
    "sawWork" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" INTEGER NOT NULL DEFAULT 0,
    "doneAt" INTEGER
);

-- CreateTable
CREATE TABLE "ReviewDecision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stackId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "fromPr" INTEGER,
    "at" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "ReviewRevision_stackId_pr_idx" ON "ReviewRevision"("stackId", "pr");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRevision_stackId_pr_baseSha_headSha_key" ON "ReviewRevision"("stackId", "pr", "baseSha", "headSha");

-- CreateIndex
CREATE INDEX "ReviewFinding_stackId_ownerPr_idx" ON "ReviewFinding"("stackId", "ownerPr");

-- CreateIndex
CREATE INDEX "ReviewDispatch_stackId_state_idx" ON "ReviewDispatch"("stackId", "state");

-- CreateIndex
CREATE INDEX "ReviewDecision_stackId_idx" ON "ReviewDecision"("stackId");

