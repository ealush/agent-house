// Secret-free MCP config file writer for Claude Code `--mcp-config`.
// Kept outside server/mcp.ts so the pure functional core reaches zero filesystem I/O.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ensures `<stateDir>/mcp/ah-mcp.json` exists for Claude Code `--mcp-config`.
 * Contains ZERO secrets: `ah mcp` inherits `AH_SESSION_UID`, `AH_SESSION_TOKEN`, `AH_PORT`,
 * `AH_SPACE*`, and `AH_ROLE` from the session process environment.
 */
export function ensureMcpConfigFile(stateDir: string, ahBinPath: string, nodePath: string = process.execPath): string {
  const dir = join(stateDir, 'mcp');
  const file = join(dir, 'ah-mcp.json');
  const desired = JSON.stringify(
    {
      mcpServers: {
        ah: {
          command: nodePath,
          args: [ahBinPath, 'mcp'],
        },
      },
    },
    null,
    2,
  ) + '\n';
  try {
    if (readFileSync(file, 'utf8') === desired) return file;
  } catch {}
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, desired, { mode: 0o600 });
  return file;
}
