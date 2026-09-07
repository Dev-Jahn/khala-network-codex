import { existsSync, mkdtempSync, openSync, closeSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { bridge } from './bridge.mjs';
import { context, core, link } from './context.mjs';
import { Rpc } from './rpc.mjs';
import { entries, optionalText } from './pending.mjs';
import { unbind } from './binding.mjs';

export function nativeConduitReady(ctx, now = Math.floor(Date.now() / 1000)) {
  const ear = optionalText(join(ctx.home, 'presence', `conduit@${ctx.node}.ear`));
  const version = ear.match(/^component conduit release=(\d+\.\d+\.\d+) /m)?.[1];
  const written = Number(ear.match(/^written-at (\d+)$/m)?.[1]);
  return ear.startsWith('ears 1\n') && ear.includes(`\nnode ${ctx.node}\n`) && /^state running$/m.test(ear) &&
    written <= now && now - written <= 180 && Boolean(version) && version.localeCompare('0.9.7', undefined, { numeric: true }) >= 0;
}

export async function launch(args) {
  const ctx = context();
  const version = link(ctx, ['version']);
  if (version.localeCompare('0.9.7', undefined, { numeric: true }) < 0) throw new Error('Automatic receive requires khala-link >= 0.9.7. Run khala-codex setup first.');
  // The shared node owns transport/conduit lifecycle. Starting it is idempotent.
  core(ctx, ['node', 'ensure']);
  for (let attempt = 0; !nativeConduitReady(ctx); attempt++) {
    if (attempt === 50) throw new Error('The running Khala conduit has no fresh 0.9.7+ ear. Restart the shared conduit after upgrading, and inspect khala-codex status.');
    await delay(100);
  }
  const dir = mkdtempSync(join(tmpdir(), 'khala-codex-'));
  const socket = join(dir, 'app.sock');
  const logPath = join(ctx.home, 'log', 'codex-app-server.log');
  const log = openSync(logPath, 'a', 0o600);
  const env = { ...process.env, KHALA_CODEX_SOCKET: socket };
  const server = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { env, stdio: ['ignore', log, log] });
  closeSync(log);
  let serverError;
  server.on('error', error => { serverError = error; });
  const controller = new AbortController();
  let runningBridge, tui;
  try {
    for (let attempt = 0; !existsSync(socket); attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null || attempt >= 100) throw new Error(`Codex App Server did not start; see ${logPath}`);
      await delay(100);
    }
    const rpc = new Rpc(socket);
    try { await rpc.initialize(); } finally { rpc.close(); }
    runningBridge = bridge(ctx.home, socket, controller.signal);
    tui = spawn('codex', ['--remote', `unix://${socket}`, ...args], { env, stdio: 'inherit' });
    const stop = () => { controller.abort(); tui.kill(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    server.once('exit', stop);
    const code = await new Promise((resolve, reject) => { tui.once('exit', resolve); tui.once('error', reject); });
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    server.removeListener('exit', stop);
    return code ?? 1;
  } finally {
    controller.abort();
    if (runningBridge) await runningBridge;
    for (const file of entries(join(ctx.home, 'run', 'codex'))) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const binding = JSON.parse(readFileSync(join(ctx.home, 'run', 'codex', file.name), 'utf8'));
      if (binding.socket === socket) unbind(binding, binding.threadId);
    }
    if (tui && tui.exitCode === null) tui.kill();
    server.kill();
    await new Promise(resolve => { if (serverError || server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
    rmSync(dir, { recursive: true, force: true });
  }
}
