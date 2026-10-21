import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/context.mjs';
import { readBinding } from '../lib/binding.mjs';
import { deliver } from '../lib/lane.mjs';
import { processInfo } from '../lib/process.mjs';
import { fixture, mail, put } from './helpers.mjs';

const THREAD = 'thread-lane';
const HOOK = join(ROOT, 'hooks/hook.mjs');
const BOUNDARY = join(ROOT, 'hooks/tool-boundary.sh');

// A stand-in Codex process: a symlink named `codex` to node runs a driver that
// plays one lane's hook events in order, so every hook has a live `codex`
// ancestor whose argv carries (or lacks) the exec subcommand.
const DRIVER = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const [plan, out] = process.argv.slice(3);
const results = [];
for (const step of JSON.parse(readFileSync(plan, 'utf8'))) {
  if (step.put) { mkdirSync(dirname(step.put[0]), { recursive: true }); writeFileSync(step.put[0], step.put[1]); continue; }
  const r = spawnSync(step.argv[0], step.argv.slice(1), { cwd: step.cwd, env: step.env, input: JSON.stringify(step.event), encoding: 'utf8' });
  results.push({ status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message });
}
writeFileSync(out, JSON.stringify(results));
`;

function setup(t, { source = 'exec' } = {}) {
  const { ctx, dir, home } = fixture(t);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'codex'));
  put(join(dir, 'driver.mjs'), DRIVER);
  // Fake shared transport: records every call, never touches a real runtime.
  put(join(home, 'bin', 'khala-link'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'link-calls'))}, JSON.stringify({ args, parent: process.env.KHALA_PARENT ?? null }) + '\\n');
if (fs.existsSync(${JSON.stringify(join(dir, 'link-fail'))})) { console.error('fake link failure'); process.exit(1); }
if (args[1] === 'register') console.log('instance inst-1\\nowner no\\nepoch 1');
`);
  chmodSync(join(home, 'bin', 'khala-link'), 0o755);
  // Fake node for the fast path: proves whether tool-boundary.sh started Node.
  put(join(dir, 'fakebin', 'node'), `#!/bin/sh\n: > ${JSON.stringify(join(dir, 'node-started'))}\n`);
  chmodSync(join(dir, 'fakebin', 'node'), 0o755);
  const transcript = join(dir, 'rollout.jsonl');
  put(transcript, JSON.stringify({ type: 'session_meta', payload: { id: THREAD, session_id: THREAD, source, originator: 'codex_exec',
    cli_version: '0.162.1', base_instructions: { text: 'x'.repeat(70000) } } }) + '\n{"type":"turn_context"}\n');
  const env = { ...process.env, KHALA_HOME: home, KHALA_SESSION: ctx.identity, KHALA_PARENT: 'main@test', KHALA_CODEX_SOCKET: '' };
  const base = { cwd: ctx.cwd, session_id: THREAD, transcript_path: transcript, model: 'test-model', permission_mode: 'default' };
  const steps = {
    start: (source = 'startup') => ({ argv: [process.execPath, HOOK], cwd: ctx.cwd, env, event: { ...base, hook_event_name: 'SessionStart', source } }),
    tool: (extra = {}) => ({ argv: ['sh', BOUNDARY], cwd: ctx.cwd, env: { ...env, ...extra },
      event: { ...base, hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'shell', tool_use_id: 'call-1', tool_input: {}, tool_response: {} } }),
    stop: (active = false, turn = 'turn-1') => ({ argv: [process.execPath, HOOK], cwd: ctx.cwd, env,
      event: { ...base, hook_event_name: 'Stop', turn_id: turn, stop_hook_active: active, last_assistant_message: null } }),
    end: () => ({ argv: [process.execPath, HOOK], cwd: ctx.cwd, env, event: { ...base, hook_event_name: 'SessionEnd', reason: 'other' } }),
    prompt: () => ({ argv: [process.execPath, HOOK], cwd: ctx.cwd, env, event: { ...base, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'go' } }),
    letter: (id, body = 'reply body `literal $VALUE`') => ({ put: [join(home, 'inbox', ctx.identity, 'new', id),
      `Khala: 0.1\nId: ${id}\nFrom: main@test\nTo: ${ctx.identity}@test\nDate: 2026-10-21T00:00:00Z\nType: message\nSubject: reply\nExpires: 9999999999\n\n${body}\n`] }),
  };
  // Runs the steps inside one stand-in Codex process started as `codex <subcommand>`.
  const run = (plan, subcommand = 'exec') => {
    const planPath = join(dir, 'plan.json'), out = join(dir, 'results.json');
    writeFileSync(planPath, JSON.stringify(plan));
    const result = spawnSync(join(bin, 'codex'), [join(dir, 'driver.mjs'), subcommand, planPath, out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  const calls = () => existsSync(join(dir, 'link-calls')) ? readFileSync(join(dir, 'link-calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const logText = () => existsSync(join(home, 'log', `codex-${ctx.identity}.log`)) ? readFileSync(join(home, 'log', `codex-${ctx.identity}.log`), 'utf8') : '';
  const inbox = state => existsSync(join(home, 'inbox', ctx.identity, state)) ? spawnSync('ls', [join(home, 'inbox', ctx.identity, state)], { encoding: 'utf8' }).stdout.trim() : '';
  return { ctx, dir, home, steps, run, calls, logText, inbox, env, transcript };
}

const silent = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); };

test('detection: exec thread in an exec process is a lane; TUI-resumed exec threads and non-exec threads are not', t => {
  const lane = setup(t);
  const probe = join(lane.dir, 'probe.mjs');
  put(probe, `import { execSession } from ${JSON.stringify(join(ROOT, 'lib/lane.mjs'))};
let input = ''; for await (const chunk of process.stdin) input += chunk;
const found = execSession(JSON.parse(input)); console.log(JSON.stringify(found && { pid: found.owner.pid, version: found.version }));`);
  const step = event => ({ argv: [process.execPath, probe], cwd: lane.ctx.cwd, env: lane.env, event });
  const event = { session_id: THREAD, transcript_path: lane.transcript };
  const [exec, other, missing, none] = lane.run([step(event), step({ ...event, session_id: 'other-thread' }),
    step({ ...event, transcript_path: join(lane.dir, 'missing.jsonl') }), step({ ...event, transcript_path: null })]);
  assert.equal(JSON.parse(exec.stdout).version, '0.162.1');
  for (const result of [other, missing, none]) assert.equal(result.stdout.trim(), 'null');
  assert.equal(lane.run([step(event)], 'resume')[0].stdout.trim(), 'null');
  const tui = setup(t, { source: 'vscode' });
  assert.equal(tui.run([{ ...step({ session_id: THREAD, transcript_path: tui.transcript }), cwd: tui.ctx.cwd, env: tui.env }])[0].stdout.trim(), 'null');
  // A process without any Codex ancestor (the interactive hook tests' setting) is never a lane.
  const direct = spawnSync(process.execPath, [probe], { input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(direct.stdout.trim(), 'null');
});

test('lane lifecycle: worker registration with parent, zero output without mail, delivery at the lane\'s tool boundaries, release at end', t => {
  const lane = setup(t);
  const subagentTool = lane.steps.tool();
  subagentTool.event = { ...subagentTool.event, agent_id: 'agent-1', agent_type: 'worker' };
  const [start, idleTool, prompt, subagent, mailTool, afterTool, stop, end] = lane.run([
    lane.steps.start(), lane.steps.tool(), lane.steps.prompt(), lane.steps.letter('1792540800.1.1.main@test'),
    subagentTool, lane.steps.tool(), lane.steps.tool(), lane.steps.stop(), lane.steps.end(),
  ]);
  for (const result of [start, idleTool, prompt, subagent, afterTool, stop, end]) silent(result);
  const delivered = JSON.parse(mailTool.stdout);
  assert.equal(delivered.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(delivered.hookSpecificOutput.additionalContext, /^Khala mail for codex-test@test/);
  assert.match(delivered.hookSpecificOutput.additionalContext, /peer content/);
  assert.ok(delivered.hookSpecificOutput.additionalContext.includes('reply body `literal $VALUE`'));
  assert.match(delivered.hookSpecificOutput.additionalContext, /drained: letters 1, notices 0, streams 0/);
  assert.equal(lane.inbox('new'), '');
  assert.equal(lane.inbox('cur'), '1792540800.1.1.main@test');
  const runtime = () => lane.calls().filter(call => ['register', 'release'].includes(call.args[1]));
  const [register, release] = runtime();
  assert.deepEqual(register.args.slice(0, 2), ['runtime', 'register']);
  for (const flag of ['--harness codex', '--kind worker', '--receive-opt-in=false', `--session-id ${THREAD}`, '--cc-version 0.162.1']) {
    assert.ok(register.args.join(' ').includes(flag), flag);
  }
  assert.ok(!register.args.some(arg => /socket|channel/.test(arg)));
  assert.equal(register.parent, 'main@test');
  assert.deepEqual(release.args, ['runtime', 'release', '--identity', 'codex-test', '--instance', 'inst-1', '--session-id', THREAD]);
  assert.equal(runtime().length, 2);
  assert.ok(!existsSync(join(lane.home, 'run', 'codex', 'codex-test.json')));
  assert.ok(!existsSync(join(lane.home, 'run', 'codex', 'codex-test.lane')));
  // No commons join, no queue bridge, no activity tracking in lane mode.
  assert.ok(!existsSync(join(lane.home, 'join', 'codex-test')));
  assert.deepEqual(spawnSync('ls', [join(lane.home, 'run', 'codex')], { encoding: 'utf8' }).stdout, '');
  assert.equal(lane.logText(), '');
});

test('the no-mail tool boundary never starts Node, and non-lane sessions never start it even with unread mail', t => {
  const lane = setup(t);
  const fakeNode = { PATH: `${join(lane.dir, 'fakebin')}:${process.env.PATH}` };
  const [start, idle] = lane.run([lane.steps.start(), lane.steps.tool(fakeNode)]);
  silent(start); silent(idle);
  assert.ok(!existsSync(join(lane.dir, 'node-started')));
  const tui = setup(t);
  mail(tui.ctx, '1792540800.1.1.main@test');
  silent(tui.run([tui.steps.tool(fakeNode)], 'resume')[0]);
  assert.ok(!existsSync(join(tui.dir, 'node-started')));
  assert.ok(existsSync(join(tui.home, 'inbox', 'codex-test', 'new', '1792540800.1.1.main@test')));
});

test('SessionStart returns waiting mail and a resumed run takes over its own stale binding', t => {
  const lane = setup(t);
  lane.run([lane.steps.start()]);
  // The first run was killed: SessionEnd never ran and its owner is gone.
  assert.equal(readBinding(lane.ctx).mode, 'lane');
  const [resumed] = lane.run([lane.steps.letter('1792540801.1.1.main@test', 'resume me'), lane.steps.start('resume')]);
  const output = JSON.parse(resumed.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'SessionStart');
  assert.match(output.additionalContext, /resume me/);
  const binding = readBinding(lane.ctx);
  assert.equal(binding.mode, 'lane');
  assert.equal(binding.parent, 'main@test');
  const releases = lane.calls().filter(call => call.args[1] === 'release');
  assert.equal(releases.length, 1);
});

test('a lane never takes an identity bound to another live Codex session', t => {
  const lane = setup(t);
  put(join(lane.home, 'run', 'codex', 'codex-test.json'), JSON.stringify({ ...lane.ctx, harness: 'codex', threadId: 'tui-thread', socket: '',
    token: 'tui-token', owner: processInfo(process.pid) }));
  mail(lane.ctx, '1792540800.1.1.main@test');
  const [start, tool, stop, end] = lane.run([lane.steps.start(), lane.steps.tool(), lane.steps.stop(), lane.steps.end()]);
  for (const result of [start, tool, stop, end]) silent(result);
  assert.equal(readBinding(lane.ctx).threadId, 'tui-thread');
  assert.ok(existsSync(join(lane.home, 'inbox', 'codex-test', 'new', '1792540800.1.1.main@test')));
  assert.match(lane.logText(), /lane SessionStart: codex-test@test is bound to another live Codex session/);
  assert.equal(lane.calls().length, 0);
});

test('Stop continues the turn with new mail at most three times per turn', t => {
  const lane = setup(t);
  const plan = [lane.steps.start(), lane.steps.stop()];
  for (let i = 0; i < 4; i++) plan.push(lane.steps.letter(`179254080${i}.1.1.main@test`, `stop letter ${i}`), lane.steps.stop(i > 0));
  plan.push(lane.steps.stop(false, 'turn-2'));
  const [start, idle, ...stops] = lane.run(plan);
  silent(start); silent(idle);
  for (let i = 0; i < 3; i++) {
    const output = JSON.parse(stops[i].stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, new RegExp(`stop letter ${i}`));
  }
  silent(stops[3]);
  // The capped letter stayed unread; the next turn's Stop delivers it.
  const next = JSON.parse(stops[4].stdout);
  assert.equal(next.decision, 'block');
  assert.match(next.reason, /stop letter 3/);
});

test('mail the drain cannot take is announced once, then held until the inbox changes', t => {
  const lane = setup(t);
  const [start, first, second, third] = lane.run([
    lane.steps.start(), lane.steps.letter('1792540800.1.1.main@test', 'x'.repeat(70000)),
    lane.steps.tool(), lane.steps.tool(), lane.steps.letter('1792540801.1.1.main@test', 'small'), lane.steps.tool(),
  ]);
  silent(start);
  const announced = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
  assert.match(announced, /1건 더 \(main@test\)/);
  assert.match(announced, /Unread mail remains; run .* inbox --drain/);
  silent(second);
  assert.match(JSON.parse(third.stdout).hookSpecificOutput.additionalContext, /small/);
});

test('a letter larger than a Stop page is announced at Stop and delivered at the next tool boundary', t => {
  const lane = setup(t);
  const [start, stop, tool, done] = lane.run([lane.steps.start(), lane.steps.letter('1792540800.1.1.main@test', 'y'.repeat(10000)),
    lane.steps.stop(), lane.steps.tool(), lane.steps.stop(true)]);
  silent(start);
  const blocked = JSON.parse(stop.stdout);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /1건 더 \(main@test\)/);
  assert.ok(Buffer.byteLength(blocked.reason) < 10000);
  assert.ok(JSON.parse(tool.stdout).hookSpecificOutput.additionalContext.includes('y'.repeat(10000)));
  silent(done);
});

test('lane hook errors are logged and never produce output or a failing exit', t => {
  const lane = setup(t);
  put(join(lane.dir, 'link-fail'), '');
  const [start] = lane.run([lane.steps.start()]);
  silent(start);
  assert.match(lane.logText(), /worker registration failed; delivery continues without runtime presence: fake link failure/);
  assert.equal(readBinding(lane.ctx).mode, 'lane');
  mail(lane.ctx, '1792540800.1.1.main@test');
  const config = readFileSync(join(lane.home, 'config'), 'utf8');
  writeFileSync(join(lane.home, 'config'), 'not a khala config\n');
  for (const result of lane.run([lane.steps.tool(), lane.steps.stop(), lane.steps.end()])) silent(result);
  for (const name of ['PostToolUse', 'Stop', 'SessionEnd']) {
    assert.match(lane.logText(), new RegExp(`lane ${name}: Khala config must declare exactly one valid self node`));
  }
  writeFileSync(join(lane.home, 'config'), config);
  assert.ok(existsSync(join(lane.home, 'inbox', 'codex-test', 'new', '1792540800.1.1.main@test')));
});

test('a drain that exceeds its deadline fails without delivering; waiting for the brain lock marks nothing read', t => {
  const { ctx } = fixture(t);
  mail(ctx, '1792540800.1.1.main@test');
  // A live brain lock makes the upstream drain wait.
  put(join(ctx.home, 'run', 'brain.lock.d', 'owner'), `${Math.floor(Date.now() / 1000)}\npid 1 test\n`);
  const binding = { ...ctx, threadId: THREAD, token: 'lane-token' };
  assert.throws(() => deliver(binding, 'PostToolUse', 'full', 500), /drain failed \(ETIMEDOUT\)$/);
  assert.ok(existsSync(join(ctx.home, 'inbox', ctx.identity, 'new', '1792540800.1.1.main@test')));
});

test('an interactive bind refuses a lane-owned identity with an explicit cleanup path', t => {
  const lane = setup(t);
  lane.run([lane.steps.start()]);
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/khala-codex'), 'bind'], {
    cwd: lane.ctx.cwd, env: { ...lane.env, CODEX_THREAD_ID: 'tui-thread' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`bound to the Codex lane thread ${THREAD}.*unbind --thread ${THREAD}`));
  assert.equal(readBinding(lane.ctx).mode, 'lane');
});
