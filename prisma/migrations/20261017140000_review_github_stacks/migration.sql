-- A layer remembers the GitHub stack its PR is in, and where: GitHub merges it with the PRs under it.
ALTER TABLE "ReviewLayer" ADD COLUMN "ghStack" INTEGER;
ALTER TABLE "ReviewLayer" ADD COLUMN "ghPos" INTEGER;
