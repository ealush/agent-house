import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenProject, inboxProjects, inProject, projectLabel, storedProject } from '../web/inboxProject.ts';

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
