import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { entries } from './pending.mjs';
import { ROOT } from './context.mjs';
import { serveBinding } from './channel.mjs';

export async function bridge(home, socket, signal) {
  const children = new Map(), retryAt = new Map();
  try {
    while (!signal.aborted) {
      const live = new Set();
      for (const file of entries(join(home, 'run', 'codex'))) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const path = join(home, 'run', 'codex', file.name);
        const binding = JSON.parse(readFileSync(path, 'utf8'));
        if (binding.socket !== socket) continue;
        live.add(binding.token);
        if (children.has(binding.token) || Date.now() < (retryAt.get(binding.token) ?? 0)) continue;
        const child = spawn(process.execPath, [join(ROOT, 'lib/bridge.mjs'), path], { stdio: ['ignore', 'ignore', 'inherit'] });
        children.set(binding.token, child);
        child.on('exit', () => { children.delete(binding.token); retryAt.set(binding.token, Date.now() + 30000); });
        child.on('error', error => console.error(`khala-codex: ${error.message}`));
      }
      for (const [token, child] of children) if (!live.has(token)) child.kill();
      await delay(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  } finally {
    await Promise.all([...children.values()].map(child => new Promise(resolve => {
      child.once('exit', resolve); child.kill();
    })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  try { await serveBinding(JSON.parse(readFileSync(process.argv[2], 'utf8')), controller.signal); }
  catch (error) { console.error(`khala-codex bridge: ${error.message}`); process.exitCode = 1; }
}
