import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from '../vendor/ws/wrapper.mjs';
import { Rpc } from '../lib/rpc.mjs';
import { fixture } from './helpers.mjs';

test('Codex RPC upgrades a Unix socket to WebSocket, matches IDs and propagates errors', async t => {
  const { dir } = fixture(t);
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const path = join(dir, 'socket with spaces.sock');
  ws.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes);
    if (request.id === undefined) return;
    if (request.method === 'initialize') { socket.send(JSON.stringify({ id: request.id, result: { userAgent: 'codex/0.153.4 (Linux)' } })); return; }
    if (request.method === 'fail') socket.send(JSON.stringify({ id: request.id, error: { code: -1, message: 'refused' } }));
    else socket.send(JSON.stringify({ id: request.id, result: { method: request.method } }));
  }));
  await new Promise(resolve => http.listen(path, resolve));
  const rpc = new Rpc(path);
  t.after(async () => { rpc.close(); ws.close(); await new Promise(resolve => http.close(resolve)); });
  await rpc.initialize();
  assert.equal(rpc.serverInfo.userAgent, 'codex/0.153.4 (Linux)');
  assert.deepEqual(await rpc.request('thread/read', {}), { method: 'thread/read' });
  await assert.rejects(rpc.request('fail', {}), /refused/);
  const responses = await Promise.all([rpc.request('one', {}), rpc.request('two', {})]);
  assert.deepEqual(responses, [{ method: 'one' }, { method: 'two' }]);
});

test('missing App Server socket fails without starting a daemon or creating a thread', async t => {
  const { dir } = fixture(t);
  const rpc = new Rpc(join(dir, 'missing.sock'));
  t.after(() => rpc.close());
  await assert.rejects(rpc.initialize(), /ENOENT/);
});
