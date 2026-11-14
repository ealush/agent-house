-- Usage telemetry (docs/spec/13-conductor.md, CND-6). Additive: three new tables. Rollback: drop
-- them (the counts are re-read from the transcripts on the next pass, within retention).
-- CreateTable
CREATE TABLE "UsageDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "convKey" TEXT NOT NULL,
    "uid" TEXT,
    "harness" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" REAL NOT NULL DEFAULT 0,
    "outputTokens" REAL NOT NULL DEFAULT 0,
    "cacheReadTokens" REAL NOT NULL DEFAULT 0,
    "cacheWriteTokens" REAL NOT NULL DEFAULT 0,
    "reasoningTokens" REAL NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "UsageCursor" (
    "file" TEXT NOT NULL PRIMARY KEY,
    "offset" REAL NOT NULL DEFAULT 0,
    "ino" REAL NOT NULL DEFAULT 0,
    "stateJson" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "RateLimitSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "harness" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "usedPercent" REAL,
    "windowMinutes" INTEGER,
    "resetsAt" INTEGER,
    "source" TEXT NOT NULL,
    "observedAt" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "UsageDaily_day_idx" ON "UsageDaily"("day");

-- CreateIndex
CREATE INDEX "UsageDaily_convKey_idx" ON "UsageDaily"("convKey");

-- CreateIndex
CREATE INDEX "RateLimitSample_harness_window_observedAt_idx" ON "RateLimitSample"("harness", "window", "observedAt");

