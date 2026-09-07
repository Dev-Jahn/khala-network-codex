import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CORE, ROOT } from './context.mjs';

export async function setup() {
  const upstream = JSON.parse(readFileSync(join(ROOT, 'vendor/khala/upstream.json'), 'utf8'));
  const home = process.env.KHALA_HOME ?? join(homedir(), '.khala');
  if (!home) throw new Error('KHALA_HOME is empty.');
  const bin = join(homedir(), '.local', 'bin');
  mkdirSync(bin, { recursive: true }); mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
  const brain = join(bin, 'khala');
  if (existsSync(brain)) {
    const installed = readFileSync(brain, 'utf8');
    const version = installed.match(/^KHALA_VERSION=([0-9.]+)$/m)?.[1];
    if (!version) throw new Error(`${brain} is not a recognizable Khala CLI; refusing to overwrite it.`);
    if (version.localeCompare(upstream.version, undefined, { numeric: true }) < 0) {
      if (lstatSync(brain).isSymbolicLink() || !existsSync(join(bin, '.khala.plugin-receipt'))) throw new Error(`Update the manually managed ${brain} to ${upstream.version} before setup.`);
      atomicCopy(CORE, brain);
    }
  } else {
    atomicCopy(CORE, brain);
    writeFileSync(join(bin, '.khala.plugin-receipt'), 'khala-plugin\n', { mode: 0o600 });
  }
  const target = join(home, 'bin', 'khala-link');
  let install = true;
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`${target} is a manually managed symlink.`);
    const version = execFileSync(target, ['version'], { encoding: 'utf8' }).trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${target} returned an invalid Khala version.`);
    install = version.localeCompare(upstream.version, undefined, { numeric: true }) < 0;
  }
  if (install) {
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!arch || !['linux', 'darwin'].includes(process.platform)) throw new Error('Khala supports Linux/macOS amd64/arm64.');
    const asset = `khala-link-${process.platform}-${arch}`;
    const digest = upstream.assets[asset];
    if (!digest) throw new Error(`No pinned release digest for ${asset}.`);
    const url = `https://github.com/Dev-Jahn/khala-network/releases/download/v${upstream.version}/${asset}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download ${asset}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`${asset}: release checksum mismatch.`);
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o755 }); renameSync(tmp, target);
  }
  const launcher = join(bin, 'khala-codex'), source = join(ROOT, 'bin/khala-codex');
  const receipt = join(bin, '.khala-codex-receipt');
  if (existsSync(launcher) || isSymlink(launcher)) {
    if (!isSymlink(launcher) || !existsSync(receipt) || readlinkSync(launcher) !== readFileSync(receipt, 'utf8').trim()) {
      throw new Error(`${launcher} is manually managed; refusing to replace it.`);
    }
    unlinkSync(launcher);
  }
  symlinkSync(source, launcher); writeFileSync(receipt, source + '\n', { mode: 0o600 });
  console.log(`Installed khala-codex and Khala ${upstream.version}. Configure the node with khala-codex init <node> and ~/.khala/config, then declare KHALA_SESSION or .khala-codex-session.`);
}

function isSymlink(path) { try { return lstatSync(path).isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function atomicCopy(source, target) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  copyFileSync(source, tmp); chmodSync(tmp, 0o755); renameSync(tmp, target);
}
