import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { core, ROOT, identity } from '../lib/context.mjs';
import { drainToken } from '../lib/pending.mjs';
import { bind, readBinding, unbind } from '../lib/binding.mjs';
import { fixture, put } from './helpers.mjs';

test('Codex CLI and the original brain exchange literal bodies and explicit read acknowledgements', t => {
  const { ctx } = fixture(t);
  const body = '한글 `literal $VALUE`\n$(do-not-execute)\n';
  const sender = { ...ctx, identity: 'ink' };
  const id = core(sender, ['send', 'codex-test@test', '-s', 'from Claude'], { input: body }).trim();
  core(ctx, ['reconcile']);
  const before = drainToken(ctx);
  assert.ok(existsSync(join(ctx.home, 'inbox', ctx.identity, 'new', id)));
  const child = spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), 'inbox', '--drain'], {
    cwd: ctx.cwd, env: { ...process.env, KHALA_HOME: ctx.home, KHALA_SESSION: ctx.identity }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.includes(body));
  assert.match(child.stdout, /drained: letters 1, notices 0, streams 0/);
  assert.notEqual(drainToken(ctx), before);
  assert.ok(existsSync(join(ctx.home, 'inbox', ctx.identity, 'cur', id)));
  assert.ok(!existsSync(join(ctx.home, 'inbox', ctx.identity, 'new', id)));
  const reply = core(ctx, ['send', 'ink@test', '--reply-to', id, '-s', 'reply'], { input: body }).trim();
  core(ctx, ['reconcile']);
  const received = core(sender, ['inbox', '--drain']);
  assert.ok(received.includes(`Id: ${reply}`)); assert.ok(received.includes(body));
  assert.ok(received.includes(`In-Reply-To: ${id}`));
});

test('request-id is idempotent through the same upstream brain', t => {
  const { ctx } = fixture(t);
  const args = ['send', 'ink@test', '--request-id', 'same-operation', '-s', 'idempotent'];
  assert.equal(core(ctx, args, { input: 'same\n' }), core(ctx, args, { input: 'same\n' }));
  assert.throws(() => core(ctx, args, { input: 'different\n' }));
});

test('explicit machine sender works without a Codex session declaration', t => {
  const { ctx } = fixture(t);
  const env = { ...process.env, KHALA_HOME: ctx.home };
  delete env.KHALA_SESSION;
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), 'notify', 'ink@test', '--as', 'machine-watch', '-s', 'observation'], {
    cwd: ctx.home, env, input: 'machine body\n', encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('watch forwards the actual Codex thread ID to the shared readiness check', t => {
  const { ctx } = fixture(t);
  // /tmp may be mounted noexec; this fixture must be an actual executable.
  const executableDir = mkdtempSync(join(ROOT, '.watch-test-'));
  t.after(() => rmSync(executableDir, { recursive: true }));
  const binary = join(executableDir, 'khala-link.cjs');
  put(binary, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.KHALA_HOME + "/watch-args.json", JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(binary, 0o755);
  mkdirSync(join(ctx.home, 'bin'), { recursive: true });
  symlinkSync(binary, join(ctx.home, 'bin', 'khala-link'));
  const child = spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), 'watch', '--max-wait', '1'], {
    cwd: ctx.cwd, env: { ...process.env, KHALA_HOME: ctx.home, KHALA_SESSION: ctx.identity,
      CODEX_THREAD_ID: 'codex-thread', KHALA_CLAUDE_SESSION_ID: 'unrelated-claude-thread' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const args = JSON.parse(readFileSync(join(ctx.home, 'watch-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--session-id') + 1], 'codex-thread');
  assert.match(child.stdout, /conduit has the ear/);
});

test('identity declarations remain exact and separate from Claude project identity', t => {
  const { dir } = fixture(t);
  assert.equal(identity(dir, {}), 'codex-test');
  assert.equal(identity(dir, { KHALA_SESSION: 'named' }), 'named');
  for (const value of ['', 'Claude', 'a b', 'a\nb', 'conduit', '../ink']) assert.throws(() => identity(dir, { KHALA_SESSION: value }));
  put(join(dir, '.khala-codex-session'), 'a\nb\n');
  put(join(dir, '.khala-session'), 'ink\n');
  assert.throws(() => identity(dir, {}));
});

test('different threads cannot claim or release the same Codex identity', t => {
  const { ctx } = fixture(t);
  const first = bind(ctx, 'thread-one');
  assert.equal(bind(ctx, 'thread-one').token, first.token);
  assert.throws(() => bind(ctx, 'thread-two'));
  assert.throws(() => unbind(ctx, 'thread-two'));
  assert.equal(readBinding(ctx).threadId, 'thread-one');
  unbind(ctx, 'thread-one');
  assert.equal(readBinding(ctx), null);
});
