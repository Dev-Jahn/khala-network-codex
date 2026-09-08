import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './context.mjs';
import { optionalText } from './pending.mjs';

export const bindingPath = ctx => join(ctx.home, 'run', 'codex', `${ctx.identity}.json`);
export function atomicJSON(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export function readBinding(ctx) {
  const text = optionalText(bindingPath(ctx));
  return text ? JSON.parse(text) : null;
}
export function bind(ctx, threadId, socket = '') {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) throw new Error('A valid Codex thread ID is required.');
  mkdirSync(join(ctx.home, 'run', 'codex'), { recursive: true, mode: 0o700 });
  const path = bindingPath(ctx);
  const binding = { ...ctx, root: ROOT, harness: 'codex', threadId, socket, token: randomUUID() };
  try { writeFileSync(path, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.threadId !== threadId || previous.cwd !== ctx.cwd || previous.socket !== socket) {
      throw new Error(`${ctx.identity}@${ctx.node} is already bound to another Codex session. Choose another name or explicitly unbind the old session.`);
    }
    return previous;
  }
  return binding;
}
export function unbind(ctx, threadId) {
  const binding = readBinding(ctx);
  if (!binding) return;
  if (binding.threadId !== threadId) throw new Error('Cannot release another Codex thread binding.');
  unlinkSync(bindingPath(ctx));
  for (const suffix of ['delivery', 'activity']) {
    try { unlinkSync(join(ctx.home, 'run', 'codex', `${binding.token}.${suffix}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
