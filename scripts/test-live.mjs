// Opt-in test: runs a real Codex fixture turn (uses the configured account).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { core, ROOT } from '../lib/context.mjs';
import { bind, unbind } from '../lib/binding.mjs';
import { Rpc } from '../lib/rpc.mjs';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/test-live.mjs /path/to/compatible/khala-link');
const dir = mkdtempSync(join(tmpdir(), 'kcx-'));
const home = join(dir, 'home'), runtime = join(dir, 'runtime'), socket = join(dir, 'app.sock');
const ctx = { home, cwd: dir, identity: 'codex-fixture', node: 'test', root: ROOT };
const env = { ...process.env, KHALA_HOME: home, KHALA_RUNTIME_DIR: runtime };
const children = [];
let rpc, binding;
const logs = [];
function child(command, args) {
  const process = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.on('data', data => logs.push(data.toString()));
  process.stderr.on('data', data => logs.push(data.toString()));
  children.push(process); return process;
}
async function until(condition, timeout = 20000) {
  const started = Date.now();
  while (!condition()) { if (Date.now() - started > timeout) throw new Error('Live-test deadline exceeded.\n' + logs.join('')); await delay(50); }
}
try {
  core(ctx, ['init', 'test']);
  mkdirSync(join(home, 'bin'), { recursive: true });
  symlinkSync(resolve(binary), join(home, 'bin', 'khala-link'));
  writeFileSync(join(dir, '.khala-codex-session'), ctx.identity + '\n');
  child('codex', ['app-server', '--listen', `unix://${socket}`]);
  await until(() => existsSync(socket));
  rpc = await new Rpc(socket).initialize();
  const events = [];
  rpc.onNotification = event => events.push(event);
  const { thread } = await rpc.request('thread/start', { cwd: dir, ephemeral: true,
    baseInstructions: 'You are a Khala transport integration test. When khala_doorbell tool output arrives, respond exactly KHALA_LIVE_ACK. Do not call tools or read files.',
    approvalPolicy: 'never', sandbox: 'read-only' });
  binding = bind(ctx, thread.id, socket);
  child(process.execPath, [join(ROOT, 'lib/bridge.mjs'), join(home, 'run', 'codex', `${ctx.identity}.json`)]);
  await until(() => logs.some(log => log.includes('listening codex-fixture@test')));
  child(resolve(binary), ['conduit']);
  const id = core({ ...ctx, identity: 'claude-fixture' }, ['send', 'codex-fixture@test', '-s', 'native delivery'], { input: 'literal `code` $VALUE\n' }).trim();
  core(ctx, ['reconcile']);
  await until(() => events.some(event => event.method === 'turn/completed'), 90000);
  const items = events.filter(event => event.method === 'item/completed').map(event => event.params.item);
  assert.ok(items.some(item => item.type === 'functionCallOutput' && item.name === 'khala_doorbell'));
  assert.ok(items.some(item => item.type === 'agentMessage' && item.text === 'KHALA_LIVE_ACK'));
  assert.ok(!items.some(item => item.type === 'userMessage'));
  assert.ok(existsSync(join(home, 'inbox', ctx.identity, 'new', id)), 'doorbell must not drain');
  assert.ok(core(ctx, ['inbox', '--drain']).includes('literal `code` $VALUE'));
  const ears = readFileSync(join(home, 'presence', 'conduit@test.ear'), 'utf8');
  assert.match(ears, /name=codex-fixture .*listening=yes route=channel .*cc=codex:/);
  console.log('PASS: shared conduit -> Codex channel -> native tool output -> idle model ACK; unread durability, explicit drain and Codex ear verified.');
} finally {
  if (binding) unbind(ctx, binding.threadId);
  rpc?.close();
  for (const process of children.reverse()) {
    if (process.exitCode !== null || process.signalCode !== null) continue;
    process.kill(); await new Promise(resolve => process.once('exit', resolve));
  }
  rmSync(dir, { recursive: true, force: true });
}
