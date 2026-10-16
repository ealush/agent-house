-- A stack is GitHub's chain under one PR ("tree") or the PRs you picked ("manual").
ALTER TABLE "ReviewStack" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tree';
-- A finding remembers who moved it to its state, and at which revision.
ALTER TABLE "ReviewFinding" ADD COLUMN "stateBy" TEXT;
ALTER TABLE "ReviewFinding" ADD COLUMN "stateRevId" INTEGER;
