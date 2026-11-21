import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servedAt } from './gate.ts';

const serve = (proxy: string, hostPort = 'box.tail1234.ts.net:443') => ({ Web: { [hostPort]: { Handlers: { '/': { Proxy: proxy } } } } });

test('the address Serve publishes ah at', () => {
  assert.equal(servedAt(serve('http://127.0.0.1:7777'), 7777), 'https://box.tail1234.ts.net');
  assert.equal(servedAt(serve('http://localhost:7777/'), 7777), 'https://box.tail1234.ts.net');
  // Served on another https port: the address keeps it.
  assert.equal(servedAt(serve('http://127.0.0.1:7777', 'box.tail1234.ts.net:8443'), 7777), 'https://box.tail1234.ts.net:8443');
});

test('no address when Serve forwards somewhere else, or nowhere', () => {
  assert.equal(servedAt(serve('http://127.0.0.1:77770'), 7777), null);
  assert.equal(servedAt(serve('http://127.0.0.1:5173'), 7777), null);
  assert.equal(servedAt(serve('http://10.0.0.2:7777'), 7777), null);
  assert.equal(servedAt({}, 7777), null);
  assert.equal(servedAt({ Web: { 'box.tail1234.ts.net:443': {} } }, 7777), null);
});
