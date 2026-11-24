import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenProject, inboxProjects, inProject, projectFolder, projectLabel, storedProject } from '../web/inboxProject.ts';

const spaced = new Set(['desk']);

const live = [
  { project: 'orbit-api', host: 'desk' },
  { project: 'ah', host: 'desk' },
  { project: 'orbit-api', host: 'desk' },
  { project: 'Website', host: 'mac' },
];
const past = [
  { project: 'ah', host: 'desk' },
  { project: 'orbit-api', host: 'mac' },
  { project: 'archive', host: 'desk' },
  { project: '', host: 'desk' },
];

test('the projects are every live and past one, once each, by name, a project being a name on a host', () => {
  assert.deepEqual(inboxProjects(live, past), [
    { name: 'ah', host: 'desk' },
    { name: 'archive', host: 'desk' },
    { name: 'orbit-api', host: 'desk' },
    { name: 'orbit-api', host: 'mac' },
    { name: 'Website', host: 'mac' },
  ]);
  assert.deepEqual(inboxProjects([], []), []);
});

test('a session or conversation is in a project by its name and host; with none chosen, everything is', () => {
  const orbit = { name: 'orbit-api', host: 'desk' };
  assert.equal(inProject({ project: 'orbit-api', host: 'desk' }, orbit), true);
  assert.equal(inProject({ project: 'orbit-api', host: 'mac' }, orbit), false, "another machine's checkout is another project");
  assert.equal(inProject({ project: 'ah', host: 'desk' }, orbit), false);
  assert.equal(inProject({ project: 'ah', host: 'desk' }, null), true);
});

test('the host joins the label only with several hosts', () => {
  assert.equal(projectLabel({ name: 'orbit-api', host: 'mac' }, false), 'orbit-api');
  assert.equal(projectLabel({ name: 'orbit-api', host: 'mac' }, true), 'orbit-api — mac');
});

test('a stored choice comes back while its project is there, and falls back to all projects when it is gone', () => {
  const projects = inboxProjects(live, past);
  const stored = storedProject({ name: 'orbit-api', host: 'mac' });
  assert.deepEqual(chosenProject(stored, projects), { name: 'orbit-api', host: 'mac' });
  assert.equal(chosenProject(storedProject({ name: 'gone', host: 'desk' }), projects), null);
  assert.equal(chosenProject('', projects), null);
  assert.equal(chosenProject('not json', projects), null);
  assert.equal(storedProject(null), '');
});

test("a new session in a project starts in a live session's project folder, else its newest conversation's", () => {
  const orbit = { name: 'orbit-api', host: 'mac' };
  const windows = [
    { project: 'orbit-api', host: 'desk', projectPath: '/desk/orbit-api' },
    { project: 'orbit-api', host: 'mac', projectPath: '/Users/me/orbit-api' },
  ];
  const history = [
    { project: 'orbit-api', host: 'mac', cwd: '/Users/me/orbit-api/old', at: 1 },
    { project: 'orbit-api', host: 'mac', cwd: '/Users/me/orbit-api/new', at: 2 },
    { project: 'ah', host: 'mac', cwd: '/Users/me/ah', at: 3 },
  ];
  assert.deepEqual(projectFolder(orbit, windows, history), { cwd: '/Users/me/orbit-api', host: 'mac' });
  assert.deepEqual(projectFolder(orbit, [], history), { cwd: '/Users/me/orbit-api/new', host: 'mac' });
  assert.equal(projectFolder({ name: 'gone', host: 'mac' }, windows, history), null);
});

test("the menu's Spaces: an empty plain Space is one too, once, among the rest by name", () => {
  const got = inboxProjects([{ project: 'ah', host: 'mac' }], [{ project: 'Trips', host: 'mac' }], [{ project: 'Trips', host: 'mac' }, { project: 'Books', host: 'mac' }]);
  assert.deepEqual(got.map((p) => p.name), ['ah', 'Books', 'Trips']);
});

