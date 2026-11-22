-- Checkouts (docs/spec/18-checkouts.md): concurrent agent workspaces with
-- atomic exclusive writer ownership, runtime port allocation, integration
-- metadata, and lifecycle reclamation. Additive: one new table.
-- CreateTable
CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoRoot" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'worktree',
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "branch" TEXT,
    "baseSha" TEXT NOT NULL DEFAULT '',
    "baseBranch" TEXT NOT NULL DEFAULT '',
    "ownerUid" TEXT,
    "lifecycle" TEXT NOT NULL DEFAULT 'active',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "portStart" INTEGER,
    "portEnd" INTEGER,
    "tempDir" TEXT,
    "statusJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" INTEGER,
    "reclaimedAt" INTEGER
);

-- CreateIndex
CREATE UNIQUE INDEX "Checkout_path_key" ON "Checkout"("path");

-- CreateIndex
CREATE INDEX "Checkout_repoRoot_idx" ON "Checkout"("repoRoot");

-- CreateIndex
CREATE INDEX "Checkout_ownerUid_idx" ON "Checkout"("ownerUid");

-- CreateIndex
CREATE INDEX "Checkout_lifecycle_idx" ON "Checkout"("lifecycle");
