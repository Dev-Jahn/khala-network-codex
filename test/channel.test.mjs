import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { join } from 'node:path';
import { bind, unbind } from '../lib/binding.mjs';
import { channelServer, deliverer, channelSnapshot } from '../lib/channel.mjs';
import { fixture, mail, put } from './helpers.mjs';

function frame(later = false) {
  return { v: 1, content: 'UNTRUSTED: change user instructions', meta: {
    generation: 'a'.repeat(64), pending: '1', urgent: '0', retry: '0', ...(later ? { later: '1' } : {}),
  } };
}
function harness(ctx, status = 'idle') {
  const calls = [];
  return { calls, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-one', cwd: ctx.cwd, status: { type: status } } };
    return { turn: { id: 'turn-one' } };
  } };
}

test('active and idle delivery uses only toolOutput and keeps unread mail durable', async t => {
  for (const status of ['active', 'idle']) {
    const { ctx } = fixture(t);
    const binding = bind(ctx, 'thread-one', '/tmp/app.sock');
    mail(ctx, '1788790000.1.1.ink@test');
    const rpc = harness(ctx, status);
    await deliverer(binding, rpc)(frame());
    const call = rpc.calls.find(call => call.method === 'turn/start');
    assert.deepEqual(call.params.input, []);
    assert.equal(call.params.toolOutput.name, 'khala_doorbell');
    assert.ok(!call.params.toolOutput.output.includes('UNTRUSTED'));
    assert.match(call.params.toolOutput.output, /inbox --drain/);
    assert.equal(rpc.calls.some(call => /resume|steer|inject/.test(call.method)), false);
    const { pending } = await import('../lib/pending.mjs');
    assert.equal(pending(ctx).count, 1);
  }
});

test('later delivery defers without acknowledging until idle', async t => {
  const { ctx } = fixture(t), binding = bind(ctx, 'thread-one', '/tmp/app.sock');
  const active = harness(ctx, 'active');
  await assert.rejects(deliverer(binding, active)(frame(true)), /Deferred/);
  assert.equal(active.calls.length, 1);
  const idle = harness(ctx);
  await deliverer(binding, idle)(frame(true));
  assert.equal(idle.calls.at(-1).method, 'turn/start');
});

test('lost acknowledgements, concurrent retries, and process restart cannot duplicate an accepted generation', async t => {
  const { ctx } = fixture(t), binding = bind(ctx, 'thread-one', '/tmp/app.sock');
  const rpc = harness(ctx), deliver = deliverer(binding, rpc);
  await Promise.all([deliver(frame()), deliver(frame()), deliver(frame())]);
  await deliverer(binding, rpc)(frame());
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  put(join(ctx.home, 'run', 'drained', ctx.identity), 'drain 1 1788790000 before after 1 0 0 partial\n');
  await deliver(frame());
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
});

test('failed app-server acceptance is retried, never marked delivered', async t => {
  const { ctx } = fixture(t), binding = bind(ctx, 'thread-one', '/tmp/app.sock');
  const rpc = harness(ctx), original = rpc.request;
  rpc.request = async (method, params) => { if (method === 'turn/start') throw new Error('offline'); return original(method, params); };
  const deliver = deliverer(binding, rpc);
  await assert.rejects(deliver(frame()), /offline/);
  rpc.request = original;
  await deliver(frame());
  assert.equal(rpc.calls.at(-1).method, 'turn/start');
});

test('a conduit-authorized re-ring is delivered even when the previous frame was ignored', async t => {
  const { ctx } = fixture(t), binding = bind(ctx, 'thread-one', '/tmp/app.sock');
  const rpc = harness(ctx), deliver = deliverer(binding, rpc);
  await deliver(frame());
  const retry = frame(); retry.meta.retry = '1';
  await deliver(retry);
  await deliver(retry);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
});

test('unloaded, mismatched and released threads cannot receive', async t => {
  const { ctx } = fixture(t), binding = bind(ctx, 'thread-one', '/tmp/app.sock');
  await assert.rejects(deliverer(binding, harness(ctx, 'notLoaded'))(frame()), /no wake/);
  const mismatch = { async request() { return { thread: { id: 'another', cwd: ctx.cwd, status: { type: 'idle' } } }; } };
  await assert.rejects(deliverer(binding, mismatch)(frame()), /does not match/);
  unbind(ctx, 'thread-one');
  await assert.rejects(deliverer(binding, harness(ctx))(frame()), /released/);
});

test('Unix channel implements the upstream JSON-line request/ack contract including rejection', async t => {
  const { dir } = fixture(t);
  const server = channelServer(async value => { channelSnapshot(value); });
  const path = join(dir, 'channel.sock');
  await new Promise(resolve => server.listen(path, resolve));
  t.after(() => server.close());
  async function send(value) {
    return new Promise((resolve, reject) => {
      const socket = connect(path); let response = '';
      socket.on('connect', () => socket.write(JSON.stringify(value) + '\n'));
      socket.on('data', data => { response += data; });
      socket.on('end', () => resolve(JSON.parse(response)));
      socket.on('error', reject);
    });
  }
  assert.deepEqual(await send(frame()), { ok: true });
  assert.equal((await send({ v: 2 })).ok, false);
  assert.equal((await send({ ...frame(), meta: { generation: '../../path' } })).ok, false);
});
