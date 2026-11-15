// A session's companion shell. tmux owns its lifetime across viewers and daemon restarts;
// its private session name binds it to a stable registry uid without creating history rows.
import { expandHome } from './config.ts';
import { HttpError } from './http.ts';
import { procTree, withArgv } from './procs.ts';
import type { Registry } from './registry.ts';
import { terminalView, type AttachedTerminal } from './sessions.ts';
import * as t from './tmux.ts';

export class AttachedTerminals {
  private pending = new Map<string, Promise<unknown>>();

  private registry: Registry;
  private env: () => Promise<Record<string, string>>;

  constructor(registry: Registry, env: () => Promise<Record<string, string>>) {
    this.registry = registry;
    this.env = env;
  }

  private serial<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(uid) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.pending.set(uid, task);
    return task.finally(() => { if (this.pending.get(uid) === task) this.pending.delete(uid); });
  }

  async get(uid: string): Promise<AttachedTerminal | null> {
    if (!this.registry.get(uid)) throw new HttpError(404, 'session not found');
    const raw = (await t.listWindows()).find((w) => w.session === t.TERMINAL_PREFIX + uid);
    if (!raw) return null;
    const procs = await withArgv(await procTree(), [raw.panePid]);
    return terminalView(raw, procs);
  }

  open(uid: string, command?: string): Promise<AttachedTerminal> {
    return this.serial(uid, async () => {
      const owner = this.registry.get(uid);
      if (!owner) throw new HttpError(404, 'session not found');
      let terminal = await this.get(uid);
      if (!terminal) {
        // Ended sessions can still own a shell (for inspecting results after an agent exits).
        const cwd = owner.tmux ? (await t.listWindows()).find((w) => w.windowId === owner.tmux!.windowId)?.path : undefined;
        await t.createWindow({ session: t.TERMINAL_PREFIX + uid, cwd: cwd ?? expandHome(owner.cwd), name: 'terminal', env: await this.env() });
        // Shell startup may briefly run profile commands in the foreground. The first
        // snippet waits for its prompt instead of being refused as a running server.
        const until = Date.now() + 3000;
        do {
          await new Promise((r) => setTimeout(r, 100));
          terminal = await this.get(uid);
        } while (terminal?.busy && Date.now() < until);
      }
      if (!terminal) throw new HttpError(409, 'the terminal exited; open it again');
      if (command !== undefined) {
        if (terminal.busy) {
          throw new HttpError(409, 'The attached terminal is running a command. Stop it or wait for it to finish.', 'terminal_busy');
        }
        await t.pasteText(terminal.id, command, true);
        // Let the shell consume Enter before releasing the submission lock. A following
        // request checks the resulting foreground process, including for quiet servers.
        await new Promise((r) => setTimeout(r, 100));
      }
      return terminal;
    });
  }

  close(uid: string): Promise<void> {
    return this.serial(uid, async () => {
      const raw = (await t.listWindows()).find((w) => w.session === t.TERMINAL_PREFIX + uid);
      // Kill the shared window, not just its original session: each connected viewer
      // has a grouped session linking it, which would otherwise keep the process alive.
      if (raw) await t.killWindow(raw.windowId);
    });
  }
}
