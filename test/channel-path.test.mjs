import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ROOT } from '../lib/context.mjs';
import { bind } from '../lib/binding.mjs';
import { serveBinding } from '../lib/channel.mjs';
import { fixture, put } from './helpers.mjs';

test('receiver fits the macOS default runtime path and registers its exact instance socket', async t => {
  const { ctx } = fixture(t);
  const parent = realpathSync(mkdtempSync('/tmp/khala-path-'));
  t.after(() => rmSync(parent, { recursive: true }));
  // Same byte length as the reported macOS /var/folders/.../T/khala-501 root.
  const runtime = join(parent, 'r'.repeat(58 - Buffer.byteLength(parent) - 1));
  mkdirSync(join(runtime, 'channels'), { recursive: true, mode: 0o700 });
  assert.equal(Buffer.byteLength(join(runtime, 'channels', 'a'.repeat(36) + '.sock')), 109);

  // Execute from the checkout because /tmp can be mounted noexec.
  const bin = mkdtempSync(join(ROOT, '.channel-path-test-'));
  t.after(() => rmSync(bin, { recursive: true }));
  put(join(ctx.home, 'runtime-root'), runtime);
  put(join(bin, 'khala-link'), `#!/usr/bin/env node
import fs from 'node:fs'; import { join } from 'node:path'; import assert from 'node:assert/strict';
const args = process.argv.slice(2), home = process.env.KHALA_HOME;
const root = fs.readFileSync(join(home, 'runtime-root'), 'utf8');
const state = join(home, 'registration.json');
const flag = name => args[args.indexOf(name) + 1];
switch (args[1]) {
  case 'root': console.log(root); break;
  case 'register':
    fs.writeFileSync(state, JSON.stringify({ instance: flag('--instance') }));
    console.log('owner yes'); break;
  case 'register-channel': {
    const registration = JSON.parse(fs.readFileSync(state));
    const socket = flag('--channel-socket');
    assert.equal(socket, join(root, 'channels', registration.instance + '.sock'));
    assert.ok(Buffer.byteLength(socket) < 104, 'macOS sockaddr_un.sun_path budget');
    assert.ok(fs.lstatSync(socket).isSocket());
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    fs.writeFileSync(state, JSON.stringify({ ...registration, socket, verified: true }));
    break;
  }
  case 'release': break;
  default: throw new Error('Unexpected runtime operation');
}
`);
  chmodSync(join(bin, 'khala-link'), 0o755);
  const { symlinkSync } = await import('node:fs');
  mkdirSync(join(ctx.home, 'bin'), { recursive: true });
  symlinkSync(join(bin, 'khala-link'), join(ctx.home, 'bin', 'khala-link'));
  const binding = bind(ctx, 'thread-one'), controller = new AbortController(), received = [];
  const receiver = { version: '0.153.4', thread: () => ({ status: { type: 'idle' } }), send: text => received.push(text) };
  let ready;
  const listening = new Promise(resolve => { ready = resolve; });
  const running = serveBinding(binding, controller.signal, receiver, ready);
  let path;
  try {
    await Promise.race([listening, running]);
    const registration = JSON.parse(readFileSync(join(ctx.home, 'registration.json')));
    assert.equal(registration.verified, true);
    path = registration.socket;
    assert.ok(Buffer.byteLength(path) < 104);
    const response = await new Promise((resolve, reject) => {
      const socket = connect(path); let reply = '';
      socket.on('connect', () => socket.write(JSON.stringify({ v: 1, content: 'PEER BODY',
        meta: { generation: 'a'.repeat(64), pending: '1', urgent: '0', retry: '0' } }) + '\n'));
      socket.on('data', data => { reply += data; });
      socket.on('end', () => resolve(JSON.parse(reply)));
      socket.on('error', reject);
    });
    assert.deepEqual(response, { ok: true });
    assert.equal(received.length, 1);
    assert.ok(!received[0].includes('PEER BODY'));
  } finally { controller.abort(); await running; }
  assert.equal(existsSync(path), false);
});
