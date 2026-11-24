import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  handleMcpRequest,
  renderRolePlaybook,
  roleFromEnv,
  toolsForRole,
  type McpApi,
  type McpContext,
} from './mcp.ts';
import { ensureMcpConfigFile } from './mcpConfig.ts';

function fakeApi(handlers: Record<string, (body?: unknown) => { status: number; data: unknown }>): {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  api: McpApi;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    api: {
      async request(method, path, body) {
        calls.push({ method, path, body });
        const key = `${method} ${path}`;
        const hit = handlers[key];
        if (!hit) return { status: 404, data: { error: `unhandled ${key}` } };
        return hit(body);
      },
    },
  };
}

test('toolsForRole hides downward orchestration tools from workers, reviewers, and unmanaged default sessions', () => {
  const chiefNames = new Set(toolsForRole('chief', null).map((t) => t.name));
  const workerNames = new Set(toolsForRole('worker', 'ah-chief001').map((t) => t.name));
  const reviewerNames = new Set(toolsForRole('reviewer', 'ah-chief001').map((t) => t.name));
  const defaultNames = new Set(toolsForRole('default', null).map((t) => t.name));

  // Shared Space / reporting tools are present for everyone.
  for (const shared of ['space_context', 'space_artifacts', 'mail_report_up', 'mail_broadcast_siblings', 'task_list', 'task_update']) {
    assert.ok(chiefNames.has(shared), `chief has ${shared}`);
    assert.ok(workerNames.has(shared), `worker has ${shared}`);
    assert.ok(reviewerNames.has(shared), `reviewer has ${shared}`);
    assert.ok(defaultNames.has(shared), `default has ${shared}`);
  }
  // Downward control & durable knowledge promotion tools are Chief-only.
  for (const chiefTool of ['space_sessions', 'space_promote_knowledge', 'session_spawn', 'session_send', 'session_answer', 'session_forward', 'session_supervise', 'task_create', 'mail_send', 'wake_subscribe']) {
    assert.ok(chiefNames.has(chiefTool), `chief has ${chiefTool}`);
    assert.ok(!workerNames.has(chiefTool), `worker must NOT see ${chiefTool}`);
    assert.ok(!reviewerNames.has(chiefTool), `reviewer must NOT see ${chiefTool}`);
    assert.ok(!defaultNames.has(chiefTool), `default must NOT see ${chiefTool}`);
  }
});

test('handleMcpRequest initializes with listChanged, lists role-scoped tools, and blocks worker calls to chief tools', async () => {
  const { api } = fakeApi({});
  const workerCtx: McpContext = {
    role: roleFromEnv({ AH_ROLE: 'worker' }),
    sessionUid: 'ah-wrk00001',
    space: 'Launch',
    managedBy: 'ah-chf00001',
    api,
  };

  const init = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, workerCtx);
  const initRes = init?.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: { listChanged?: boolean } } };
  assert.equal(initRes.protocolVersion, '2025-03-26');
  assert.equal(initRes.serverInfo.name, 'ah');
  assert.equal(initRes.capabilities.tools.listChanged, true);

  // Notifications produce no response.
  assert.equal(await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, workerCtx), null);

  const denied = await handleMcpRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_answer', arguments: { target: 'ah-chf00001', choice: 'yes' } } },
    workerCtx,
  );
  assert.equal((denied?.result as { isError?: boolean }).isError, true);
  assert.match((denied?.result as { content: Array<{ text: string }> }).content[0].text, /Forbidden/);
});

