import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/context.mjs';
import { Refusal, setAutoTrusted, trustHooks } from '../lib/trust.mjs';

const MARKETPLACE = 'https://raw.githubusercontent.com/Dev-Jahn/jahns-codex-marketplace/main/.agents/plugins/marketplace.json';
import { put } from './helpers.mjs';

// A stand-in `codex` on PATH whose App Server answers initialize and
// hooks/list with the hooks given in STUB_HOOKS (pluginId, eventName, trustStatus),
// each plugin loaded from STUB_ROOT/<plugin name>/9.9.9. It appends every config/batchWrite
// to STUB_WRITES and from then on lists the hooks recorded there as trusted.
const STUB = `#!${process.execPath}
const { createInterface } = require('node:readline');
if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') process.exit(2);
const fs = require('node:fs');
const writes = process.env.STUB_WRITES;
const recorded = () => writes && fs.existsSync(writes) ? fs.readFileSync(writes, 'utf8') : '';
const hooks = () => JSON.parse(process.env.STUB_HOOKS).map(([pluginId, eventName, trustStatus]) => ({ pluginId, eventName,
  key: pluginId + ':' + eventName, currentHash: 'sha256:' + eventName, sourcePath: process.env.STUB_ROOT + '/' + pluginId.split('@')[0] + '/9.9.9/hooks/hooks.json',
  trustStatus: recorded().includes('"' + pluginId + ':' + eventName + '"') ? 'trusted' : trustStatus }));
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
  if (method === 'hooks/list') console.log(JSON.stringify({ id, result: { data: [{ cwd: '/', hooks: hooks(), warnings: [], errors: [] }] } }));
  if (method === 'config/batchWrite') { fs.appendFileSync(writes, JSON.stringify(params) + '\\n'); console.log(JSON.stringify({ id, result: {} })); }
});
`;
const OURS = 'khala-network-codex@jahns-codex-marketplace';

// Runs khala-codex with the stand-in codex listing `listed` (none on PATH when null).
function cli(t, listed, args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  if (listed) { put(join(dir, 'bin', 'codex'), STUB); chmodSync(join(dir, 'bin', 'codex'), 0o755); }
  return spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), ...args],
    { env: { PATH: join(dir, 'bin'), HOME: dir, STUB_ROOT: dir, STUB_HOOKS: JSON.stringify(listed ?? []), ...env }, encoding: 'utf8' });
}
const hooks = (t, listed) => cli(t, listed, ['hooks']);

// Installs `plugin` below `cache` the way Codex keeps it, a clone of the
// release commit, and returns that commit with its GitHub archive.
function release(cache, plugin, repository = plugin) {
  const root = join(cache, plugin, '9.9.9');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args], { maxBuffer: 1 << 24 });
  put(join(root, '.codex-plugin', 'plugin.json'), '{"version":"9.9.9"}');
  put(join(root, 'hooks', 'hooks.json'), '{}');
  put(join(root, 'hooks', 'hook.mjs'), 'published\n');
  put(join(root, 'docs', 'a'.repeat(120), 'deep.md'), 'a path too long for a plain tar header\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'release');
  const sha = git('rev-parse', 'HEAD').stdout.toString().trim();
  return { root, sha, archive: git('archive', '--format=tar.gz', `--prefix=${repository}-${sha}/`, 'HEAD').stdout };
}

