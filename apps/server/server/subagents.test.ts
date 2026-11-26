import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilities, claudeRef, claudeState, codexState, geminiState, orderTree, parseClaudeRef, runningBelow, summarize, type SubagentView, type TailFacts } from './subagents/model.ts';
import { outcomesOf, parseMeta, tailFacts } from './subagents/claude.ts';
import { codexTail } from './subagents/codex.ts';
import { SubagentService } from './subagents/service.ts';
import { claudeFolder } from './subagents/store.ts';
import { parseClaudeSubagentLine, parseClaudeLine } from './feed/adapters/claude.ts';
import { TranscriptFeed, ADAPTERS } from './feed/feed.ts';

const SID = '421cdc16-e954-4057-b7ac-96c5335f2256';
const live = { live: true, since: 1000 };
const gone = { live: false, since: 0 };
const tail = (o: Partial<TailFacts> = {}): TailFacts => ({ lastAt: 2000, final: false, error: false, interrupted: false, activity: null, ...o });

// ---------- identity

test('a claude child ref is the session and the agent, and nothing else parses as one', () => {
  const ref = claudeRef(SID, 'a5e458ae8133f318e');
  assert.equal(ref, `claude:${SID}:a5e458ae8133f318e`);
  assert.deepEqual(parseClaudeRef(ref), { sessionId: SID, agentId: 'a5e458ae8133f318e' });
  for (const bad of [`claude:${SID}`, `claude:${SID}:../x`, `claude:${SID}:a/b`, `codex:${SID}:a1`, 'claude:abc:a1', `claude:${SID}:a1:b2`]) assert.equal(parseClaudeRef(bad), null, bad);
});

// ---------- lifecycle

test('claude: the parent record decides, then the child, then whether anything still runs it', () => {
  const s = (o: Partial<Parameters<typeof claudeState>[0]>) => claudeState({ background: false, outcomes: [], tail: tail(), root: live, runningChildren: 0, ...o }).state;
  assert.equal(s({}), 'running');
  assert.equal(s({ outcomes: [{ kind: 'result', status: 'completed', isError: false, interrupted: false, at: 2100 }] }), 'completed');
  assert.equal(s({ outcomes: [{ kind: 'result', status: null, isError: true, interrupted: false, at: 2100 }] }), 'failed');
  assert.equal(s({ outcomes: [{ kind: 'result', status: null, isError: false, interrupted: true, at: 2100 }] }), 'canceled');
  // A background child's acknowledgement is not its ending; its notification is.
  const ack = { kind: 'result' as const, status: 'async_launched', isError: false, interrupted: false, at: 1500 };
  assert.equal(s({ background: true, outcomes: [ack] }), 'running');
  assert.equal(s({ background: true, outcomes: [ack, { kind: 'notification', status: 'completed', at: 2100 }] }), 'completed');
  assert.equal(s({ background: true, outcomes: [ack, { kind: 'notification', status: 'failed', at: 2100 }] }), 'failed');
  assert.equal(s({ background: true, outcomes: [ack, { kind: 'notification', status: 'killed', at: 2100 }] }), 'canceled');
  // Its own work done, its children still working.
  assert.equal(s({ outcomes: [{ kind: 'result', status: 'completed', isError: false, interrupted: false, at: 2100 }], runningChildren: 2 }), 'waiting');
});

test("claude: a dropped connection or an ended parent is not proof a child finished", () => {
  const s = (o: Partial<Parameters<typeof claudeState>[0]>) => claudeState({ background: false, outcomes: [], tail: tail(), root: gone, runningChildren: 0, ...o });
  assert.deepEqual(s({}), { state: 'unknown', endedAt: null });
  // Nothing more will be written: what it ended on is what it did.
  assert.equal(s({ tail: tail({ final: true }) }).state, 'completed');
  assert.equal(s({ tail: tail({ error: true }) }).state, 'failed');
  assert.equal(s({ tail: tail({ interrupted: true }) }).state, 'canceled');
  // The root runs again (resumed), but this child was last written by an earlier process.
  assert.equal(claudeState({ background: true, outcomes: [], tail: tail({ lastAt: 500 }), root: { live: true, since: 5000 }, runningChildren: 0 }).state, 'unknown');
  // While the root runs, a text line is not an ending: a tool call may follow in the same message.
  assert.equal(claudeState({ background: false, outcomes: [], tail: tail({ final: true }), root: live, runningChildren: 0 }).state, 'running');
});

