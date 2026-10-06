-- CreateTable
CREATE TABLE "Session" (
    "uid" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "harness" TEXT NOT NULL DEFAULT '',
    "harnessId" TEXT,
    "cwd" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lifecycle" TEXT NOT NULL DEFAULT 'live',
    "pendingResume" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" INTEGER NOT NULL DEFAULT 0,
    "endedAt" INTEGER,
    "exitCode" INTEGER,
    "tmuxJson" TEXT,
    "metaJson" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uid" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "Prompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "ChatMessage_uid_id_idx" ON "ChatMessage"("uid", "id");
