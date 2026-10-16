-- A stack is GitHub's chain under one PR ("tree") or the PRs you picked ("manual").
ALTER TABLE "ReviewStack" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tree';