test('codex: a thread ends each turn in its own rollout, and can be given another', () => {
  const s = (last: Parameters<typeof codexState>[0]['last'], root = live) => codexState({ last, tail: tail(), root, runningChildren: 0 }).state;
  assert.equal(s({ kind: 'started', at: 2000 }), 'running');
  assert.equal(s({ kind: 'complete', at: 2000 }), 'completed');
  assert.equal(s({ kind: 'aborted', at: 2000 }), 'canceled');
  assert.equal(s({ kind: 'error', at: 2000 }, gone), 'failed');
  assert.equal(s({ kind: 'started', at: 2000 }, gone), 'unknown');
  assert.equal(codexState({ last: { kind: 'complete', at: 2000 }, tail: tail(), root: live, runningChildren: 1 }).state, 'waiting');
});

test('capabilities say only what ah can carry out', () => {
  assert.deepEqual(capabilities('claude', 'running', true), { transcript: true, live: true, send: false, cancel: false, continue: false });
  assert.deepEqual(capabilities('claude', 'completed', false), { transcript: true, live: false, send: false, cancel: false, continue: false });
  assert.equal(capabilities('codex', 'completed', true).continue, false, 'not while its tree runs');
  assert.equal(capabilities('codex', 'completed', false).continue, true);
  assert.equal(capabilities('codex', 'unknown', false).continue, true);
});

// ---------- the tree

const node = (ref: string, parentRef: string, startedAt: number, o: Partial<SubagentView> = {}): SubagentView => ({
  ref, harness: 'claude', agentId: ref, parentRef, rootRef: 'root', depth: 1, name: ref, role: null, prompt: null, state: 'running', background: false,
  startedAt, updatedAt: startedAt, endedAt: null, activity: null, toolCallId: null, capabilities: capabilities('claude', 'running', true), ...o,
});

test('the tree: parents first, siblings by start, depth from where each ends up', () => {
  const out = orderTree([node('c', 'a', 3), node('b', 'root', 2), node('a', 'root', 1), node('d', 'c', 4)], 'root');
  assert.deepEqual(out.map((n) => `${n.depth}:${n.ref}`), ['1:a', '2:c', '3:d', '1:b']);
});

test('the tree never hides or loops: orphans hang from the root, a cycle is cut', () => {
  const out = orderTree([node('x', 'missing', 1), node('p', 'q', 2), node('q', 'p', 3), node('ok', 'root', 4)], 'root');
  assert.equal(out.length, 4);
  assert.deepEqual(out.find((n) => n.ref === 'x'), { ...node('x', 'root', 1), depth: 1 });
  assert.ok(out.every((n) => n.depth >= 1));
});

test('deep trees: who waits on how many, and the summary counts every level', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => node(`n${i}`, i ? `n${i - 1}` : 'root', i, { state: i === 49 ? 'running' : 'completed' }));
  const ordered = orderTree(nodes, 'root');
  assert.equal(ordered.at(-1)!.depth, 50);
  const below = runningBelow(ordered.map((n) => ({ ref: n.ref, parentRef: n.parentRef, active: n.state === 'running' })));
  assert.equal(below.get('n0'), 1);
  assert.equal(below.get('n49'), undefined);
  const sum = summarize(ordered);
  assert.deepEqual({ ...sum, rev: '' }, { total: 50, active: 1, completed: 49, failed: 0, rev: '' });
  assert.equal(summarize(ordered).rev, sum.rev, 'the same tree, the same rev');
  assert.notEqual(summarize(ordered.map((n, i) => (i === 49 ? { ...n, state: 'completed' as const } : n))).rev, sum.rev);
});

