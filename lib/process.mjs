import { accessSync, constants, readFileSync } from 'node:fs';
import { basename, delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// The full path of a command on PATH. Given a bare name, Node on macOS tries
// to start it in each PATH directory in turn, and the kernel counts every
// failed try as a process start; looking the name up here starts nothing.
const found = new Map();
export function executable(name) {
  if (!found.has(name)) {
    const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir, name)).find(candidate => {
      try { accessSync(candidate, constants.X_OK); return true; }
      catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return false; throw error; }
    });
    if (!path) throw new Error(`${name} is not on PATH.`);
    found.set(name, path);
  }
  return found.get(name);
}

// Match process birth as well as PID, including after a crash or PID reuse.
export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync(executable('ps'), ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='], {
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

// For a loop that keeps asking about one owner: identified once with ps, then
// asked of the kernel without starting a process. A PID is not reissued while
// its process lives, so afterwards only the exit has to be noticed.
export function ownerWatch(owner) {
  let identified = false;
  return () => {
    if (!identified) return identified = processAlive(owner);
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && owner.started.endsWith(':' + fields[19]);
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
  };
}

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
  const result = spawnSync(executable('ps'), ['-ww', '-p', String(pid), '-o', 'args='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2000,
  });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim().split(/\s+/) : [];
}
