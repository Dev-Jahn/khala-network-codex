import { chmodSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { link, ROOT } from './context.mjs';
import { atomicJSON, readBinding } from './binding.mjs';
import { drainToken, doorbell, optionalText } from './pending.mjs';
import { Rpc } from './rpc.mjs';

export function channelSnapshot(frame) {
  if (frame?.v !== 1 || typeof frame.content !== 'string' || !frame.meta || typeof frame.meta !== 'object') throw new Error('Invalid Khala channel frame.');
  const meta = frame.meta;
  if (!/^[a-f0-9]{64}$/.test(meta.generation)) throw new Error('Invalid Khala generation.');
  const number = key => {
    if (!/^\d{1,9}$/.test(meta[key])) throw new Error(`Invalid Khala ${key} count.`);
    return Number(meta[key]);
  };
  return { letters: number('pending'), notices: number('urgent'), streams: 0,
    generation: meta.generation, retry: number('retry'), later: meta.later === '1' };
}

export async function loadedThread(rpc, binding) {
  const { thread } = await rpc.request('thread/read', { threadId: binding.threadId, includeTurns: false });
  if (thread.id !== binding.threadId || realpathSync(thread.cwd) !== binding.cwd) throw new Error('Codex thread/cwd does not match its Khala binding.');
  if (!['active', 'idle'].includes(thread.status.type)) throw new Error(`Codex thread is ${thread.status.type}; no wake permitted.`);
  return thread;
}

// Receipt means the selected receiver accepted a doorbell, never that mail was read.
// Persist accepted generations so a lost channel ACK cannot enqueue duplicates.
export function deliverer(binding, rpc, receiver = {
  thread: () => loadedThread(rpc, binding),
  send: text => rpc.request('turn/start', { threadId: binding.threadId, input: [],
    toolOutput: { name: 'khala_doorbell', namespace: 'khala', output: text } }),
}) {
  const statePath = join(binding.home, 'run', 'codex', `${binding.token}.delivery`);
  let inFlight = Promise.resolve();
  return frame => {
    const work = inFlight.then(async () => {
      const snapshot = channelSnapshot(frame);
      const current = readBinding(binding);
      if (current?.token !== binding.token) throw new Error('Khala binding has been released or replaced.');
      const thread = await receiver.thread();
      if (readBinding(binding)?.token !== binding.token) throw new Error('Khala binding changed during delivery verification.');
      if (snapshot.later && thread.status.type === 'active') throw new Error('Deferred until Codex is idle (Priority: later).');
      const drained = drainToken(binding);
      const previous = optionalText(statePath);
      if (previous) {
        const accepted = JSON.parse(previous);
        if (accepted.generation === snapshot.generation && accepted.drained === drained && accepted.retry === snapshot.retry) return;
      }
      await receiver.send(doorbell({ ...binding, root: ROOT }, snapshot));
      if (readBinding(binding)?.token !== binding.token) return;
      atomicJSON(statePath, { generation: snapshot.generation, retry: snapshot.retry, drained });
    });
    inFlight = work.catch(() => {});
    return work;
  };
}

export function channelServer(deliver) {
  return createServer(socket => {
    let text = '', handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      text += chunk;
      if (Buffer.byteLength(text) > 65536) { handled = true; socket.end('{"ok":false,"error":"frame too large"}\n'); return; }
      if (!text.includes('\n')) return;
      handled = true;
      Promise.resolve().then(() => deliver(JSON.parse(text.slice(0, text.indexOf('\n'))))).then(
        () => { if (!socket.destroyed) socket.end('{"ok":true}\n'); },
        error => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n'); },
      );
    });
  });
}

export async function serveBinding(binding, signal, receiver, ready = () => {}) {
  const rpc = receiver ? null : new Rpc(binding.socket);
  const instance = randomUUID();
  let server, socketPath, registered = false;
  try {
    if (rpc) await rpc.initialize();
    if (receiver) await receiver.thread(); else await loadedThread(rpc, binding);
    const version = receiver?.version ?? rpc.serverInfo.userAgent.match(/^[^/\s]+\/([A-Za-z0-9._:+-]+)(?:\s|$)/)?.[1];
    if (!version) throw new Error('Codex App Server did not report a recognizable version.');
    const runtime = link(binding, ['runtime', 'root']);
    socketPath = join(runtime, 'channels', `${instance}.sock`);
    const registration = link(binding, ['runtime', 'register', '--identity', binding.identity,
      '--instance', instance, '--session-id', binding.threadId, '--harness', 'codex',
      '--kind', 'interactive', '--phase', 'ready', '--pid', String(process.pid),
      '--caller-pid', String(process.pid), '--cc-version', version]);
    registered = true;
    if (!/^owner yes$/m.test(registration)) throw new Error('Khala identity lease is owned by another session.');
    server = channelServer(deliverer(binding, rpc, receiver));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    link(binding, ['runtime', 'register-channel', '--instance', instance, '--session-id', binding.threadId,
      '--channel-socket', socketPath, '--caller-pid', String(process.pid), '--verified']);
    console.error(`khala-codex: listening ${binding.identity}@${binding.node} thread=${binding.threadId}`);
    ready();
    while (!signal.aborted && readBinding(binding)?.token === binding.token) {
      await delay(2000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      if (!signal.aborted && readBinding(binding)?.token === binding.token) {
        if (receiver) await receiver.thread(); else await loadedThread(rpc, binding);
      }
    }
  } finally {
    if (server) server.close();
    if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
    rpc?.close();
    if (registered) link(binding, ['runtime', 'release', '--instance', instance, '--session-id', binding.threadId, '--caller-pid', String(process.pid)]);
  }
}
