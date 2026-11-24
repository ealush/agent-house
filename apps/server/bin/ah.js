#!/usr/bin/env node
// ah — see `ah help`. `serve` runs the daemon; `hooks` wires agent status hooks;
// everything else is a client of the running daemon (bin/cli.js).
const [cmd = 'serve', sub] = process.argv.slice(2);

if (cmd === 'serve' || cmd.startsWith('--')) {
  await import('../server/main.ts');
} else if (cmd === 'mcp') {
  await import('./ah-mcp.js');
} else if (cmd === 'hooks' && sub === 'install') {
  const hooks = await import('../server/hooks.ts');
  console.log(hooks.installClaude());
  console.log(hooks.installCodex());
} else if (cmd === 'hooks' && sub === 'uninstall') {
  const hooks = await import('../server/hooks.ts');
  console.log(hooks.uninstallClaude());
  console.log(hooks.uninstallCodex());
} else if (cmd === 'hooks' && sub === 'status') {
  const { claude, codex } = (await import('../server/hooks.ts')).hooksStatus();
  console.log(`Claude Code: ${claude.wired}/${claude.of} events (${claude.file})`);
  console.log(`Codex: ${codex.wired ? 'wired' : codex.otherNotify ? 'another notify program is set' : 'not wired'} (${codex.file})`);
} else {
  const { run } = await import('./cli.js');
  await run(cmd, process.argv.slice(3));
}