// ---------- claude's files

test('a sidecar is read field by field; nothing in it becomes a path', () => {
  assert.deepEqual(parseMeta(JSON.stringify({ agentType: 'Explore', description: 'Audit  the\nserver', toolUseId: 'toolu_01', parentAgentId: 'a1b2', spawnDepth: 2, requestShape: 'background' })), {
    agentType: 'Explore', description: 'Audit the server', toolUseId: 'toolu_01', parentAgentId: 'a1b2', depth: 2, background: true,
  });
  const bad = parseMeta(JSON.stringify({ parentAgentId: '../../etc', toolUseId: 'a b', spawnDepth: -3 }))!;
  assert.equal(bad.parentAgentId, null);
  assert.equal(bad.toolUseId, null);
  assert.equal(bad.depth, 1);
  assert.equal(parseMeta('{not json'), null);
  assert.equal(parseMeta('[1]'), null);
});

test('outcomes: a spawning call\'s result, and notifications only where the harness writes them', () => {
  const calls = new Set(['toolu_1']);
  const result = JSON.stringify({ type: 'user', timestamp: '2026-11-19T22:30:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'done' }] }] }, toolUseResult: { status: 'completed', agentId: 'a1' } });
  assert.deepEqual(outcomesOf(result, calls), [{ toolUseId: 'toolu_1', outcome: { kind: 'result', status: 'completed', isError: false, interrupted: false, at: 1795127400 } }]);
  // Not a spawn: another tool's result is no child's outcome.
  assert.deepEqual(outcomesOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'x' }] } }), calls), []);
  const note = '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>';
  assert.equal(outcomesOf(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: note }), calls)[0].agentId, 'a1');
  assert.equal(outcomesOf(JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: note } }), calls)[0].agentId, 'a1');
  // A tool that printed one, or an assistant quoting one, says nothing about the child.
  assert.deepEqual(outcomesOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: note }] } }), calls), []);
  assert.deepEqual(outcomesOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: note }] } }), calls), []);
  // Torn or foreign lines are skipped.
  assert.deepEqual(outcomesOf('{"type":"user","message":{"content":[{"tool_use_id":"toolu_1"', calls), []);
});

test("a child's last lines: what it did, and whether it's done", () => {
  const l = (o: object) => JSON.stringify({ timestamp: '2026-11-19T22:30:00Z', ...o });
  const working = tailFacts([l({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'server/core.ts' } }] } })])!;
  assert.equal(working.activity, 'Read: server/core.ts');
  assert.equal(working.final, false);
  const done = tailFacts([l({ type: 'assistant', message: { content: [{ type: 'text', text: 'All three routes are covered.' }] } })])!;
  assert.equal(done.final, true);
  assert.equal(done.activity, 'All three routes are covered.');
  assert.equal(tailFacts([l({ type: 'user', message: { content: '[Request interrupted by user]' } })])!.interrupted, true);
  assert.equal(tailFacts([l({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'overloaded' }] } })])!.error, true);
  // Handing its report back is how it ends, not what it did.
  const handback = tailFacts([l({ type: 'assistant', message: { content: [{ type: 'text', text: 'Report ready.' }] } }), l({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: {} }] } })])!;
  assert.equal(handback.activity, 'Report ready.');
  assert.equal(tailFacts(['{torn']), null);
});

test('codex: the newest turn event and the last thing done', () => {
  const l = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-11-19T22:30:00Z', type, payload });
  const r = codexTail([l('event_msg', { type: 'task_started' }), l('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["rg","route("]}' })]);
  assert.equal(r.last?.kind, 'started');
  assert.equal(r.tail?.activity, 'shell: rg route(');
  const done = codexTail([l('event_msg', { type: 'task_complete', last_agent_message: 'Three routes lack tests.' })]);
  assert.equal(done.last?.kind, 'complete');
  assert.equal(done.tail?.activity, 'Three routes lack tests.');
});

