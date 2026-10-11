// ah as a desktop app: a launcher entry (SUPER+SPACE on Omarchy) that opens ah
// in its own app window. Shared by `ah setup desktop` and Settings → System.
// On Omarchy it goes through omarchy-webapp-install, so it looks and behaves
// like every other web app there (removable from Omarchy's menu too);
// elsewhere it writes a plain freedesktop entry that opens the default browser.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'ah';
const ICON = fileURLToPath(new URL('../web/public/icon-512.png', import.meta.url));
const appsDir = () => join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'applications');
const entry = () => join(appsDir(), `${NAME}.desktop`);
const onPath = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

export type DesktopStatus = { installed: boolean; omarchy: boolean; url: string; file: string; bind: string };

/**
 * The address the app window opens: this machine's tailnet name when
 * `tailscale serve` publishes ah there (passkeys are bound to it), else loopback.
 */
export function appUrl(port: number): string {
  try {
    const status = JSON.parse(spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }).stdout || '{}');
    const name = String(status?.Self?.DNSName ?? '').replace(/\.$/, '');
    const serve = JSON.parse(spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 3000 }).stdout || '{}');
    const web = serve?.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy;
    if (name && typeof web === 'string' && web.endsWith(`:${port}`)) return `https://${name}`;
  } catch {}
  return `http://localhost:${port}`;
}

export function desktopStatus(port: number): DesktopStatus {
  const url = appUrl(port);
  const omarchy = onPath('omarchy-webapp-install');
  return {
    installed: existsSync(entry()),
    omarchy,
    url,
    file: entry(),
    // A Hyprland binding to paste into ~/.config/hypr/bindings.conf (ah never edits it).
    bind: `bindd = SUPER ALT, A, ah, exec, ${omarchy ? `omarchy-launch-webapp "${url}"` : `xdg-open "${url}"`}`,
  };
}

/** Returns what happened, one line each, for the CLI and the Settings card. */
export function installDesktop(port: number): string[] {
  const url = appUrl(port);
  if (onPath('omarchy-webapp-install')) {
    const r = spawnSync('omarchy-webapp-install', [NAME, url, ICON], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'omarchy-webapp-install failed').trim());
    return [`Added ah to the app launcher (SUPER+SPACE), opening ${url} in its own window.`];
  }
  const icons = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'icons', 'hicolor', '512x512', 'apps');
  mkdirSync(icons, { recursive: true });
  copyFileSync(ICON, join(icons, `${NAME}.png`));
  mkdirSync(appsDir(), { recursive: true });
  writeFileSync(entry(), ['[Desktop Entry]', 'Version=1.0', 'Type=Application', 'Name=ah', 'Comment=Agent hub', `Exec=xdg-open "${url}"`, `Icon=${NAME}`, 'Terminal=false', 'StartupNotify=true', ''].join('\n'), { mode: 0o755 });
  return [`Added ${entry()}, opening ${url}.`];
}

export function removeDesktop(): string[] {
  if (!existsSync(entry())) return ['ah was not in the app launcher.'];
  if (onPath('omarchy-webapp-remove')) {
    const r = spawnSync('omarchy-webapp-remove', [NAME], { encoding: 'utf8' });
    if (r.status === 0 && !existsSync(entry())) return ['Removed ah from the app launcher.'];
  }
  rmSync(entry(), { force: true });
  return ['Removed ah from the app launcher.'];
}
