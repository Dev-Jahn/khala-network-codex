import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJSON, bind, bindingPath, unbind } from '../lib/binding.mjs';
import { deliverer } from '../lib/channel.mjs';
import { activity, processInfo, queueReceiver } from '../lib/queue.mjs';
import { fixture, mail, put } from './helpers.mjs';

function setup(t) {
  const { ctx, dir } = fixture(t);
  const codex = join(dir, 'codex');
  put(codex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 0.153.4');
else if (!args.includes('--help')) {
  if (fs.existsSync(${JSON.stringify(join(dir, 'fail'))})) process.exit(1);
  fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify({args, home:process.env.CODEX_HOME})+'\\n');
}
`);
  put(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(codex, 0o755);
  const binding = { ...bind(ctx, 'thread-one'), codex, codexHome: join(dir, 'codex-home'), owner: processInfo(process.pid) };
  atomicJSON(bindingPath(binding), binding);
  const calls = () => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const frame = { v: 1, content: 'PEER BODY MUST NOT BECOME USER INPUT', meta: { generation: 'a'.repeat(64), pending: '1', urgent: '0', retry: '0' } };
  return { ctx, dir, binding, calls, frame };
}

test('queue delivery targets the bound thread/home, sends only a fixed doorbell, and retains unread mail', async t => {
  const { ctx, binding, calls, frame } = setup(t);
  mail(ctx, '1788790000.1.1.ink@test');
  const receiver = await queueReceiver(binding);
  const deliver = deliverer(binding, null, receiver);
  await Promise.all([deliver(frame), deliver(frame)]);
  await deliverer(binding, null, await queueReceiver(binding))(frame);
  assert.equal(calls().length, 1);
  const call = calls()[0];
  assert.equal(call.home, binding.codexHome);
  assert.deepEqual(call.args.slice(0, 4), ['queue', '--thread', 'thread-one', '--message']);
  assert.match(call.args[4], /^KHALA-CODEX\/1/);
  assert.ok(!call.args[4].includes('PEER BODY'));
  assert.ok(existsSync(join(ctx.home, 'inbox', ctx.identity, 'new', '1788790000.1.1.ink@test')));
  await deliver({ ...frame, meta: { ...frame.meta, retry: '1' } });
  assert.equal(calls().length, 2);
});

test('later waits for Stop/Interrupt, ignores stale turns, and does not ring twice', async t => {
  const { binding, calls, frame } = setup(t);
  frame.meta.later = '1';
  const deliver = deliverer(binding, null, await queueReceiver(binding));
  activity(binding, { session_id: binding.threadId, hook_event_name: 'UserPromptSubmit', turn_id: 'one' });
  await assert.rejects(deliver(frame), /Deferred/);
  activity(binding, { session_id: binding.threadId, hook_event_name: 'Stop', turn_id: 'old' });
  await assert.rejects(deliver(frame), /Deferred/);
  activity(binding, { session_id: binding.threadId, hook_event_name: 'Stop', turn_id: 'one', stop_hook_active: true });
  await assert.rejects(deliver(frame), /Deferred/);
  activity(binding, { session_id: binding.threadId, hook_event_name: 'Stop', turn_id: 'one' });
  await deliver(frame);
  await deliver(frame);
  assert.equal(calls().length, 1);
});

test('queue failures are retried and dead/reused owners or released bindings cannot enqueue', async t => {
  const { dir, binding, calls, frame } = setup(t);
  const deliver = deliverer(binding, null, await queueReceiver(binding));
  put(join(dir, 'fail'), '');
  await assert.rejects(deliver(frame));
  assert.equal(calls().length, 0);
  assert.equal(existsSync(join(binding.home, 'run', 'codex', `${binding.token}.delivery`)), false);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(dir, 'fail'));
  await deliver(frame);
  const stale = { ...binding, owner: { ...binding.owner, started: 'another-process' } };
  await assert.rejects(deliverer(stale, null, await queueReceiver(stale))(frame), /process has exited/);
  unbind(binding, binding.threadId);
  await assert.rejects(deliver(frame), /released/);
  assert.equal(calls().length, 1);
});

test('shutdown during queue acceptance cannot recreate released delivery state', async t => {
  const { binding, frame, calls } = setup(t);
  const receiver = await queueReceiver(binding), send = receiver.send;
  receiver.send = async text => { await send(text); unbind(binding, binding.threadId); };
  await deliverer(binding, null, receiver)(frame);
  assert.equal(calls().length, 1);
  assert.equal(existsSync(join(binding.home, 'run', 'codex', `${binding.token}.delivery`)), false);
});