// ---------- reading real folders

async function claudeProject() {
  const projects = await mkdtemp(join(tmpdir(), 'ah-sub-'));
  const dir = join(projects, '-home-u-proj');
  await mkdir(join(dir, SID, 'subagents'), { recursive: true });
  const root = join(dir, `${SID}.jsonl`);
  await writeFile(root, JSON.stringify({ type: 'user', sessionId: SID, cwd: '/home/u/proj', message: { content: 'Refactor the server' } }) + '\n');
  const sub = join(dir, SID, 'subagents');
  const child = async (id: string, meta: object | null, lines: object[]) => {
    if (meta) await writeFile(join(sub, `agent-${id}.meta.json`), JSON.stringify(meta));
    await writeFile(join(sub, `agent-${id}.jsonl`), lines.map((x) => JSON.stringify({ isSidechain: true, agentId: id, timestamp: new Date().toISOString(), ...x })).join('\n') + '\n');
  };
  return { projects, root, sub, child };
}

const treeOf = (svc: SubagentService, root: string, l = live) => svc.tree({ harness: 'claude', harnessId: SID, file: root, title: 'Refactor', uid: 'u1', live: l });

test('a claude folder: children, nesting, outcomes read on as the parent writes them, and the same tree every time', async () => {
  const { root, sub, child } = await claudeProject();
  const svc = new SubagentService({ transcripts: async () => [] });
  await child('a1', { agentType: 'Explore', description: 'Domain model audit', toolUseId: 'toolu_1', spawnDepth: 1, requestShape: 'foreground' }, [
    { type: 'user', message: { content: 'Audit the domain model' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { description: 'Contract validator' } }] } },
  ]);
  await child('a2', { agentType: 'general-purpose', description: 'Contract validator', toolUseId: 'toolu_2', parentAgentId: 'a1', spawnDepth: 2, requestShape: 'foreground' }, [{ type: 'user', message: { content: 'Validate the contracts' } }]);
  // No sidecar yet (it's written a moment later): still shown, from its transcript.
  await child('a3', null, [{ type: 'user', message: { content: 'Review the architecture' } }]);
  // A link where a transcript should be is never followed.
  await symlink('/etc/passwd', join(sub, 'agent-a4.jsonl'));
  await writeFile(join(sub, 'notes.txt'), 'not a child');

  let t = await treeOf(svc, root);
  assert.deepEqual(t.nodes.map((n) => [n.depth, n.name, n.state, n.prompt]), [
    [1, 'Domain model audit', 'running', 'Audit the domain model'],
    [2, 'Contract validator', 'running', 'Validate the contracts'],
    [1, 'Review the architecture', 'running', 'Review the architecture'],
  ]);
  assert.equal(t.nodes[1].parentRef, claudeRef(SID, 'a1'));
  assert.equal(t.root.ref, `claude:${SID}`);

  // The nested one finishes: its outcome is in its parent's transcript, not the root's. A torn last line waits for its end.
  const a1 = join(sub, 'agent-a1.jsonl');
  const result = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] }, toolUseResult: { status: 'completed', agentId: 'a2' } });
  await appendFile(a1, result.slice(0, 40));
  t = await treeOf(svc, root);
  assert.equal(t.nodes[1].state, 'running');
  await appendFile(a1, result.slice(40) + '\n');
  t = await treeOf(svc, root);
  assert.equal(t.nodes[1].state, 'completed');
  // Its parent finishes too, told twice (a replayed line): still one child, completed.
  const done = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, toolUseResult: { status: 'completed', agentId: 'a1' } });
  await appendFile(root, `${done}\n${done}\n`);
  t = await treeOf(svc, root);
  assert.deepEqual(t.nodes.map((n) => n.state), ['completed', 'completed', 'running']);

  // A second reader from nothing (a restarted ah) arrives at the same tree.
  const fresh = await treeOf(new SubagentService({ transcripts: async () => [] }), root);
  assert.deepEqual(fresh.nodes.map((n) => [n.ref, n.state, n.parentRef]), t.nodes.map((n) => [n.ref, n.state, n.parentRef]));
  // The parent gone: the one never told about is not called finished.
  t = await treeOf(svc, root, gone);
  assert.deepEqual(t.nodes.map((n) => n.state), ['completed', 'completed', 'unknown']);
});

