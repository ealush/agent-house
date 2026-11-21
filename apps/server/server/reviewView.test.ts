// The stack view, derived from rows: no database, no gh, no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewDispatch, ReviewFinding, ReviewLayer, ReviewRevision, ReviewStack } from '@prisma/client';
import { buildStackView, type StackContext, type StackRows } from './review/view.ts';
import type { SessionLite } from './review/service.ts';

const stack = (o: Partial<ReviewStack> = {}): ReviewStack => ({ id: 'st1', repoRoot: '/r', repo: 'me/r', trunk: 'main', title: 'S', planPath: null, ownerUid: null, ownerKey: null, mergeMethod: 'merge', source: 'tree', ghStack: null, originUid: null, originKey: null, state: 'open', createdAt: 0, syncedAt: 0, syncError: null, ...o });
const PASS = JSON.stringify({ pass: 2, fail: 0, pending: 0, failing: [] });
const layer = (pr: number, position: number, o: Partial<ReviewLayer> = {}): ReviewLayer => ({ stackId: 'st1', pr, position, role: '', state: 'open', title: `PR ${pr}`, url: '', author: 'me', headRef: `b${pr}`, baseRef: position === 0 ? 'main' : `b${pr - 1}`, headSha: `h${pr}`, baseSha: `s${pr}`, draft: false, mergeable: 'MERGEABLE', checksJson: PASS, needs: '', currentRevId: pr * 10, reviewedRevId: null, approved: false, ownerUid: null, ownerKey: null, ghStack: null, ghPos: null, ...o });
const rev = (id: number, pr: number, o: Partial<ReviewRevision> = {}): ReviewRevision => ({ id, stackId: 'st1', pr, baseSha: `s${pr}`, headSha: `h${pr}`, patchId: `p${pr}`, files: 1, additions: 1, deletions: 0, summary: null, summaryAt: null, verdictJson: null, createdAt: 0, ...o });
const finding = (id: number, ownerPr: number, o: Partial<ReviewFinding> = {}): ReviewFinding => ({ id, stackId: 'st1', ownerPr, foundOnPr: ownerPr, revisionId: null, messageId: null, path: null, lineStart: null, lineEnd: null, title: 't', body: '', severity: 'should', source: 'you', ghThread: null, ghUrl: null, state: 'open', stateBy: null, stateRevId: null, note: null, dispatchId: null, createdAt: 0, updatedAt: 0, ...o });
const ctx = (o: Partial<StackContext> = {}): StackContext => ({ sessions: [], natives: [], methods: ['merge'], syncing: false, ...o });
const rows = (o: Partial<StackRows>): StackRows => ({ layers: [], revs: [], findings: [], dispatches: [], decisions: [], ...o });

const gate = (v: ReturnType<typeof buildStackView>, pr: number, key: string) => v.layers.find((l) => l.pr === pr)!.gates.find((g) => g.key === key);

test('a layer’s status: unreviewed, changes, approved, rereview, fixing', () => {
  const two = [layer(1, 0), layer(2, 1)];
  const revs = [rev(10, 1), rev(20, 2)];
  assert.deepEqual(buildStackView(stack(), rows({ layers: two, revs }), ctx()).layers.map((l) => l.status), ['unreviewed', 'unreviewed']);
  assert.equal(buildStackView(stack(), rows({ layers: two, revs, findings: [finding(1, 2)] }), ctx()).layers[1].status, 'changes');
  const approved = [layer(1, 0, { approved: true, reviewedRevId: 10 }), layer(2, 1)];
  assert.equal(buildStackView(stack(), rows({ layers: approved, revs }), ctx()).layers[0].status, 'approved');
  // Pushed since the review: a new patch to look at.
  const pushed = [layer(1, 0, { approved: true, reviewedRevId: 9, currentRevId: 10 }), layer(2, 1)];
  const v = buildStackView(stack(), rows({ layers: pushed, revs: [rev(9, 1, { patchId: 'old' }), ...revs] }), ctx());
  assert.equal(v.layers[0].status, 'rereview');
  assert.equal(gate(v, 1, 'reviewed')?.detail, 'Changed since your review');
  // Rebased only (same patch, new head): still approved, and it says so.
  const rebased = buildStackView(stack(), rows({ layers: pushed, revs: [rev(9, 1, { headSha: 'older' }), ...revs] }), ctx());
  assert.equal(rebased.layers[0].status, 'approved');
  assert.equal(rebased.layers[0].rebased, true);
  assert.equal(gate(rebased, 1, 'reviewed')?.detail, 'Rebased since your review, same patch');
  const fixing = { id: 5, stackId: 'st1', pr: 2, targetUid: 'u1', targetKey: 'k', kind: 'fix', text: '', fromRevId: null, fromHead: '', queueId: null, state: 'working', sawWork: true, sentAt: 0, doneAt: null } satisfies ReviewDispatch;
  assert.equal(buildStackView(stack(), rows({ layers: two, revs, findings: [finding(1, 2)], dispatches: [fixing] }), ctx()).layers[1].status, 'fixing');
});

