-- A question to the Review reviewer remembers what it pointed at (a finding, diff lines, a file).
ALTER TABLE "ChatMessage" ADD COLUMN "context" TEXT;