test('a session without subagents, or a transcript not named like a session, has an empty tree', async () => {
  const { root } = await claudeProject();
  const svc = new SubagentService({ transcripts: async () => [] });
  assert.equal(claudeFolder('/x/not-a-session.jsonl'), null);
  assert.deepEqual((await svc.tree({ harness: 'claude', harnessId: 'x', file: '/x/not-a-session.jsonl', title: '', uid: null, live: gone })).nodes, []);
  assert.deepEqual((await treeOf(svc, root.replace(SID, '00000000-0000-0000-0000-000000000000'))).nodes, []);
});

test("a child's refs resolve only to children discovery vouches for", async () => {
  const { root, child } = await claudeProject();
  await child('a1', null, [{ type: 'user', message: { content: 'x' } }]);
  const svc = new SubagentService({ transcripts: async () => [{ harness: 'claude', harnessId: SID, cwd: '/home/u/proj', title: 'Refactor', updatedAt: 1, file: root }] });
  assert.deepEqual(await svc.source(claudeRef(SID, 'a1')), { adapter: 'claude-subagent', harness: 'claude', file: join(root.slice(0, -6), 'subagents', 'agent-a1.jsonl') });
  assert.equal(await svc.source(claudeRef(SID, 'a9')), null, 'not there');
  assert.equal(await svc.source(claudeRef('00000000-0000-0000-0000-000000000000', 'a1')), null, 'no such root');
  assert.equal(await svc.source(`claude:${SID}:../../x`), null);
  assert.deepEqual(await svc.rootOf(claudeRef(SID, 'a1')), { harness: 'claude', harnessId: SID });
  assert.equal(await svc.rootOf('u1'), null);
});

// ---------- feeds

test("a subagent's transcript reads as a conversation; the parent's still skips it", () => {
  const line = { isSidechain: true, type: 'user', uuid: 'u1', timestamp: '2026-11-19T22:30:00Z', message: { content: 'Audit the domain model' } };
  assert.equal(parseClaudeLine(line, 1), null);
  assert.deepEqual(parseClaudeSubagentLine(line, 1)?.parts, [{ type: 'text', text: 'Audit the domain model' }]);
});

test("a spawned codex thread's feed starts where its own history does", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-sub-feed-'));
  const file = join(dir, 'rollout.jsonl');
  const msg = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  await writeFile(file, [JSON.stringify({ type: 'session_meta', payload: { id: 'c' } }), msg('user', "the parent's prompt"), msg('assistant', "the parent's answer"), msg('user', 'Repair the findings'), msg('assistant', 'On it')].join('\n') + '\n');
  const feed = new TranscriptFeed(file, ADAPTERS.codex, 4);
  await feed.update();
  assert.deepEqual(feed.entries.map((e) => e.parts.map((p) => (p as any).text).join('')), ['Repair the findings', 'On it']);
});

test("a session folder that's a link elsewhere is never read through", async () => {
  const { projects, root } = await claudeProject();
  const elsewhere = await mkdtemp(join(tmpdir(), 'ah-sub-elsewhere-'));
  await mkdir(join(elsewhere, 'subagents'), { recursive: true });
  await writeFile(join(elsewhere, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'secret' } }) + '\n');
  const other = join(projects, '-home-u-other');
  await mkdir(other, { recursive: true });
  const sid = '11111111-2222-3333-4444-555555555555';
  const linkedRoot = join(other, `${sid}.jsonl`);
  await writeFile(linkedRoot, '{}\n');
  await symlink(elsewhere, join(other, sid));
  const svc = new SubagentService({ transcripts: async () => [{ harness: 'claude', harnessId: sid, cwd: '/x', title: 'x', updatedAt: 1, file: linkedRoot }] });
  assert.deepEqual((await svc.tree({ harness: 'claude', harnessId: sid, file: linkedRoot, title: '', uid: null, live: gone })).nodes, []);
  assert.equal(await svc.source(claudeRef(sid, 'a1')), null);
  assert.ok(root);
});

