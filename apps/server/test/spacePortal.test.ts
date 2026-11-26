import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpaceChiefBrief,
  chiefsInSpace,
  expandSpacePath,
  notesInSpace,
  sameSpacePath,
  unmanagedInSpace,
  workersOf,
} from '../web/spacePortal.ts';
import { canonicalProjectPath, inboxProjects, projectFolder } from '../web/inboxProject.ts';
import { rankSessions } from '../web/sessionRank.ts';
import type { Win } from '../web/api.ts';
import type { Note } from '../web/notes.ts';

const win = (partial: Partial<Win> & { uid: string; host: string; project: string }): Win =>
  ({
    id: '@1',
    key: `${partial.host}/${partial.uid}`,
    session: 'agents',
    index: 0,
    name: partial.uid,
    title: partial.title ?? partial.uid,
    agent: 'claude',
    harnessId: null,
    model: null,
    statusSource: 'activity',
    command: 'claude',
    cwd: '/home/me/spaces/Trips',
    projectPath: '/home/me/spaces/Trips',
    branch: null,
    worktree: false,
    status: 'idle',
    detail: null,
    ask: null,
    answerable: false,
    viewers: 0,
    devices: [],
    activity: 0,
    createdAt: 0,
    panes: 1,
    pinned: false,
    queued: 0,
    unsent: 0,
    order: null,
    launch: null,
    launchModel: null,
    launchEffort: null,
    launchMode: null,
    feed: null,
    fork: null,
    ...partial,
  }) as Win;

const note = (id: string, project: { host: string; path: string } | null): Note => ({
  id,
  title: id,
  markdown: '',
  project,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  version: 1,
  synced: 1,
  pending: null,
  conflict: null,
  deletedAt: null,
  exports: [],
  sessions: [],
  error: null,
});

test('expandSpacePath and sameSpacePath normalize tilde and trailing slashes', () => {
  assert.equal(expandSpacePath('~/spaces/Trips/', '/home/me'), '/home/me/spaces/Trips');
  assert.equal(expandSpacePath('/home/me/code/ah/', '/home/me'), '/home/me/code/ah');
  assert.equal(expandSpacePath('~', '/home/me'), '/home/me');
  assert.equal(expandSpacePath(null, '/home/me'), null);
  assert.equal(sameSpacePath('~/spaces/Trips', '/home/me/spaces/Trips/', '/home/me'), true);
  assert.equal(sameSpacePath('~/spaces/Trips', '/home/me/spaces/Work', '/home/me'), false);
  assert.equal(expandSpacePath('~/code/.worktrees/agent-house/claude-17fd', '/home/me'), '/home/me/code/agent-house');
  assert.equal(canonicalProjectPath('~/code/.worktrees/agent-house/claude-17fd'), '~/code/agent-house');
  const listed = inboxProjects(
    [{ project: 'agent-house', host: 'h1', projectPath: '~/code/.worktrees/agent-house/claude-17fd' }],
    [
      { project: 'claude-8a5d', host: 'h1', cwd: '~/code/.worktrees/agent-house/claude-8a5d' },
      { project: 'gemini-5d7b', host: 'h1', cwd: '~/code/.worktrees/agent-house/gemini-5d7b' },
      { project: 'home-ealush-.cache-ah-uploads', host: 'h1', cwd: '~/.cache/ah/uploads' },
    ],
    [{ project: 'Launch Q1', host: 'h1' }],
  );
  assert.deepEqual(
    listed.map((x) => x.name),
    ['agent-house', 'Launch Q1'],
  );
  assert.deepEqual(
    projectFolder({ name: 'agent-house', host: 'h1' }, [{ project: 'agent-house', host: 'h1', projectPath: '~/code/.worktrees/agent-house/claude-17fd' }], []),
    { cwd: '~/code/agent-house', host: 'h1' },
  );
});

