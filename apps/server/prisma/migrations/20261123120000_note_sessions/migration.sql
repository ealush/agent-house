-- The sessions a note started or was handed to (docs/spec/15-scratchpads.md, SCR-9).
-- Additive: one column with a default. Rollback: drop it (the notes keep everything else).
-- AlterTable
ALTER TABLE "Note" ADD COLUMN "sessionsJson" TEXT NOT NULL DEFAULT '[]';
