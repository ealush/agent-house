-- Full-text search (issue #9): FTS5 indexes over transcript entries and
-- side-chat messages, plus the per-source fingerprint table the incremental
-- builder uses. Prisma cannot model FTS5 virtual tables, so these live only
-- here and in server/search.ts (which also creates them if missing, and drops
-- them when the user disables content search). Only `text` is indexed; every
-- other column is a stored jump target or filter value.

-- CreateTable
CREATE TABLE IF NOT EXISTS "SearchSource" (
    "source" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT '',
    "ref" TEXT NOT NULL DEFAULT '',
    "sig" TEXT NOT NULL DEFAULT '',
    "last_key" INTEGER NOT NULL DEFAULT 0,
    "entries" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" INTEGER NOT NULL DEFAULT 0
);

-- CreateVirtualTable
CREATE VIRTUAL TABLE IF NOT EXISTS "transcript_fts" USING fts5(
    "text",
    "title" UNINDEXED, "uid" UNINDEXED, "ref" UNINDEXED, "harness" UNINDEXED, "harness_id" UNINDEXED,
    "cwd" UNINDEXED, "model" UNINDEXED, "seq" UNINDEXED, "role" UNINDEXED, "at" UNINDEXED
);

-- CreateVirtualTable
CREATE VIRTUAL TABLE IF NOT EXISTS "chat_fts" USING fts5(
    "text",
    "title" UNINDEXED, "uid" UNINDEXED, "msg_id" UNINDEXED, "role" UNINDEXED, "at" UNINDEXED
);
