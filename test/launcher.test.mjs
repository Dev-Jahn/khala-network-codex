import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/context.mjs';
import { script } from '../lib/launcher.mjs';
import { put } from './helpers.mjs';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'vendor/khala/upstream.json'), 'utf8')).version;
const MARK = /^khala-codex-launcher sha256:[0-9a-f]{64}\n$/;

// A temporary HOME and Codex plugin cache holding copies of this plugin, so
// setup, the hook and the launcher run exactly as they do from the cache.
function layout(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'khala-launcher-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, 'codex', 'plugins', 'cache', 'test-market', 'khala-network-codex');
  const bin = join(dir, 'home', '.local', 'bin');
  const launcher = join(bin, 'khala-codex'), receipt = join(bin, '.khala-codex-receipt');
  const env = { ...process.env, HOME: join(dir, 'home'), KHALA_HOME: join(dir, 'khala') };
  delete env.KHALA_SESSION;
  put(join(dir, 'khala', 'bin', 'khala-link'), `#!/bin/sh\necho ${VERSION}\n`);
  chmodSync(join(dir, 'khala', 'bin', 'khala-link'), 0o755);
  const plugin = version => {
    for (const item of ['bin', 'hooks', 'lib', 'vendor', 'package.json']) cpSync(join(ROOT, item), join(cache, version, item), { recursive: true });
    return join(cache, version);
  };
  const run = (argv, input = '') => spawnSync(argv[0], argv.slice(1), { cwd: dir, env, input, encoding: 'utf8' });
  const setup = root => run([process.execPath, join(root, 'bin/khala-codex'), 'setup']);
  const hook = (root, name, extra = {}, argv = []) => run([process.execPath, join(root, 'hooks/hook.mjs'), ...argv],
    JSON.stringify({ cwd: dir, session_id: 'thread-one', hook_event_name: name, ...extra }));
  // An owned launcher as an earlier setup left it: a receipt-matched symlink.
  const legacy = target => { mkdirSync(bin, { recursive: true }); symlinkSync(target, launcher); writeFileSync(receipt, target + '\n'); };
  const current = () => lstatSync(launcher).isFile() && readFileSync(launcher, 'utf8') === script(cache) && MARK.test(readFileSync(receipt, 'utf8'));
  return { dir, cache, bin, launcher, receipt, plugin, run, setup, hook, legacy, current };
}