test('the gates to merging say what holds each layer back', () => {
  const v = buildStackView(
    stack(),
    rows({
      layers: [layer(1, 0, { mergeable: 'CONFLICTING' }), layer(2, 1, { draft: true, checksJson: JSON.stringify({ pass: 0, fail: 1, pending: 0, failing: ['lint'] }) }), layer(3, 2, { checksJson: '{}', baseRef: 'release' })],
      revs: [rev(10, 1), rev(20, 2), rev(30, 3)],
      findings: [finding(1, 2, { severity: 'blocking' }), finding(2, 2)],
    }),
    ctx(),
  );
  assert.deepEqual(gate(v, 1, 'mergeable'), { key: 'mergeable', ok: false, label: 'Mergeable', detail: 'Conflicts with main' });
  assert.deepEqual(gate(v, 2, 'mergeable'), { key: 'mergeable', ok: false, label: 'Draft', detail: 'Mark it ready first' });
  assert.equal(gate(v, 2, 'checks')?.detail, 'Failing: lint');
  assert.equal(gate(v, 2, 'findings')?.detail, '1 blocking');
  assert.equal(gate(v, 3, 'checks')?.detail, 'No checks reported');
  assert.equal(gate(v, 3, 'base')?.detail, 'Targets release');
  assert.deepEqual([gate(v, 1, 'order')?.ok, gate(v, 2, 'order')?.detail], [true, '#1 comes first']);
  assert.equal(v.next, 1);
});

test('a layer in a GitHub stack lands in the stack’s base, and needs the layers under it ready', () => {
  const natives = [{ number: 7, base: 'main', prs: [{ number: 1, open: true, merged: false }, { number: 2, open: true, merged: false }] }] as unknown as StackContext['natives'];
  const v = buildStackView(
    stack({ ghStack: 7 }),
    rows({ layers: [layer(1, 0, { ghStack: 7, ghPos: 1, mergeable: 'CONFLICTING', approved: true, reviewedRevId: 10 }), layer(2, 1, { ghStack: 7, ghPos: 2 })], revs: [rev(10, 1), rev(20, 2)] }),
    ctx({ natives }),
  );
  assert.deepEqual(gate(v, 2, 'base'), { key: 'base', ok: true, label: 'Lands in main', detail: undefined });
  const below = gate(v, 2, 'below')!;
  assert.equal(below.ok, false);
  assert.equal(below.detail, '#1 merges with it: conflicts with main');
  // It goes just before the order gate.
  assert.deepEqual(v.layers[1].gates.map((g) => g.key).slice(-2), ['below', 'order']);
  // A PR under it that this review doesn't hold.
  const outside = [{ number: 7, base: 'main', prs: [{ number: 9, open: true, merged: false }, { number: 1, open: true, merged: false }] }] as unknown as StackContext['natives'];
  const v2 = buildStackView(stack(), rows({ layers: [layer(1, 0, { ghStack: 7, ghPos: 2 })], revs: [rev(10, 1)] }), ctx({ natives: outside }));
  assert.equal(gate(v2, 1, 'below')?.detail, "#9 merges with it and isn't in this review");
});

test('the owner is resolved by the same rule dispatch uses; a gone one is an ended session', () => {
  const live: SessionLite = { uid: 'u2', key: 'claude:c1', title: 'Fixer', agent: 'claude', status: 'idle', cwd: '/r', branch: 'b1', live: true };
  const v = buildStackView(stack({ ownerUid: 'u1', ownerKey: 'claude:c1', originUid: 'gone', originKey: null }), rows({ layers: [layer(1, 0)], revs: [rev(10, 1)] }), ctx({ sessions: [live] }));
  assert.equal(v.owner?.uid, 'u2', 'the conversation, resumed under a new uid');
  assert.deepEqual(v.origin, { uid: 'gone', key: '', title: 'Ended session', agent: null, status: 'ended', live: false, branch: null });
});

test('findings left on a merged layer are follow-ups for the next open one', () => {
  const v = buildStackView(stack(), rows({ layers: [layer(1, 0, { state: 'merged' }), layer(2, 1)], revs: [rev(10, 1), rev(20, 2)], findings: [finding(1, 1), finding(2, 1, { state: 'addressed' })] }), ctx());
  assert.deepEqual(v.layers.map((l) => [l.pr, l.status, l.followups, l.gates.length]), [[1, 'merged', 0, 0], [2, 'unreviewed', 1, 6]]);
});
