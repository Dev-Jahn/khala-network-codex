import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './context.mjs';

// Codex skips hooks it does not trust and says nothing, so a session whose
// hooks never ran looks, from inside, like one with no mail. SessionStart
// therefore leaves a marker per Codex session, and a mail command that finds
// none for its own session says so (bin/khala-codex).

const KEPT = 30 * 86400e3;
const directory = () => join(resolve(process.env.KHALA_HOME || join(homedir(), '.khala')), 'run', 'codex');
const marker = session => join(directory(), `${session}.hooks`);

function remove(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// SessionStart (started) and SessionEnd of a root session. A machine without
// a khala home gets none created.
export function recordRan(session, started) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(session) || !existsSync(join(directory(), '..', '..'))) return;
  if (!started) return remove(marker(session));
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  writeFileSync(marker(session), '', { mode: 0o600 });
  // Sessions that never reached SessionEnd (a crash, a kill).
  for (const name of readdirSync(directory())) {
    if (name.endsWith('.hooks') && Date.now() - statSync(join(directory(), name)).mtimeMs > KEPT) remove(join(directory(), name));
  }
}

// True only when this command runs inside a Codex session whose SessionStart
// hook certainly should have left a marker and did not. CODEX_SESSION_ID is
// the root session's id — what hooks receive as session_id — also in a
// subagent's commands, where CODEX_THREAD_ID is the subagent's own thread.
// A session id is a UUIDv7 and so carries its creation time: a session older
// than this plugin copy may have started under a version without the marker,
// and one older than KEPT may have had its marker pruned; neither is judged.
export function hooksMissed(env = process.env) {
  const session = env.CODEX_SESSION_ID ?? '';
  if (!env.CODEX_THREAD_ID || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session)) return false;
  const created = parseInt(session.slice(0, 8) + session.slice(9, 13), 16);
  return created > Math.max(statSync(ROOT).mtimeMs, Date.now() - KEPT) && !existsSync(marker(session));
}
