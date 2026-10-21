import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';

// Match process birth as well as PID, including after a crash or PID reuse.
export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
  if (!match) throw new Error('Cannot identify the Codex process.');
  let started = match[2];
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      started += ':' + fields[19];
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return { pid, parent: Number(match[1]), started, command: match[3].trim() };
}
export const processAlive = owner => Boolean(owner && processInfo(owner.pid)?.started === owner.started);

export function codexOwner() {
  for (let pid = process.ppid; pid > 1;) {
    const info = processInfo(pid);
    if (!info) break;
    if (basename(info.command) === 'codex') return info;
    pid = info.parent;
  }
  throw new Error('Automatic receive must be bound from inside the owning Codex session.');
}

// Exact argv on Linux; on macOS ps joins argv with spaces, which is enough to
// find a whole subcommand word.
export function processArgs(pid) {
  if (process.platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2000,
  });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim().split(/\s+/) : [];
}
