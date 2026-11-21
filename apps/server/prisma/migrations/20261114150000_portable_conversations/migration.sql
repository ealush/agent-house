-- Portable conversations (docs/spec/13-conductor.md): conversation identity and lineage.
-- Additive only: new tables, no existing row or column changes. Rollback: drop both tables;
-- the transcripts they describe are the harnesses' own files and are untouched.
-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harness" TEXT NOT NULL,
    "harnessId" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "cwd" TEXT NOT NULL DEFAULT '',
    "sourceFile" TEXT NOT NULL DEFAULT '',
    "sourceBytes" INTEGER NOT NULL DEFAULT 0,
    "sourceSha" TEXT NOT NULL DEFAULT '',
    "docPath" TEXT,
    "docVersion" INTEGER NOT NULL DEFAULT 1,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ConversationLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'preparing',
    "parentId" TEXT NOT NULL,
    "childId" TEXT,
    "parentUid" TEXT,
    "childUid" TEXT,
    "fromHarness" TEXT NOT NULL,
    "toHarness" TEXT NOT NULL,
    "fromHost" TEXT NOT NULL DEFAULT '',
    "toHost" TEXT NOT NULL DEFAULT '',
    "checkpointLine" INTEGER,
    "checkpointBytes" INTEGER,
    "checkpointSha" TEXT,
    "limitationsJson" TEXT NOT NULL DEFAULT '[]',
    "detailJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_harness_harnessId_key" ON "Conversation"("harness", "harnessId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationLink_idempotencyKey_key" ON "ConversationLink"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ConversationLink_parentId_idx" ON "ConversationLink"("parentId");

-- CreateIndex
CREATE INDEX "ConversationLink_childId_idx" ON "ConversationLink"("childId");

-- CreateIndex
CREATE INDEX "ConversationLink_childUid_idx" ON "ConversationLink"("childUid");
