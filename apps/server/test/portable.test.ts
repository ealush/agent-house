// Portable conversations, black box (Workflow A): a Claude Code conversation is
// continued in Codex, carries on there, and comes back to Claude with a native copy
// of the original plus what happened in Codex, with lineage, provenance and honest
// limits at every step. The stand-ins write the real transcript formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptFile, transcriptOf, windows } from './fake-agents.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('Claude → Codex → Claude: context carries, lineage holds, sources stay untouched', async () => {
  let ah = await startBed();
  try {
    const caps = (await http(ah, 'GET', '/api/portable/capabilities')).json();
    const claudeCap = caps.harnesses.find((h: any) => h.id === 'claude');
    assert.equal(claudeCap.nativeFork, true);
    assert.equal(claudeCap.read, true);
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.portable, 1);

    const baseline = (await windows(ah)).length;
    const claude = await launch(ah, 'claude', ah.project, 'Login fix');
    await say(ah, claude.uid, 'Fix the flaky login test in auth.spec.ts');
    await say(ah, claude.uid, 'Use a fake clock instead of sleeping');
    const claudeFile = transcriptFile(ah, claude.harnessId)!;
    const claudeBefore = sha(readFileSync(claudeFile, 'utf8'));

    // The document: provenance, turns, models, honest limits.
    const exportRes = await http(ah, 'GET', `/api/portable/conversations/${claude.uid}`);
    assert.equal(exportRes.status, 200, exportRes.body);
    const doc = exportRes.json().conversation;
    assert.equal(doc.format, 'ah.portable-conversation');
    assert.equal(doc.source.harness, 'claude');
    assert.equal(doc.source.harnessId, claude.harnessId);
    assert.equal(doc.source.sha256, claudeBefore);
    assert.equal(doc.stats.turns, 2);
    assert.deepEqual(doc.models, ['claude-opus-5-5']);
    assert.ok(doc.limitations.some((l: any) => l.code === 'no_internal_state'));

    // Preview: what transfers, said plainly, before anything happens.
    const preview = (await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/preview`, { body: { to: 'codex' } })).json();
    assert.equal(preview.strategy, 'context-handoff');
    assert.equal(preview.blocked, null);
    assert.ok(preview.transfers.some((t: string) => /does not transfer/.test(t)), preview.transfers.join(' | '));
    assert.ok(preview.handoff.messagesIncluded >= 4);
    assert.equal((await windows(ah)).length, baseline + 1, 'a preview starts nothing');

    // Continue in Codex, twice with the same key: one session.
    const key = 'test:claude-to-codex-1';
    const first = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'codex', model: 'gpt-x', effort: 'high', idempotencyKey: key } });
    assert.equal(first.status, 201, first.body);
    const op = first.json().operation;
    const again = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'codex', idempotencyKey: key } });
    assert.equal(again.status, 200, again.body);
    assert.equal(again.json().operation.id, op.id);
    assert.equal(again.json().existed, true);

    const linked = await until(async () => {
      const o = (await http(ah, 'GET', `/api/portable/operations/${op.id}`)).json();
      return o.state === 'linked' && o;
    }, 20000, 'continuation linked');
    assert.equal(linked.strategy, 'context-handoff');
    const codex = (await windows(ah)).find((w) => w.uid === linked.childUid);
    assert.equal(codex.agent, 'codex');
    assert.equal(codex.continued.fromHarness, 'claude');
    assert.equal(codex.continued.fromUid, claude.uid);
    assert.equal(codex.continued.kind, 'portable');
    assert.equal(codex.launchModel, 'gpt-x', 'the model chosen for the destination');
    assert.equal(codex.launchEffort, 'high');
    assert.equal((await windows(ah)).filter((w) => w.agent === 'codex').length, 1, 'the retried request made no second session');
    const codexText = (await transcriptOf(ah, codex.uid))!;
    assert.match(codexText, new RegExp(`\\[ah continuation ${op.id}`));
    assert.match(codexText, /Fix the flaky login test/);
    assert.match(codexText, /not that agent's memory/);
    assert.equal(sha(readFileSync(claudeFile, 'utf8')), claudeBefore, 'the Claude conversation is untouched');

    // Codex carries on; then the conversation goes back to Claude.
    await say(ah, codex.uid, 'Now also update the docs for the fake clock');
    const backRes = await http(ah, 'POST', `/api/portable/conversations/${codex.uid}/preview`, { body: { to: 'claude' } });
    assert.equal(backRes.status, 200, `${backRes.body}\n${ah.log().slice(-2500)}`);
    const back = backRes.json();
    assert.equal(back.strategy, 'ancestor-fork', JSON.stringify(back));
    assert.equal(back.ancestor.title, 'Login fix');

    // A restart right after it starts: the edge is found again and settles.
    const res = await http(ah, 'POST', `/api/portable/conversations/${codex.uid}/continue`, { body: { to: 'claude' } });
    assert.equal(res.status, 201, res.body);
    const backOp = res.json().operation;
    ah = Object.assign(await ah.restart(), { bin: ah.bin, project: ah.project });
    const home = await until(async () => {
      const o = (await http(ah, 'GET', `/api/portable/operations/${backOp.id}`)).json();
      return o.state === 'linked' && o;
    }, 25000, 'return to Claude linked after a restart');
    const claude2 = (await windows(ah)).find((w) => w.uid === home.childUid);
    assert.equal(claude2.agent, 'claude');
    assert.notEqual(claude2.harnessId, claude.harnessId, 'a copy, not the original');
    assert.equal(claude2.continued.strategy, 'ancestor-fork');
    const text2 = (await transcriptOf(ah, claude2.uid))!;
    // Natively: the original Claude turns. Then the delta: what happened in Codex, and only that.
    assert.match(text2, /Use a fake clock instead of sleeping/);
    assert.match(text2, /Now also update the docs for the fake clock/);
    assert.match(text2, /continued in Codex/);
    // The first hand-off (Claude → Codex) is ah talking, already covered natively: not handed over again.
    assert.doesNotMatch(text2, /not that agent's memory/, 'the earlier hand-off is not handed over again');
    assert.match(text2, new RegExp(`\\[ah continuation ${backOp.id} · from Codex to Claude Code\\]`));
    assert.equal(sha(readFileSync(claudeFile, 'utf8')), claudeBefore, 'the original is still untouched');

    // Lineage: three conversations, two edges, navigable from any of them.
    const tree = (await http(ah, 'GET', `/api/portable/conversations/${claude2.uid}/lineage`)).json();
    assert.equal(tree.nodes.length, 3);
    assert.equal(tree.edges.length, 2);
    assert.equal(tree.nodes.find((n: any) => n.conversationId === tree.root).harness, 'claude');
    const fromRoot = (await http(ah, 'GET', `/api/portable/conversations/${claude.uid}/lineage`)).json();
    assert.equal(fromRoot.nodes.length, 3);
    const doc2 = (await http(ah, 'GET', `/api/portable/conversations/${claude2.uid}`)).json().conversation;
    assert.deepEqual(doc2.lineage.map((l: any) => l.harness), ['codex', 'claude']);
  } finally {
    await cleanup(ah);
  }
});

test('unsupported and blocked continuations fail honestly, and change nothing', async () => {
  const ah = await startBed();
  try {
    const shell = (await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project } })).json();
    await until(async () => (await windows(ah)).some((w) => w.uid === shell.uid), 8000, 'shell up');
    const r1 = await http(ah, 'POST', `/api/portable/conversations/${shell.uid}/continue`, { body: { to: 'codex' } });
    assert.equal(r1.status, 422);
    assert.equal(r1.json().code, 'not_a_conversation');
    const claude = await launch(ah, 'claude', ah.project);
    await say(ah, claude.uid, 'hello there');
    const before = (await windows(ah)).length;
    const r2 = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'gemini' } });
    assert.equal(r2.status, 409);
    assert.equal(r2.json().code, 'unknown_destination');
    const r3 = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'claude' } });
    assert.equal(r3.status, 409);
    assert.equal(r3.json().code, 'use_resume');
    const r4 = await http(ah, 'POST', `/api/portable/conversations/nope:missing/preview`, { body: { to: 'codex' } });
    assert.equal(r4.status, 404);
    const r5 = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'codex', intent: 'teleport' } });
    assert.equal(r5.status, 400);
    // Launch choices come from the destination's catalog, as in New session.
    assert.equal((await http(ah, 'GET', '/api/portable/capabilities')).json().launchOptions, true);
    const bad = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/continue`, { body: { to: 'codex', model: 'no-such-model' } });
    assert.equal(bad.status, 400, bad.body);
    assert.equal(bad.json().code, 'invalid_launch');
    const badEffort = await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/preview`, { body: { to: 'codex', effort: 'ludicrous' } });
    assert.equal(badEffort.status, 400, badEffort.body);
    const echo = (await http(ah, 'POST', `/api/portable/conversations/${claude.uid}/preview`, { body: { to: 'codex', model: 'gpt-x', effort: 'low' } })).json();
    assert.deepEqual([echo.destination.model, echo.destination.effort], ['gpt-x', 'low']);
    assert.equal((await windows(ah)).length, before, 'nothing was launched');
  } finally {
    await cleanup(ah);
  }
});