test('what Remove says, before it does it: hidden, not deleted, and what happens to the files', async () => {
  const { removalText } = await import('../web/spaces.ts');
  assert.match(removalText({ kind: 'space', conversations: 3, path: '~/spaces/Trips' }), /^Takes its 3 conversations out of the Inbox and History\. Its folder moves to the Spaces archive/);
  assert.match(removalText({ kind: 'repo', conversations: 1, path: '~/code/ah' }), /its conversation .*The repository \(~\/code\/ah\) isn't touched\./);
  assert.match(removalText({ kind: 'folder', conversations: 0, path: null }), /^Takes it out .*The folder isn't touched\. Nothing is deleted/);
});

test("on a spaces 3 host the entries are its Spaces, then Not in a Space; a repository, a worktree or a cache never is one", () => {
  const windows = [
    { project: 'agent-house', space: 'Agent House', host: 'desk', projectPath: '~/code/agent-house' },
    { project: 'claude-17fd', host: 'desk', projectPath: '~/code/.worktrees/agent-house/claude-17fd' },
    { project: 'orbit-api', host: 'mac', projectPath: '/Users/me/orbit-api' },
  ];
  const history = [{ project: 'home-me-.cache-ah', host: 'desk', cwd: '~/.cache/ah/x', at: 1 }];
  const made = [
    { project: 'Trips', host: 'desk' },
    { project: 'Agent House', host: 'desk' },
  ];
  assert.deepEqual(inboxProjects(windows, history, made, spaced), [
    { name: 'Agent House', host: 'desk' },
    { name: 'orbit-api', host: 'mac' },
    { name: 'Trips', host: 'desk' },
    { name: '', host: 'desk' },
  ], "an older host ('mac') keeps its projects");
  assert.deepEqual(inboxProjects([windows[0]], [], made, spaced), [
    { name: 'Agent House', host: 'desk' },
    { name: 'Trips', host: 'desk' },
  ], 'Not in a Space only when something is in none');
  const none = { name: '', host: 'desk' };
  assert.equal(inProject(windows[1], none, spaced), true);
  assert.equal(inProject(windows[0], none, spaced), false);
  assert.equal(inProject(windows[0], { name: 'Agent House', host: 'desk' }, spaced), true);
  assert.equal(inProject({ project: 'Agent House', host: 'desk' }, { name: 'Agent House', host: 'desk' }, spaced), false, 'its project named like a Space is no matter');
  assert.equal(projectLabel(none, false), 'Not in a Space');
  assert.equal(projectLabel(none, true), 'Not in a Space — desk');
  assert.deepEqual(chosenProject(storedProject(none), inboxProjects(windows, history, made, spaced)), none, 'the choice is kept');
});

test("New session's Space follows its folder: an attached project's (a worktree's is its repository's), the Space's own folder's, or none; it sends only a different choice", async () => {
  const { attachedSpaceFor, spaceToSend, knownProjects } = await import('../web/spaces.ts');
  const spaces = [
    { name: 'Agent House', path: '~/spaces/Agent House', projects: ['~/code/agent-house', '~/code/ah-native'] },
    { name: 'Trips', path: '~/spaces/Trips', projects: [] },
  ];
  const home = '/home/me';
  assert.equal(attachedSpaceFor(spaces, '~/code/agent-house', home), 'Agent House');
  assert.equal(attachedSpaceFor(spaces, '/home/me/code/agent-house/apps/server', home), 'Agent House', 'below a project');
  assert.equal(attachedSpaceFor(spaces, '~/code/.worktrees/agent-house/claude-17fd', home), 'Agent House', "a worktree is its repository's");
  assert.equal(attachedSpaceFor(spaces, '~/spaces/Trips', home), 'Trips', "the Space's own folder");
  assert.equal(attachedSpaceFor(spaces, '~/code/agent-house-old', home), null, 'a sibling with a longer name is another project');
  assert.equal(attachedSpaceFor(spaces, '', home), null);
  assert.equal(spaceToSend('Agent House', 'Agent House'), undefined, 'the folder puts it there anyway');
  assert.equal(spaceToSend('Trips', 'Agent House'), 'Trips');
  assert.equal(spaceToSend('', 'Agent House'), '', 'no Space, though the folder has one');
  assert.equal(spaceToSend('', null), undefined);
  assert.deepEqual(
    knownProjects(['~/code/ah', '~/code/.worktrees/ah/claude-1234', '~/spaces/Trips', '~/.cache/ah/x', null, '~/code/Zed/'], '~/spaces', ['~/code/taken']),
    ['~/code/ah', '~/code/Zed'],
  );
});