// Points this process at the stand-in codex until the test ends. One copy
// serves every test here, since a command's full path is looked up only once.
const BIN = mkdtempSync(join(tmpdir(), 'khala-trust-bin-'));
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));
put(join(BIN, 'codex'), STUB); chmodSync(join(BIN, 'codex'), 0o755);
function standIn(t, dir, cache, listed) {
  const stub = { PATH: `${BIN}:${process.env.PATH}`, STUB_ROOT: cache, STUB_WRITES: join(dir, 'writes'), STUB_HOOKS: JSON.stringify(listed) };
  const path = process.env.PATH;
  t.after(() => { for (const name of Object.keys(stub)) delete process.env[name]; process.env.PATH = path; });
  Object.assign(process.env, stub);
  return stub.STUB_WRITES;
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
  const { root, sha, archive } = release(join(dir, 'cache'), 'khala-network-codex');
  const marketplace = JSON.stringify({ plugins: [{ name: 'khala-network-codex', version: '9.9.9',
    source: { source: 'url', url: 'https://github.com/Dev-Jahn/khala-network-codex.git', sha } }] });
  const fetched = [];
  const download = async url => { fetched.push(url); return url === MARKETPLACE ? Buffer.from(marketplace) : archive; };
  const writes = standIn(t, dir, join(dir, 'cache'), [[OURS, 'sessionStart', 'modified'], ['other@test-market', 'stop', 'modified'], [OURS, 'stop', 'trusted']]);
  const refused = async pattern => {
    const [{ error }] = await trustHooks(undefined, download);
    assert.ok(error instanceof Refusal && pattern.test(error.message), error?.message);
  };

  // One altered file: refused, and nothing is written.
  appendFileSync(join(root, 'hooks', 'hook.mjs'), 'tampered\n');
  await refused(/: hooks\/hook\.mjs differs$/);
  put(join(root, 'hooks', 'extra.mjs'), '');
  await refused(/: hooks\/extra\.mjs is not in the release; hooks\/hook\.mjs differs$/);
  assert.ok(!existsSync(writes));

  // The published bytes: exactly this plugin's untrusted hook is recorded.
  rmSync(join(root, 'hooks', 'extra.mjs'));
  put(join(root, 'hooks', 'hook.mjs'), 'published\n');
  assert.deepEqual(await trustHooks(undefined, download), [{ plugin: 'khala-network-codex',
    hooks: [{ eventName: 'sessionStart', was: 'modified', now: 'trusted' }, { eventName: 'stop', was: 'trusted', now: 'trusted' }] }]);
  assert.deepEqual(readFileSync(writes, 'utf8').trim().split('\n').map(JSON.parse), [{ edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert',
    value: { [`${OURS}:sessionStart`]: { trusted_hash: 'sha256:sessionStart' } } }] }]);
  assert.deepEqual(fetched.slice(-2), [MARKETPLACE, `https://github.com/Dev-Jahn/khala-network-codex/archive/${sha}.tar.gz`]);
});

test('trust-hooks --plugin: each named plugin is held to its own marketplace entry, and only the verified ones are recorded', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, 'cache'), market = name => `${name}@jahns-codex-marketplace`;
  // hippo is published from a repository of another name; the others are
  // installed just as faithfully, but nothing ties them to the owner.
  const releases = Object.fromEntries(['hippo', 'elsewhere', 'unpinned', 'unlisted', 'sideloaded'].map(name => [name, release(cache, name, name === 'hippo' ? 'hippocampus' : name)]));
  const marketplace = JSON.stringify({ plugins: [
    { name: 'hippo', source: { url: 'https://github.com/Dev-Jahn/hippocampus.git', sha: releases.hippo.sha } },
    { name: 'elsewhere', source: { url: 'https://github.com/someone/elsewhere.git', sha: releases.elsewhere.sha } },
    { name: 'unpinned', source: { url: 'https://github.com/Dev-Jahn/unpinned.git', sha: 'main' } },
    { name: 'sideloaded', source: { url: 'https://github.com/Dev-Jahn/sideloaded.git', sha: releases.sideloaded.sha } }] });
  const fetched = [];
  const download = async url => {
    fetched.push(url);
    return url === MARKETPLACE ? Buffer.from(marketplace) : Object.values(releases).find(({ sha }) => url.includes(sha)).archive;
  };
  const writes = standIn(t, dir, cache, [[market('hippo'), 'stop', 'modified'], [market('elsewhere'), 'stop', 'modified'], [market('unpinned'), 'stop', 'modified'],
    [market('unlisted'), 'stop', 'modified'], ['sideloaded@another-market', 'stop', 'modified']]);

  const outcomes = await trustHooks(['hippo', 'elsewhere', 'unpinned', 'unlisted', 'sideloaded', 'absent'], download);
  assert.deepEqual(outcomes[0], { plugin: 'hippo', hooks: [{ eventName: 'stop', was: 'modified', now: 'trusted' }] });
  for (const [at, pattern] of [/gives elsewhere the source "https:\/\/github\.com\/someone\/elsewhere\.git"/, /pins unpinned to "main"/,
    /has no plugin named unlisted$/, /lists sideloaded hooks under sideloaded@another-market, not sideloaded@jahns-codex-marketplace$/].entries()) {
    assert.ok(outcomes[at + 1].error instanceof Refusal && pattern.test(outcomes[at + 1].error.message), outcomes[at + 1].error?.message);
  }
  assert.ok(outcomes[5].error && !(outcomes[5].error instanceof Refusal));
  assert.deepEqual(readFileSync(writes, 'utf8').trim().split('\n').map(JSON.parse), [{ edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert',
    value: { [`${market('hippo')}:stop`]: { trusted_hash: 'sha256:stop' } } }] }]);
  assert.deepEqual(fetched, [MARKETPLACE, `https://github.com/Dev-Jahn/hippocampus/archive/${releases.hippo.sha}.tar.gz`]);
});

