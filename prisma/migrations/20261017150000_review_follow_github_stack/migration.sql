-- A stack can follow a stack on GitHub (source "native"): its PRs join and keep GitHub's order.
ALTER TABLE "ReviewStack" ADD COLUMN "ghStack" INTEGER;
