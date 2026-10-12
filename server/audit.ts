// Screen-rule audit (F18): while hooks run, every prompt they report is also a
// test of the screen rules that sessions without hooks depend on. An agent's
// TUI changes with its releases; when a rule stops matching, hookless sessions
// that need you read as done. Each "waiting" episode a hook reports is checked
// against what the screen rules saw, and a miss is kept with its screen, so
// Settings → System can say the rules have drifted before it costs a prompt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type AuditMiss = { at: number; ask: string; screen: string };
export type HarnessAudit = { checked: number; missed: number; last?: AuditMiss };
export type AuditSummary = Record<string, HarnessAudit>;

const KEEP_SCREEN = 2000;

export class ScreenAudit {
  private open = new Map<string, { harness: string; saw: boolean; ask: string; screen: string }>();
  private totals: AuditSummary = {};
  private file: string | null;

  /** `file: null` keeps the counts in memory only (tests). */
  constructor(file: string | null = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'screen-audit.json')) {
    this.file = file;
    if (file) {
      try {
        this.totals = JSON.parse(readFileSync(file, 'utf8'));
      } catch {}
    }
  }

  /**
   * One tick of a waiting episode (keyed by window and hook time): did the
   * screen rules see the prompt? Any tick that sees it settles the episode.
   */
  observe(key: string, harness: string, sees: boolean, ask: string, screen: string) {
    const ep = this.open.get(key);
    if (ep) {
      ep.saw ||= sees;
      if (!ep.saw) ep.screen = screen;
    } else this.open.set(key, { harness, saw: sees, ask, screen });
  }

  /** Close every episode not observed this tick: its prompt is answered or gone. */
  sweep(live: Set<string>) {
    let changed = false;
    for (const [key, ep] of this.open) {
      if (live.has(key)) continue;
      this.open.delete(key);
      const t = (this.totals[ep.harness] ??= { checked: 0, missed: 0 });
      t.checked++;
      if (!ep.saw) {
        t.missed++;
        t.last = { at: Math.floor(Date.now() / 1000), ask: ep.ask, screen: ep.screen.slice(-KEEP_SCREEN) };
        console.warn(`screen rules missed a ${ep.harness} prompt its hook reported (${ep.ask}); hookless status for ${ep.harness} may read "done" while it waits`);
      }
      changed = true;
    }
    if (changed) this.save();
  }

  summary(): AuditSummary {
    return structuredClone(this.totals);
  }

  /** Start counting afresh (after fixing the rules, or a harness update). */
  reset() {
    this.totals = {};
    this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.totals), { mode: 0o600 });
    } catch (err) {
      console.warn('saving the screen audit failed:', err);
    }
  }
}

export const screenAudit = new ScreenAudit(process.env.AH_SCREEN_AUDIT === '0' ? null : undefined);
