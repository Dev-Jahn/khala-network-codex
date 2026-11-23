import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/context.mjs';
import { Refusal, trustHooks } from '../lib/trust.mjs';
import { put } from './helpers.mjs';

// A stand-in `codex` on PATH whose App Server answers initialize and
// hooks/list with the hooks given in STUB_HOOKS (pluginId, eventName, trustStatus),
// loaded from the plugin directory STUB_ROOT. It appends every config/batchWrite
// to STUB_WRITES and from then on lists the hooks recorded there as trusted.
const STUB = `#!${process.execPath}
const { createInterface } = require('node:readline');
if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') process.exit(2);
const fs = require('node:fs');
const writes = process.env.STUB_WRITES;
const recorded = () => writes && fs.existsSync(writes) ? fs.readFileSync(writes, 'utf8') : '';
const hooks = () => JSON.parse(process.env.STUB_HOOKS).map(([pluginId, eventName, trustStatus]) => ({ pluginId, eventName,
  key: pluginId + ':' + eventName, currentHash: 'sha256:' + eventName, sourcePath: process.env.STUB_ROOT + '/hooks/hooks.json',
  trustStatus: recorded().includes('"' + pluginId + ':' + eventName + '"') ? 'trusted' : trustStatus }));
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
  if (method === 'hooks/list') console.log(JSON.stringify({ id, result: { data: [{ cwd: '/', hooks: hooks(), warnings: [], errors: [] }] } }));
  if (method === 'config/batchWrite') { fs.appendFileSync(writes, JSON.stringify(params) + '\\n'); console.log(JSON.stringify({ id, result: {} })); }
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

test('trust-hooks: records trust for this plugin only when the installed copy is the published release, byte for byte', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The installed copy as Codex keeps it: a clone of the release commit.
  const root = join(dir, 'cache', 'khala-network-codex', '9.9.9'), writes = join(dir, 'writes');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args], { maxBuffer: 1 << 24 });
  put(join(root, '.codex-plugin', 'plugin.json'), '{"version":"9.9.9"}');
  put(join(root, 'hooks', 'hooks.json'), '{}');
  put(join(root, 'hooks', 'hook.mjs'), 'published\n');
  put(join(root, 'docs', 'a'.repeat(120), 'deep.md'), 'a path too long for a plain tar header\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'release');
  const sha = git('rev-parse', 'HEAD').stdout.toString().trim();
  const archive = git('archive', '--format=tar.gz', `--prefix=khala-network-codex-${sha}/`, 'HEAD').stdout;
  const marketplace = JSON.stringify({ plugins: [{ name: 'khala-network-codex', version: '9.9.9',
    source: { source: 'url', url: 'https://github.com/Dev-Jahn/khala-network-codex.git', sha } }] });
  const fetched = [];
  const download = async url => { fetched.push(url); return url.endsWith('marketplace.json') ? Buffer.from(marketplace) : archive; };

  put(join(dir, 'bin', 'codex'), STUB); chmodSync(join(dir, 'bin', 'codex'), 0o755);
  const stub = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_ROOT: root, STUB_WRITES: writes,
    STUB_HOOKS: JSON.stringify([[OURS, 'sessionStart', 'modified'], ['other@test-market', 'stop', 'modified'], [OURS, 'stop', 'trusted']]) };
  const path = process.env.PATH;
  t.after(() => { for (const name of Object.keys(stub)) delete process.env[name]; process.env.PATH = path; });
  Object.assign(process.env, stub);

  // One altered file: refused, and nothing is written.
  appendFileSync(join(root, 'hooks', 'hook.mjs'), 'tampered\n');
  await assert.rejects(trustHooks(download), error => error instanceof Refusal && /: hooks\/hook\.mjs differs$/.test(error.message));
  put(join(root, 'hooks', 'extra.mjs'), '');
  await assert.rejects(trustHooks(download), error => error instanceof Refusal && /: hooks\/extra\.mjs is not in the release; hooks\/hook\.mjs differs$/.test(error.message));
  assert.ok(!existsSync(writes));

  // The published bytes: exactly this plugin's untrusted hook is recorded.
  rmSync(join(root, 'hooks', 'extra.mjs'));
  put(join(root, 'hooks', 'hook.mjs'), 'published\n');
  assert.deepEqual(await trustHooks(download), [{ eventName: 'sessionStart', was: 'modified', now: 'trusted' }, { eventName: 'stop', was: 'trusted', now: 'trusted' }]);
  assert.deepEqual(readFileSync(writes, 'utf8').trim().split('\n').map(JSON.parse), [{ edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert',
    value: { [`${OURS}:sessionStart`]: { trusted_hash: 'sha256:sessionStart' } } }] }]);
  assert.deepEqual(fetched.slice(-2), ['https://raw.githubusercontent.com/Dev-Jahn/jahns-codex-marketplace/main/.agents/plugins/marketplace.json',
    `https://github.com/Dev-Jahn/khala-network-codex/archive/${sha}.tar.gz`]);
});
