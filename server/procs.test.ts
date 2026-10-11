import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { descendants, listeningPorts, listeningSockets } from './procs.ts';

test('exec-replaced pane roots are included for agent detection', () => {
  const root = { pid: 10, ppid: 1, argv: ['python', '/p/hermes'] };
  const child = { pid: 11, ppid: 10, argv: ['bash', '-c', 'sleep 60'] };
  const procs = new Map([[1, [root]], [10, [child]]]);
  assert.deepEqual(descendants(procs, 10), [child]);
  assert.deepEqual(descendants(procs, 10, true), [root, child]);
  assert.deepEqual(descendants(procs, 99, true), []);
});

test('listening sockets: only LISTEN on any or loopback addresses count', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1776 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
    '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1',
    '   2: 0100007F:1776 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
    '   3: 6440A8C0:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1',
  ].join('\n');
  assert.deepEqual([...listeningSockets(table)], [['111', 6006], ['222', 8080]]);
});

test('a process’s own listening port is found through its fds', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const { port } = server.address() as AddressInfo;
    assert.ok((await listeningPorts([process.pid])).includes(port));
    assert.deepEqual(await listeningPorts([999_999_999]), []);
  } finally {
    server.close();
  }
});