test('chief MCP calls hit the right API routes with Space defaults, priority mapping, and safe wakes', async () => {
  const { calls, api } = fakeApi({
    'GET /api/spaces/Launch/context': () => ({ status: 200, data: { markdown: '# Space: Launch\nReady' } }),
    'GET /api/spaces': () => ({ status: 200, data: { spaces: [{ name: 'Launch', path: '~/spaces/Launch' }] } }),
    'POST /api/windows': () => ({ status: 201, data: { id: '@9', uid: 'ah-wrk00002' } }),
    'POST /api/sessions/ah-wrk00002/send': () => ({ status: 200, data: { outcome: 'queued' } }),
    'POST /api/jobs': () => ({ status: 201, data: { id: 'jb-11112222' } }),
    'POST /api/fleet/tasks': () => ({ status: 201, data: { id: 'tk-11112222', priority: 0 } }),
  });

  const chiefCtx: McpContext = {
    role: 'chief',
    sessionUid: 'ah-chf00001',
    space: 'Launch',
    managedBy: null,
    api,
  };

  // space_context defaults to $AH_SPACE.
  const ctxRes = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'space_context', arguments: {} } }, chiefCtx);
  assert.equal((ctxRes?.result as { content: Array<{ text: string }> }).content[0].text, '# Space: Launch\nReady');

  // session_spawn attaches Space + managedBy: chief + sends prompt.
  const spawnRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_spawn', arguments: { preset: 'claude', name: 'Docs worker', prompt: 'Write release notes' } } },
    chiefCtx,
  );
  assert.equal((spawnRes?.result as { isError?: boolean }).isError, undefined);
  const winCall = calls.find((c) => c.method === 'POST' && c.path === '/api/windows');
  assert.ok(winCall);
  assert.equal((winCall.body as { space: string }).space, 'Launch');
  assert.equal((winCall.body as { supervision: { managedBy: string; role: string } }).supervision.managedBy, 'ah-chf00001');
  assert.equal((winCall.body as { supervision: { role: string } }).supervision.role, 'worker');

  // wake_subscribe watch_space creates Space-scoped, loop-safe session event trigger.
  const wakeRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wake_subscribe', arguments: { action: 'watch_space', on: 'waiting' } } },
    chiefCtx,
  );
  assert.equal((wakeRes?.result as { isError?: boolean }).isError, undefined);
  const jobCall = calls.find((c) => c.method === 'POST' && c.path === '/api/jobs');
  assert.ok(jobCall);
  const jobBody = jobCall.body as { trigger: { space: string; on: string; excludeRoles?: string[] }; policy: { skipIfBusy?: boolean } };
  assert.equal(jobBody.trigger.space, 'Launch');
  assert.equal(jobBody.trigger.on, 'waiting');
  assert.deepEqual(jobBody.trigger.excludeRoles, ['chief']);
  assert.equal(jobBody.policy.skipIfBusy, true);

  // task_create maps urgent -> 0 (P0), high -> 1, normal -> 2, low -> 3.
  const taskRes = await handleMcpRequest(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'task_create', arguments: { title: 'Ship', priority: 'urgent' } } },
    chiefCtx,
  );
  assert.equal((taskRes?.result as { isError?: boolean }).isError, undefined);
  const taskCall = calls.find((c) => c.method === 'POST' && c.path === '/api/fleet/tasks');
  assert.equal((taskCall?.body as { priority: number }).priority, 0);
});

test('worker mail_report_up defaults to $AH_MANAGED_BY and blocks directives', async () => {
  const { calls, api } = fakeApi({
    'POST /api/fleet/mailbox': () => ({ status: 201, data: { id: 'mb-11112222' } }),
  });
  const workerCtx: McpContext = {
    role: 'worker',
    sessionUid: 'ah-wrk00001',
    space: 'Launch',
    managedBy: 'ah-chf00001',
    api,
  };
  const ok = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mail_report_up', arguments: { body: 'Tests green' } } },
    workerCtx,
  );
  assert.equal((ok?.result as { isError?: boolean }).isError, undefined);
  assert.equal((calls[0].body as { toUid: string; kind: string }).toUid, 'ah-chf00001');
  assert.equal((calls[0].body as { kind: string }).kind, 'report');
});

test('ensureMcpConfigFile writes a secret-free MCP config and renderRolePlaybook adapts to role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-mcp-test-'));
  try {
    const file = ensureMcpConfigFile(dir, '/opt/ah/bin/ah.js', '/usr/bin/node');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, {
      mcpServers: {
        ah: {
          command: '/usr/bin/node',
          args: ['/opt/ah/bin/ah.js', 'mcp'],
        },
      },
    });
    const chiefPlaybook = renderRolePlaybook({ role: 'chief', space: 'Launch', hasMcp: true });
    assert.match(chiefPlaybook, /Chief of Staff Playbook/);
    assert.match(chiefPlaybook, /mcp__ah__\*/);
    const workerPlaybook = renderRolePlaybook({ role: 'worker', space: 'Launch', managedBy: 'ah-chf00001', hasMcp: true });
    assert.match(workerPlaybook, /Worker Playbook/);
    assert.match(workerPlaybook, /mail_report_up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
