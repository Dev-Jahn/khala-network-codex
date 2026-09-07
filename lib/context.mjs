import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CORE = join(ROOT, 'vendor/khala/khala');
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = new Set(['conduit', 'khala', 'khala-gateway', 'gateway', 'operator']);

export function identity(cwd, env = process.env) {
  let value = env.KHALA_SESSION;
  if (value === undefined) {
    const path = join(cwd, '.khala-codex-session');
    if (!existsSync(path)) throw new Error('Set KHALA_SESSION or create a one-line .khala-codex-session in the project.');
    value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  }
  if (!NAME.test(value) || RESERVED.has(value)) throw new Error('Invalid or reserved Khala identity. Use [a-z0-9][a-z0-9-]*.');
  return value;
}

export function context(cwd = process.cwd(), env = process.env) {
  const home = env.KHALA_HOME ?? join(homedir(), '.khala');
  if (!home) throw new Error('KHALA_HOME is empty.');
  const config = readFileSync(join(home, 'config'), 'utf8');
  const nodes = [...config.matchAll(/^self (\S+)$/gm)];
  if (nodes.length !== 1 || !NAME.test(nodes[0][1])) throw new Error('Khala config must declare exactly one valid self node.');
  return { home: resolve(home), cwd: realpathSync(cwd), identity: identity(cwd, env), node: nodes[0][1] };
}

export function link(ctx, args) {
  const binary = join(ctx.home, 'bin', 'khala-link');
  const result = spawnSync(binary, args, {
    env: { ...process.env, KHALA_HOME: ctx.home }, encoding: 'utf8', timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `khala-link exited ${result.status}`);
  return result.stdout.trim();
}

export function core(ctx, args, options = {}) {
  const result = spawnSync('bash', [CORE, ...args], {
    cwd: ctx.cwd, env: { ...process.env, KHALA_HOME: ctx.home, KHALA_SESSION: ctx.identity,
      ...(process.env.CODEX_THREAD_ID ? { KHALA_HARNESS_SESSION_ID: process.env.CODEX_THREAD_ID } : {}) },
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `khala exited ${result.status}`);
  return result.stdout;
}