test('setup replaces its dangling symlink with a launcher, idempotently', t => {
  const { cache, launcher, receipt, plugin, run, setup, legacy, current } = layout(t);
  const root = plugin('0.3.0');
  legacy(join(cache, '0.2.1', 'bin', 'khala-codex'));
  assert.ok(!existsSync(launcher));
  const first = setup(root);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(current());
  const installed = readFileSync(receipt, 'utf8');
  const second = setup(root);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(current());
  assert.equal(readFileSync(receipt, 'utf8'), installed);
  // The real CLI resolves its vendored brain from the version directory.
  const version = run([launcher, 'version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `khala ${VERSION}\n`);
});

test('the launcher runs the numerically highest version and passes argv, stdin and exit code through', t => {
  const { cache, launcher, plugin, run, setup } = layout(t);
  const result = setup(plugin('0.3.0'));
  assert.equal(result.status, 0, result.stderr);
  put(join(cache, '0.10.0', 'package.json'), '{ "type": "module" }\n');
  put(join(cache, '0.10.0', 'bin', 'khala-codex'), `import { fileURLToPath } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ root: fileURLToPath(new URL('..', import.meta.url)), args: process.argv.slice(2), input }));
process.exitCode = 7;
`);
  mkdirSync(join(cache, '0.11.0'));
  const ran = run([launcher, 'send', 'a b', '--as', '$X'], 'body\n');
  assert.equal(ran.status, 7, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { root: join(cache, '0.10.0') + '/', args: ['send', 'a b', '--as', '$X'], input: 'body\n' });
});

test('the launcher names a missing plugin and exits non-zero', t => {
  const { cache, launcher, plugin, run, setup } = layout(t);
  const result = setup(plugin('0.3.0'));
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(cache, '0.3.0'), { recursive: true });
  for (const removed of [false, true]) {
    if (removed) rmSync(cache, { recursive: true });
    const ran = run([launcher, 'version']);
    assert.equal(ran.status, 1);
    assert.equal(ran.stdout, '');
    assert.equal(ran.stderr, `khala-codex: the Codex plugin khala-network-codex is not installed: no version in ${cache}. Reinstall it with codex plugin add khala-network-codex@test-market.\n`);
  }
});

test('setup and the hook leave a manual file, an edited launcher and a foreign symlink untouched', t => {
  const { dir, cache, bin, launcher, receipt, plugin, setup, hook } = layout(t);
  const root = plugin('0.3.0');
  mkdirSync(bin, { recursive: true });
  const cases = [
    () => { writeFileSync(launcher, '#!/bin/sh\necho mine\n'); rmSync(receipt, { force: true }); },
    () => { writeFileSync(launcher, script(cache) + '// edited\n'); writeFileSync(receipt, `khala-codex-launcher sha256:${'0'.repeat(64)}\n`); },
    () => { symlinkSync(join(dir, 'mine'), launcher); writeFileSync(receipt, join(cache, '0.2.1', 'bin', 'khala-codex') + '\n'); },
  ];
  for (const arrange of cases) {
    rmSync(launcher, { force: true });
    arrange();
    const before = lstatSync(launcher).isSymbolicLink() ? readlinkSync(launcher) : readFileSync(launcher, 'utf8');
    const refused = setup(root);
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, `khala-codex: ${launcher} is manually managed; refusing to replace it.\n`);
    const started = hook(root, 'SessionStart', { source: 'startup' });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stderr, '');
    assert.equal(lstatSync(launcher).isSymbolicLink() ? readlinkSync(launcher) : readFileSync(launcher, 'utf8'), before);
  }
});

test('a root SessionStart repairs an owned launcher for its cache and installs none', t => {
  const { dir, cache, bin, launcher, plugin, run, hook, legacy, current } = layout(t);
  const root = plugin('0.3.0');
  let started = hook(root, 'SessionStart', { source: 'startup' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '{}\n');
  assert.ok(!existsSync(bin));
  // A symlink into a source checkout belongs to that checkout's setup.
  legacy(join(dir, 'checkout', 'bin', 'khala-codex'));
  assert.equal(hook(root, 'SessionStart', { source: 'startup' }).status, 0);
  assert.equal(readlinkSync(launcher), join(dir, 'checkout', 'bin', 'khala-codex'));
  rmSync(launcher);
  legacy(join(cache, '0.2.1', 'bin', 'khala-codex'));
  hook(root, 'PostToolUse', { tool_name: 'shell' }, ['PostToolUse']);
  hook(root, 'UserPromptSubmit', { prompt: 'go' });
  hook(root, 'SessionStart', { source: 'startup', agent_id: 'agent-1' });
  assert.ok(lstatSync(launcher).isSymbolicLink());
  started = hook(root, 'SessionStart', { source: 'startup' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '{}\n');
  assert.ok(current());
  assert.equal(run([launcher, 'version']).stdout, `khala ${VERSION}\n`);
});

test('a failed SessionStart repair warns on the interactive route without failing the session', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, t => {
  const { cache, bin, launcher, plugin, hook, legacy } = layout(t);
  const root = plugin('0.3.0');
  legacy(join(cache, '0.2.1', 'bin', 'khala-codex'));
  chmodSync(bin, 0o555);
  let started;
  try { started = hook(root, 'SessionStart', { source: 'startup' }); } finally { chmodSync(bin, 0o755); }
  assert.equal(started.status, 0);
  assert.equal(started.stdout, '{}\n');
  assert.match(started.stderr, /^khala-codex hook: launcher repair failed: EACCES/);
  assert.ok(lstatSync(launcher).isSymbolicLink());
});
