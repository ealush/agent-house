-- A stack remembers the agent session that made it.
ALTER TABLE "ReviewStack" ADD COLUMN "originUid" TEXT;
ALTER TABLE "ReviewStack" ADD COLUMN "originKey" TEXT;
