import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { context, ROOT, CORE } from '../lib/context.mjs';

export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'khala-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'mail');
  const initialized = spawnSync('bash', [CORE, 'init', 'test'], { env: { ...process.env, KHALA_HOME: home }, encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  writeFileSync(join(home, 'config'), 'self test\npeer test test\nmailbox test\nttl 120\n');
  writeFileSync(join(dir, '.khala-codex-session'), 'codex-test\n');
  const ctx = { ...context(dir, { KHALA_HOME: home }), root: ROOT };
  return { ctx, dir, home };
}

export function put(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

export function mail(ctx, id, headers = '', body = 'literal `code` $VALUE\n한국어') {
  put(join(ctx.home, 'inbox', ctx.identity, 'new', id),
    `Khala: 0.1\nId: ${id}\nFrom: ink@test\nTo: ${ctx.identity}@test\nDate: 2026-09-07T00:00:00Z\nType: message\nSubject: test\nExpires: 9999999999\n${headers}\n${body}\n`);
}
