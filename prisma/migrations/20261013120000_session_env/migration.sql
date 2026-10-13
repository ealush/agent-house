-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "envName" TEXT;

-- CreateTable
CREATE TABLE "EnvVar" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT true
);

