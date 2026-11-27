// An agent that can't resume starts a conversation of its own, and ah lets go of the old id
// (layer: resume follows the new conversation). The old conversation must not come back to the
// window by adoption: its transcript can appear after the launch's snapshot of what already
// existed (Gemini 4 Neon's review) — here the old window's id came from its hooks, and its
// transcript is written only after the resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBed, windows, launch } from './fake-agents.ts';
import { cleanup, http, until } from './helpers.ts';
import { bedDir } from './fake-agents.ts';

test("a resume that starts anew never takes back the conversation it let go of", { timeout: 90_000 }, async () => {
  const { bin } = bedDir();
  const flag = join(bin, '..', 'no-hooks');
  // The stand-in Claude, without its hooks once the flag is there; no resume: it starts anew.
  const wrapper = join(bin, 'claude-anew');
  writeFileSync(wrapper, `#!/bin/sh\n[ -e '${flag}' ] && unset TMUX_PANE\nexec '${bin}/claude' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const ah = await startBed({ presets: [{ id: 'shell', name: 'Shell', command: '' }, { id: 'claude', name: 'Claude Code', command: wrapper, match: '^claude$', feed: 'claude' }] });
  try {
    const first = await launch(ah, 'claude', ah.project);
    const old: string = first.harnessId;
    assert.equal((await http(ah, 'DELETE', `/api/windows/${encodeURIComponent(first.id)}`)).status, 200);
    writeFileSync(flag, '');
    const resumed = await http(ah, 'POST', `/api/sessions/${first.uid}/resume`);
    assert.equal(resumed.status, 201, resumed.body);
    const anew = await until(async () => (await windows(ah)).find((w) => w.uid === first.uid && w.agent === 'claude'), 15_000, 'started anew');
    // Only now does the old conversation's transcript show up, in its folder.
    const cwd: string = anew.cwd;
    const dir = join(ah.dir, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${old}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: old, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'from before' } }) + '\n');
    await new Promise((r) => setTimeout(r, 6000));
    const w = (await windows(ah)).find((w) => w.uid === first.uid);
    assert.notEqual(w?.harnessId, old, 'the window took back the conversation it let go of');
  } finally {
    await cleanup(ah);
  }
});
