import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/context.mjs';
import { put } from './helpers.mjs';

// A stand-in `codex` on PATH whose App Server answers initialize and
// hooks/list with the hooks given in STUB_HOOKS (pluginId, eventName, trustStatus).
const STUB = `#!${process.execPath}
const { createInterface } = require('node:readline');
if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') process.exit(2);
const hooks = JSON.parse(process.env.STUB_HOOKS).map(([pluginId, eventName, trustStatus]) => ({ pluginId, eventName, trustStatus }));
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
  if (method === 'hooks/list') console.log(JSON.stringify({ id, result: { data: [{ cwd: '/', hooks, warnings: [], errors: [] }] } }));
});
`;
const OURS = 'khala-network-codex@test-market';

function hooks(t, listed) {
  const dir = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  if (listed) { put(join(dir, 'bin', 'codex'), STUB); chmodSync(join(dir, 'bin', 'codex'), 0o755); }
  return spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), 'hooks'],
    { env: { PATH: join(dir, 'bin'), HOME: dir, STUB_HOOKS: JSON.stringify(listed ?? []) }, encoding: 'utf8' });
}

test('hooks: the exit status tells trusted (0), not trusted (3) and undetermined (4) apart', t => {
  const trusted = hooks(t, [[OURS, 'sessionStart', 'trusted'], ['other@test-market', 'stop', 'modified'], [OURS, 'postToolUse', 'trusted']]);
  assert.deepEqual([trusted.status, trusted.stdout, trusted.stderr], [0, 'sessionStart\ttrusted\npostToolUse\ttrusted\n', '']);

  const lapsed = hooks(t, [[OURS, 'sessionStart', 'trusted'], [OURS, 'postToolUse', 'modified'], [OURS, 'stop', 'untrusted']]);
  assert.deepEqual([lapsed.status, lapsed.stdout], [3, 'sessionStart\ttrusted\npostToolUse\tmodified\nstop\tuntrusted\n']);

  // Nothing to judge is never reported as trusted.
  for (const unknown of [hooks(t, [['other@test-market', 'stop', 'trusted']]), hooks(t, null)]) {
    assert.deepEqual([unknown.status, unknown.stdout], [4, '']);
    assert.match(unknown.stderr, /^khala-codex: hook trust could not be checked: .+\n$/);
  }
});
