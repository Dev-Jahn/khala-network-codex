import { accessSync, closeSync, constants, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ROOT } from './context.mjs';
import { atomicJSON, bindingPath, readBinding, unbind } from './binding.mjs';
import { optionalText } from './pending.mjs';
import { serveBinding } from './channel.mjs';
import { ensureConduit } from './launch.mjs';
import { codexOwner, processAlive, processInfo } from './process.mjs';

export { codexOwner, processAlive, processInfo };

const run = promisify(execFile);
const statePath = (binding, suffix) => join(binding.home, 'run', 'codex', `${binding.token}.${suffix}`);

function codexExecutable() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, 'codex');
    try { accessSync(path, constants.X_OK); return realpathSync(path); }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('Automatic receive requires codex on the hook PATH.');
}

export function activity(binding, event) {
  if (binding.socket || binding.threadId !== event.session_id) return;
  const path = statePath(binding, 'activity');
  const previous = optionalText(path);
  const state = previous ? JSON.parse(previous) : {};
  if (event.hook_event_name === 'UserPromptSubmit') {
    atomicJSON(path, { active: true, turnId: event.turn_id });
  } else if (['Stop', 'Interrupt'].includes(event.hook_event_name) &&
    !event.stop_hook_active && (!state.turnId || state.turnId === event.turn_id)) {
    atomicJSON(path, { active: false, turnId: event.turn_id });
  }
}

export async function queueReceiver(binding) {
  const env = { ...process.env, CODEX_HOME: binding.codexHome };
  const options = { cwd: binding.cwd, env, encoding: 'utf8', timeout: 8000 };
  const { stdout } = await run(binding.codex, ['--version'], options);
  const version = stdout.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
  if (!version || version.localeCompare('0.153.4', undefined, { numeric: true }) < 0) {
    throw new Error('Automatic queue receive requires Codex CLI 0.153.4+.');
  }
  await run(binding.codex, ['queue', '--help'], options);
  return {
    version,
    thread() {
      if (!processAlive(binding.owner)) throw new Error('The owning Codex process has exited.');
      const text = optionalText(statePath(binding, 'activity'));
      const active = !text || JSON.parse(text).active;
      return { status: { type: active ? 'active' : 'idle' } };
    },
    async send(text) {
      if (!processAlive(binding.owner)) throw new Error('The owning Codex process has exited.');
      await run(binding.codex, ['queue', '--thread', binding.threadId, '--message', text, '-C', binding.cwd], options);
    },
  };
}

// SessionStart waits for verified channel registration, then releases the hook.
// The detached child owns its own log/IPC, not the hook's stdout or lifetime.
export async function startQueue(binding, source) {
  const owner = codexOwner();
  if (binding.owner && processAlive(binding.owner) &&
    (binding.owner.pid !== owner.pid || binding.owner.started !== owner.started)) {
    throw new Error('This Khala thread is still open in another Codex process.');
  }
  if (binding.owner && !processAlive(binding.owner)) {
    unbind(binding, binding.threadId);
    binding = { ...binding, token: randomUUID() };
  }
  binding = { ...binding, owner, codex: codexExecutable(),
    codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')) };
  atomicJSON(bindingPath(binding), binding);
  if (!optionalText(statePath(binding, 'activity'))) {
    atomicJSON(statePath(binding, 'activity'), { active: source === 'compact' });
  }
  const log = openSync(join(binding.home, 'log', `codex-${binding.identity}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [join(ROOT, 'lib/queue.mjs'), bindingPath(binding)], {
    detached: true, stdio: ['ignore', log, log, 'ipc'],
  });
  closeSync(log);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Queue bridge startup timed out; inspect the session log.')); }, 25000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('exit', code => finish(new Error(`Queue bridge exited ${code}; inspect ${binding.home}/log/codex-${binding.identity}.log.`)));
    child.once('message', message => finish(message.ready ? null : new Error(message.error)));
  });
  if (child.connected) child.disconnect();
  child.unref();
  return binding;
}

async function serveQueue(binding, signal) {
  const path = statePath(binding, 'receiver');
  // Atomic ownership also coalesces concurrent hook/CLI startup attempts.
  const owner = processInfo(process.pid);
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ owner, ready: false }), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const text = optionalText(path);
      if (!text) continue;
      const previous = JSON.parse(text);
      if (!processAlive(previous.owner)) { unlinkSync(path); continue; }
      if (previous.ready) { if (process.connected) process.send({ ready: true }); return; }
      await delay(100, undefined, { signal });
    }
  }
  try {
    const receiver = await queueReceiver(binding);
    await ensureConduit(binding);
    await serveBinding(binding, signal, receiver, () => {
      atomicJSON(path, { owner, ready: true });
      if (process.connected) process.send({ ready: true });
    });
  } finally {
    unlinkSync(path);
    if (!processAlive(binding.owner) && readBinding(binding)?.token === binding.token) unbind(binding, binding.threadId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try { await serveQueue(JSON.parse(readFileSync(process.argv[2], 'utf8')), controller.signal); }
  catch (error) {
    if (process.connected) process.send?.({ error: error.message });
    console.error(`khala-codex queue: ${error.message}`);
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
}
