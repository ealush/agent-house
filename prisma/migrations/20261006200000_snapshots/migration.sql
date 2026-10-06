-- CreateTable
CREATE TABLE "Snapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uid" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "commit" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'turn',
    "promptExcerpt" TEXT NOT NULL DEFAULT '',
    "branch" TEXT NOT NULL DEFAULT '',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "insertions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "skippedJson" TEXT NOT NULL DEFAULT '[]',
    "submodules" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_uid_turn_key" ON "Snapshot"("uid", "turn");

-- CreateIndex
CREATE INDEX "Snapshot_uid_turn_idx" ON "Snapshot"("uid", "turn");