const ROOT = '23686541-aa31-42c4-8a28-b6c42f44e2f4';
const CHILD = '8c7965d9-1af8-4f99-9192-04f67a4bd089';

test('a Gemini conversation lists the children agy recorded under it, and only those', async () => {
  const child = {
    harness: 'gemini',
    harnessId: CHILD,
    cwd: '/home/u/proj',
    title: 'Look through the toast code',
    updatedAt: 2000,
    file: `/conversations/${CHILD}.db`,
    spawned: { parentId: ROOT, rootId: ROOT, depth: 1, kind: 'spawn' as const, nickname: 'research', role: 'research', idle: true, endedAt: 1500 },
  };
  const other = { ...child, harnessId: '92ca2edf-1f5f-41e0-8386-7474c58806f6', spawned: { ...child.spawned, parentId: 'someone-else', rootId: 'someone-else' } };
  const svc = new SubagentService({ transcripts: async () => [child, other] });
  const tree = await svc.tree({ harness: 'gemini', harnessId: ROOT, file: `/conversations/${ROOT}.db`, title: 'Telegram', uid: 'u1', live });
  assert.equal(tree.nodes.length, 1);
  assert.equal(tree.nodes[0].ref, `gemini:${CHILD}`);
  assert.equal(tree.nodes[0].name, 'Look through the toast code');
  assert.equal(tree.nodes[0].role, 'research');
  assert.equal(tree.nodes[0].state, 'completed');
  assert.equal(tree.nodes[0].endedAt, 1500, 'when agy says it went idle, not when its file was last touched');
  assert.deepEqual(geminiState({ updatedAt: 2000, root: live }), { state: 'running', endedAt: null }, 'not idle, parent live: still running');
  assert.deepEqual(geminiState({ updatedAt: 2000, root: gone }), { state: 'unknown', endedAt: null }, 'not idle, parent gone: not proof it finished');
  assert.deepEqual(geminiState({ killed: true, idle: true, endedAt: 1500, updatedAt: 2000, root: live }), { state: 'canceled', endedAt: 1500 });
  assert.equal(tree.nodes[0].capabilities.send, false);
  assert.deepEqual(await svc.source(`gemini:${CHILD}`), { adapter: 'gemini', harness: 'gemini', file: child.file });
  assert.deepEqual(await svc.rootOf(`gemini:${CHILD}`), { harness: 'gemini', harnessId: ROOT });
  assert.equal(await svc.source('gemini:not-a-uuid'), null);
  assert.equal(await svc.source(`gemini:${ROOT}`), null, 'the root is not a child');
  assert.equal((await svc.tree({ harness: 'gemini', harnessId: 'no-children', file: '', title: '', uid: null, live: gone })).nodes.length, 0);
  const grok = new SubagentService({
    transcripts: async () => [{ harness: 'grok', harnessId: 'child-1', cwd: '/p', title: 'Research agent frameworks', updatedAt: 10, file: '/g/child/chat_history.jsonl', spawned: { parentId: 'root-1', rootId: 'root-1', depth: 1, kind: 'spawn', role: 'general-purpose' } }],
  });
  const gtree = await grok.tree({ harness: 'grok', harnessId: 'root-1', file: '/g/root/chat_history.jsonl', title: 'Parent', uid: 'u', live: gone });
  assert.equal(gtree.nodes[0]?.ref, 'grok:child-1');
  assert.deepEqual(await grok.source('grok:child-1'), { adapter: 'grok', harness: 'grok', file: '/g/child/chat_history.jsonl' });
  assert.equal(await grok.source('grok:../x'), null);
});
