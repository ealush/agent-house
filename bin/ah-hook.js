#!/usr/bin/env node
// The agent status hook at its old path. Claude Code settings and Codex's notify written by
// `ah hooks install` before the server moved to apps/server name this file by absolute path;
// it runs the real hook, apps/server/bin/ah-hook.js. Reinstalling the hooks points them there.
// Like the hook itself, it never fails loudly: a broken hook must not break the agent.
try {
  await import('../apps/server/bin/ah-hook.js');
} catch {
  process.exit(0);
}
