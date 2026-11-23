import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const PLUGIN = 'khala-network-codex';
const REPOSITORY = 'https://github.com/Dev-Jahn/khala-network-codex';
// The owner's public marketplace names the one commit of REPOSITORY that is
// the published release; Codex installs the plugin as a clone of that commit.
const MARKETPLACE = 'https://raw.githubusercontent.com/Dev-Jahn/jahns-codex-marketplace/main/.agents/plugins/marketplace.json';

// Runs `use(request)` against a Codex App Server for the CODEX_HOME in effect.
// Everything has to be answered within `timeout`.
async function appServer(use, timeout = 5000) {
  const server = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let failure = null, sent = 0, timer;
  const fail = error => {
    failure ??= error;
    for (const { reject } of waiting.values()) reject(failure);
    waiting.clear();
  };
  const send = message => server.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    waiting.set(++sent, { resolve, reject });
    send({ id: sent, method, params });
  });
  server.on('error', error => fail(new Error(error.code === 'ENOENT' ? 'codex is not on PATH' : `codex did not start: ${error.message}`)));
  server.on('exit', (code, signal) => fail(new Error(`codex app-server exited (${signal ?? code}) without answering`)));
  server.stdin.on('error', fail);
  createInterface({ input: server.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.reject(new Error(`codex app-server: ${message.error.message}`));
    else call.resolve(message.result);
  });
  try {
    timer = setTimeout(() => fail(new Error(`codex app-server did not answer within ${timeout / 1000} s`)), timeout);
    await request('initialize', { clientInfo: { name: 'khala_codex', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    return await use(request);
  } finally {
    clearTimeout(timer);
    server.kill();
  }
}

async function list(request) {
  const listed = (await request('hooks/list', { cwds: [homedir()] }))?.data;
  if (!Array.isArray(listed)) throw new Error('codex app-server answered hooks/list without a hook list');
  const hooks = listed.flatMap(entry => entry.hooks ?? []).filter(hook => hook.pluginId?.startsWith(`${PLUGIN}@`));
  if (!hooks.length) throw new Error(`Codex lists no ${PLUGIN} hooks (is the plugin installed and enabled?)`);
  return hooks;
}

// Codex runs only the hooks it trusts and says nothing about the rest, so a
// hook cannot report its own lapsed trust (after a Codex update, for one).
// Codex's App Server is asked instead. Resolves with this plugin's hooks as
// Codex lists them; rejects when that cannot be determined.
export const hookTrust = () => appServer(list);

// The reason trust was not recorded; nothing was changed.
export class Refusal extends Error {}

async function download(url) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(30000) }); }
  catch (error) { throw new Refusal(`${url} could not be fetched: ${error.cause?.message ?? error.message}`); }
  if (!response.ok) throw new Refusal(`${url} could not be fetched: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// The regular files of a GitHub source archive (.tar.gz), by path below the
// archive's single top directory.
function archiveFiles(archive) {
  const tar = gunzipSync(archive), files = new Map();
  let longPath = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const field = (from, length) => tar.toString('utf8', at + from, at + from + length).replace(/\0.*$/s, '');
    if (!field(0, 100)) break;
    const size = parseInt(field(124, 12), 8), type = field(156, 1) || '0';
    const body = tar.subarray(at + 512, at + 512 + size);
    const path = longPath ?? (field(345, 155) ? `${field(345, 155)}/` : '') + field(0, 100);
    at += 512 + Math.ceil(size / 512) * 512;
    longPath = type === 'x' ? body.toString('utf8').match(/^\d+ path=(.*)$/m)?.[1] ?? null : null;
    if (type === '0') files.set(path.slice(path.indexOf('/') + 1), body);
    else if (!'5gx'.includes(type)) throw new Refusal(`the published release holds ${path}, which is not a regular file`);
  }
  return files;
}

// What Codex installed, by path: a clone of the release commit, so everything
// except the clone's own .git directory. Anything that is not a regular file
// is kept as null and can equal no published file.
function installedFiles(root, below = '') {
  const files = new Map();
  for (const name of readdirSync(join(root, below))) {
    const path = below ? `${below}/${name}` : name;
    if (path === '.git') continue;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) for (const entry of installedFiles(root, path)) files.set(...entry);
    else files.set(path, stat.isFile() ? readFileSync(join(root, path)) : null);
  }
  return files;
}

// Throws a Refusal unless the plugin copy at `root` is, file for file and byte
// for byte, the release the owner's marketplace publishes.
async function verifyPublished(root, fetchBytes) {
  let entry;
  try { entry = JSON.parse(await fetchBytes(MARKETPLACE)).plugins.find(plugin => plugin.name === PLUGIN); }
  catch (error) { throw error instanceof Refusal ? error : new Refusal(`${MARKETPLACE} is not a marketplace file: ${error.message}`); }
  if (entry?.source?.url !== `${REPOSITORY}.git` || !/^[0-9a-f]{40}$/.test(entry.source.sha)) {
    throw new Refusal(`${MARKETPLACE} publishes no ${PLUGIN} release from ${REPOSITORY}`);
  }
  const published = archiveFiles(await fetchBytes(`${REPOSITORY}/archive/${entry.source.sha}.tar.gz`));
  const installed = installedFiles(root);
  const version = files => { try { return JSON.parse(files.get('.codex-plugin/plugin.json')).version; } catch { return 'unknown'; } };
  const differing = [...new Set([...published.keys(), ...installed.keys()])].sort().flatMap(path =>
    !installed.has(path) ? [`${path} is missing`]
      : !published.has(path) ? [`${path} is not in the release`]
        : installed.get(path)?.equals(published.get(path)) ? [] : [`${path} differs`]);
  if (differing.length) {
    throw new Refusal(`${root} (version ${version(installed)}) is not the published release ${version(published)} (${REPOSITORY} at ${entry.source.sha}): ${differing.join('; ')}`);
  }
}

// Records trust, the way Codex's own /hooks review does, for every hook of
// this plugin that Codex does not trust — but only for a plugin copy verified
// to be the published release. Resolves with one { eventName, was, now } per
// hook; rejects with a Refusal when it must not record, having changed nothing.
export async function trustHooks(fetchBytes = download) {
  const before = await hookTrust();
  const lapsed = before.filter(hook => hook.trustStatus !== 'trusted');
  if (lapsed.length) {
    // The directory Codex loads the hooks from, not the one this script is in.
    const declared = join('hooks', 'hooks.json');
    const roots = new Set(before.map(hook => String(hook.sourcePath).endsWith(sep + declared) ? hook.sourcePath.slice(0, -declared.length - 1) : null));
    const [root] = roots;
    if (roots.size !== 1 || !root) throw new Refusal(`Codex does not report one plugin directory for the ${PLUGIN} hooks`);
    await verifyPublished(root, fetchBytes);
  }
  const after = !lapsed.length ? before : await appServer(async request => {
    const state = Object.fromEntries(lapsed.map(hook => [hook.key, { trusted_hash: hook.currentHash }]));
    await request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: state }] });
    return list(request);
  });
  const now = new Map(after.map(hook => [hook.key, hook.trustStatus]));
  return before.map(hook => ({ eventName: hook.eventName, was: hook.trustStatus, now: now.get(hook.key) ?? 'not listed' }));
}
