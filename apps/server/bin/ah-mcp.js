#!/usr/bin/env node
// Agent House stdio MCP server (`node bin/ah.js mcp`).
// Reads AH_PORT, AH_SESSION_UID, AH_SESSION_TOKEN, AH_SPACE, AH_ROLE, and AH_MANAGED_BY
// from the inherited session environment — zero secrets stored on disk.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { handleMcpRequest, roleFromEnv } from '../server/mcp.ts';

const STATE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');

function localToken() {
  try {
    return readFileSync(join(STATE, 'local-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const config = loadConfig();
const PORT = Number(process.env.AH_PORT ?? config.port);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_UID = process.env.AH_SESSION_UID?.trim() || null;
const SESSION_TOKEN = process.env.AH_SESSION_TOKEN?.trim() || null;

function authHeaders(extra = {}) {
  const tok = localToken();
  return {
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    'x-ah': '1',
    origin: BASE,
    ...(SESSION_UID ? { 'x-ah-session': SESSION_UID } : {}),
    ...(SESSION_TOKEN ? { 'x-ah-session-token': SESSION_TOKEN } : {}),
    ...extra,
  };
}

const api = {
  async request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: authHeaders(body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    return { status: res.status, data };
  },
  async uploadArtifact({ dir, filePath, name }) {
    const destName = (name?.trim() || basename(filePath)).replace(/^\/+/, '');
    await fetch(`${BASE}/api/fs/mkdir`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path: dir }),
    }).catch(() => {});
    const bytes = readFileSync(filePath);
    const up = await fetch(`${BASE}/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(destName)}`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/octet-stream' }),
      body: bytes,
    });
    const ct = up.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await up.json().catch(() => null) : await up.text().catch(() => '');
    return { status: up.status, data };
  },
};

const ctx = {
  role: roleFromEnv(process.env),
  sessionUid: SESSION_UID,
  space: process.env.AH_SPACE?.trim() || null,
  managedBy: process.env.AH_MANAGED_BY?.trim() || null,
  api,
};

let lastIdentitySig = `${ctx.role}:${ctx.managedBy ?? ''}`;

/**
 * Refreshes live role, managedBy, and Space membership from the server so adopting,
 * promoting, demoting, or moving an already-running session immediately updates MCP tools.
 */
async function syncLiveIdentity() {
  if (!SESSION_UID) return;
  try {
    const res = await api.request('GET', '/api/state');
    if (res.status >= 400 || !res.data || typeof res.data !== 'object') return;
    const windows = Array.isArray(res.data.windows) ? res.data.windows : [];
    const me = windows.find((w) => w && w.uid === SESSION_UID);
    if (!me) return;
    const sup = me.supervision && typeof me.supervision === 'object' ? me.supervision : null;
    const nextRole =
      sup && (sup.role === 'chief' || sup.role === 'worker' || sup.role === 'reviewer')
        ? sup.role
        : roleFromEnv(process.env);
    const nextManagedBy = sup && typeof sup.managedBy === 'string' && sup.managedBy ? sup.managedBy : null;
    const nextSpace =
      (sup && typeof sup.space === 'string' && sup.space) ||
      (typeof me.space === 'string' && me.space) ||
      (typeof me.project === 'string' && me.project) ||
      ctx.space;
    ctx.role = nextRole;
    ctx.managedBy = nextManagedBy;
    ctx.space = nextSpace;
    const sig = `${ctx.role}:${ctx.managedBy ?? ''}`;
    if (sig !== lastIdentitySig) {
      lastIdentitySig = sig;
      writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  } catch {}
}

// Auto-detect framing: MCP stdio uses newline-delimited JSON; support Content-Length framing too.
let framing = 'ndjson';
let buf = Buffer.alloc(0);

function writeMessage(msg) {
  const payload = JSON.stringify(msg);
  if (framing === 'lsp') {
    const bytes = Buffer.byteLength(payload, 'utf8');
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

let initialized = false;
let pollTimer = null;

async function dispatch(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed?.method === 'tools/list' || parsed?.method === 'tools/call') {
    await syncLiveIdentity();
  }
  const out = await handleMcpRequest(parsed, ctx);
  if (out) writeMessage(out);
  if (parsed?.method === 'initialize' && !initialized) {
    initialized = true;
    if (SESSION_UID && !pollTimer) {
      pollTimer = setInterval(() => {
        void syncLiveIdentity();
      }, 15_000);
      pollTimer.unref?.();
    }
  }
}

let queue = Promise.resolve();
function enqueue(raw) {
  queue = queue.then(() => dispatch(raw)).catch((err) => {
    process.stderr.write(`ah mcp error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

function drain() {
  for (;;) {
    if (buf.length === 0) return;
    // Detect LSP-style Content-Length framing.
    const headStr = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8');
    if (/^Content-Length:\s*\d+/i.test(headStr)) {
      framing = 'lsp';
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const header = buf.subarray(0, sep).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buf = buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      if (buf.length < sep + 4 + len) return;
      const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      buf = buf.subarray(sep + 4 + len);
      enqueue(body);
      continue;
    }
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const line = buf.subarray(0, nl).toString('utf8').trim();
    buf = buf.subarray(nl + 1);
    if (line) enqueue(line);
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drain();
});
process.stdin.on('end', () => {
  const rest = buf.toString('utf8').trim();
  if (rest) enqueue(rest);
  void queue.finally(() => process.exit(0));
});
