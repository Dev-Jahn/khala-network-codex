import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ROOT } from './context.mjs';

// ~/.local/bin/khala-codex outlives plugin upgrades, which delete the previous
// version directory. A copy in the Codex plugin cache installs a launcher that
// runs the newest installed version; a source checkout links to itself.
const CACHE = basename(dirname(ROOT)) === 'khala-network-codex' ? dirname(ROOT) : null;
const SOURCE = join(ROOT, 'bin/khala-codex');
const MARK = 'khala-codex-launcher sha256:';
const sha256 = text => createHash('sha256').update(text).digest('hex');

export function script(cache) {
  const reinstall = `codex plugin add khala-network-codex@${basename(dirname(cache))}`;
  return `#!/usr/bin/env node
// Written by khala-codex setup and kept current by the plugin's SessionStart
// hook; an edited copy is manually managed. Runs bin/khala-codex of the newest
// installed version of the Codex plugin khala-network-codex.
const cache = ${JSON.stringify(cache)};
const reinstall = ${JSON.stringify(reinstall)};
Promise.all([import('node:fs'), import('node:path'), import('node:url')]).then(([fs, path, url]) => {
  let names = [];
  try { names = fs.readdirSync(cache); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const version = names.filter(name => fs.existsSync(path.join(cache, name, 'bin/khala-codex')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  if (version === undefined) throw new Error(\`the Codex plugin khala-network-codex is not installed: no version in \${cache}. Reinstall it with \${reinstall}.\`);
  return import(url.pathToFileURL(path.join(cache, version, 'bin/khala-codex')).href);
}).catch(error => { console.error(\`khala-codex: \${error.message}\`); process.exitCode = 1; });
`;
}

function paths() {
  const bin = join(homedir(), '.local', 'bin');
  return { launcher: join(bin, 'khala-codex'), receipt: join(bin, '.khala-codex-receipt') };
}

// What occupies the launcher path (null for nothing); `ours` needs the receipt.
// A symlink, possibly dangling, is from an earlier setup or a source checkout.
function installed({ launcher, receipt }) {
  let stat, record = '';
  try { stat = lstatSync(launcher); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { record = readFileSync(receipt, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(launcher);
    return { ours: record === target, target, cache: dirname(dirname(dirname(target))) };
  }
  if (!stat.isFile() || !record.startsWith(MARK)) return { ours: false };
  const text = readFileSync(launcher, 'utf8'), cache = text.match(/^const cache = (".*");$/m)?.[1];
  return { ours: record === MARK + sha256(text), text, cache: cache && JSON.parse(cache) };
}

const current = item => CACHE ? item?.text === script(CACHE) : item?.target === SOURCE;

function install({ launcher, receipt }) {
  const tmp = `${launcher}.${randomUUID()}.tmp`;
  let record = SOURCE;
  if (CACHE) {
    const text = script(CACHE);
    writeFileSync(tmp, text, { mode: 0o755 });
    record = MARK + sha256(text);
  } else symlinkSync(SOURCE, tmp);
  renameSync(tmp, launcher);
  const temp = `${receipt}.${randomUUID()}.tmp`;
  writeFileSync(temp, record + '\n', { mode: 0o600 }); renameSync(temp, receipt);
}

export function installLauncher() {
  const where = paths(), item = installed(where);
  if (item && !item.ours) throw new Error(`${where.launcher} is manually managed; refusing to replace it.`);
  if (!current(item)) install(where);
}

// SessionStart repair: only an owned launcher for this plugin cache that is not
// current is replaced; where there is none, none is installed.
export function healLauncher() {
  if (!CACHE) return;
  const where = paths(), item = installed(where);
  if (item?.ours && item.cache === CACHE && !current(item)) install(where);
}
