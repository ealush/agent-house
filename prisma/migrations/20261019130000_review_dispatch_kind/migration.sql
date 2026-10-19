-- What a message to the agent asked for: fixes (done when it pushes) or merging the stack (done when it lands).
ALTER TABLE "ReviewDispatch" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'fix';