test('auto-trust: the list is a file in the khala home, and --run exits with the worst outcome over the listed plugins', t => {
  const home = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const listed = [[OURS, 'stop', 'trusted'], ['hippo@jahns-codex-marketplace', 'stop', 'trusted'], ['sideloaded@another-market', 'stop', 'modified']];
  const auto = (...args) => { const { status, stdout, stderr } = cli(t, listed, ['auto-trust', ...args], { KHALA_HOME: home }); return [status, stdout, stderr]; };

  // Off until asked for: nothing listed, nothing run.
  assert.deepEqual([auto(), auto('--run')], [[0, '', ''], [0, '', '']]);
  assert.deepEqual([auto('khala-network-codex', 'hippo'), auto()], [[0, '', ''], [0, 'khala-network-codex\nhippo\n', '']]);
  assert.equal(readFileSync(join(home, 'codex-auto-trust'), 'utf8'), 'khala-network-codex\nhippo\n');
  assert.deepEqual(auto('--run'), [0, 'khala-network-codex\tstop\ttrusted\ttrusted\nhippo\tstop\ttrusted\ttrusted\n', '']);

  // A plugin Codex does not list (4), then one that is refused as well (5).
  auto('hippo', 'absent');
  const undetermined = auto('--run');
  assert.deepEqual(undetermined.slice(0, 2), [4, 'hippo\tstop\ttrusted\ttrusted\n']);
  assert.match(undetermined[2], /^khala-codex: absent: hook trust could not be checked: .+\n$/);
  auto('absent', 'sideloaded', 'hippo');
  const refused = auto('--run');
  assert.deepEqual(refused.slice(0, 2), [5, 'hippo\tstop\ttrusted\ttrusted\n']);
  assert.match(refused[2], /^khala-codex: absent: .+\nkhala-codex: sideloaded: hook trust was not recorded and nothing of it was changed: .+\n$/);

  assert.deepEqual([auto('off'), auto(), auto('--run')], [[0, '', ''], [0, '', ''], [0, '', '']]);
  assert.ok(!existsSync(join(home, 'codex-auto-trust')));
});

test('auto-trust: setting the list records a PATH the run works on, and refuses when codex is not on it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'khala-trust-'));
  const path = process.env.PATH, list = join(dir, 'codex-auto-trust'), node = join(dir, 'node', 'bin', 'node');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.KHALA_HOME; process.env.PATH = path; });
  process.env.KHALA_HOME = dir;

  process.env.PATH = `/usr/bin:${join(dir, 'node', 'bin')}:/bin`;
  assert.throws(() => setAutoTrusted(['hippo'], node), /^Error: codex is not on the PATH that the automatic run would use /);
  assert.ok(!existsSync(list) && !existsSync(`${list}.path`));

  process.env.PATH += `:${BIN}`;
  setAutoTrusted(['hippo'], node);
  assert.deepEqual([readFileSync(list, 'utf8'), readFileSync(`${list}.path`, 'utf8')], ['hippo\n', `${join(dir, 'node', 'bin')}:/usr/bin:/bin:${BIN}\n`]);
  setAutoTrusted([]);
  assert.ok(!existsSync(list) && !existsSync(`${list}.path`));
});