test('notesInSpace isolates notes belonging to one Space on one host', () => {
  const list = [
    note('n1', { host: 'desk', path: '/home/me/spaces/Trips' }),
    note('n2', { host: 'desk', path: '/home/me/spaces/Trips/' }),
    note('n3', { host: 'mac', path: '/home/me/spaces/Trips' }),
    note('n4', { host: 'desk', path: '/home/me/spaces/Work' }),
    note('n5', null),
  ];
  assert.deepEqual(
    notesInSpace(list, 'desk', '~/spaces/Trips', '/home/me').map((n) => n.id),
    ['n1', 'n2'],
  );
});

test('chiefsInSpace supports multiple Chiefs of Staff per Space and tracks workers/unmanaged sessions', () => {
  const ws = [
    win({ uid: 'cos1', host: 'desk', project: 'Trips', supervision: { role: 'chief', space: 'Trips' } }),
    win({ uid: 'cos2', host: 'desk', project: 'Trips', supervision: { role: 'chief' } }),
    win({ uid: 'cos-other', host: 'desk', project: 'Work', supervision: { role: 'chief', space: 'Work' } }),
    win({ uid: 'w1', host: 'desk', project: 'Trips', supervision: { role: 'worker', managedBy: 'cos1' } }),
    win({ uid: 'w2', host: 'desk', project: 'Trips' }),
    win({ uid: 'w3', host: 'mac', project: 'Trips' }),
  ];

  assert.deepEqual(
    chiefsInSpace(ws, 'Trips', 'desk').map((w) => w.uid),
    ['cos1', 'cos2'],
  );
  assert.deepEqual(
    workersOf(ws, 'cos1', 'desk').map((w) => w.uid),
    ['w1'],
  );
  assert.deepEqual(
    unmanagedInSpace(ws, 'Trips', 'desk').map((w) => w.uid),
    ['w2'],
  );
});

test('buildSpaceChiefBrief includes Space name, folder, active sessions, and custom instructions', () => {
  const brief = buildSpaceChiefBrief({
    spaceName: 'Trips',
    spacePath: '/home/me/spaces/Trips',
    spaceKind: 'space',
    sessions: [{ uid: 'w1', title: 'Kyoto hotels', agent: 'claude', status: 'idle' }],
    customInstructions: 'Focus on rail passes first.',
  });
  assert.match(brief, /Chief of Staff for the "Trips" Space/);
  assert.match(brief, /\/home\/me\/spaces\/Trips/);
  assert.match(brief, /artifacts\//);
  assert.match(brief, /Kyoto hotels/);
  assert.match(brief, /Focus on rail passes first\./);
});

test('the # completion leads with the most recently active session', () => {
  const sessions = [
    win({ uid: 'chief-1', host: 'desk', project: 'Launch', supervision: { role: 'chief', space: 'Launch' } }),
    win({ uid: 'sub-1', host: 'desk', project: 'Launch', title: 'Copywriter', supervision: { role: 'worker', managedBy: 'chief-1' } }),
    win({ uid: 'peer-1', host: 'desk', project: 'Launch', title: 'Designer' }),
    win({ uid: 'other-1', host: 'desk', project: 'Ops', title: 'Infra Ops' }),
    win({ uid: 'other-2', host: 'desk', project: 'Ops', title: 'Release Notes', activity: 300 }),
    win({ uid: 'peer-2', host: 'desk', project: 'Launch', title: 'Researcher', activity: 200 }),
  ];
  // The most recent first, wherever it is; equally recent, its sub-sessions, then its Space's.
  assert.deepEqual(
    rankSessions(sessions, '', 'chief-1', 'Launch').map((i) => i.value),
    ['#other-2 ', '#peer-2 ', '#sub-1 ', '#peer-1 ', '#other-1 '],
  );
  assert.deepEqual(rankSessions(sessions, 'copy', 'chief-1', 'Launch').map((i) => [i.value, i.label]), [['#sub-1 ', 'Copywriter']]);
});
