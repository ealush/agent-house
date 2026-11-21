-- Scratchpads (docs/spec/15-scratchpads.md). Additive: two new tables. Rollback: drop
-- them (notes kept only on this host are lost; devices keep their own copies).
-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "markdown" TEXT NOT NULL DEFAULT '',
    "projectHost" TEXT,
    "projectPath" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "lastWriteId" TEXT,
    "writer" TEXT NOT NULL DEFAULT '',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" INTEGER,
    "exportsJson" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "NoteHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "target" TEXT NOT NULL,
    "textSha" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'sending',
    "queueId" TEXT,
    "resumed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE INDEX "Note_seq_idx" ON "Note"("seq");

-- CreateIndex
CREATE INDEX "NoteHandoff_noteId_idx" ON "NoteHandoff"("noteId");
