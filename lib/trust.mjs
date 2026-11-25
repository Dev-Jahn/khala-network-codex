import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { accessSync, constants, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { executable } from './process.mjs';

const DEFAULT = 'khala-network-codex';
// The owner's public marketplace names, for each of its plugins, the one
// commit of the plugin's repository that is the published release; Codex
// installs the plugin as a clone of that commit.
const MARKET = 'jahns-codex-marketplace';
const MARKETPLACE = `https://raw.githubusercontent.com/Dev-Jahn/${MARKET}/main/.agents/plugins/marketplace.json`;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Runs `use(request)` against a Codex App Server for the CODEX_HOME in effect.
// Everything has to be answered within `timeout`.
async function appServer(use, timeout = 5000) {
  const server = spawn(executable('codex'), ['app-server', '--listen', 'stdio://'], { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
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
  server.on('error', error => fail(new Error(`codex did not start: ${error.message}`)));
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

// Every hook Codex lists, of every plugin.
async function listed(request) {
  const data = (await request('hooks/list', { cwds: [homedir()] }))?.data;
  if (!Array.isArray(data)) throw new Error('codex app-server answered hooks/list without a hook list');
  return data.flatMap(entry => entry.hooks ?? []);
}

function hooksOf(hooks, plugin) {
  if (!NAME.test(plugin)) throw new Error(`${JSON.stringify(plugin)} is not a plugin name`);
  const own = hooks.filter(hook => hook.pluginId?.startsWith(`${plugin}@`));
  if (!own.length) throw new Error(`Codex lists no ${plugin} hooks (is the plugin installed and enabled?)`);
  return own;
}

// Codex runs only the hooks it trusts and says nothing about the rest, so a
// hook cannot report its own lapsed trust (after a Codex update, for one).
// Codex's App Server is asked instead, once for all `plugins`. Resolves with
// one outcome per plugin: { plugin, hooks } as Codex lists them, or
// { plugin, error } when that could not be determined.
export async function hookTrust(plugins = [DEFAULT]) {
  let hooks;
  try { hooks = await appServer(listed); } catch (error) { return plugins.map(plugin => ({ plugin, error })); }
  return plugins.map(plugin => { try { return { plugin, hooks: hooksOf(hooks, plugin) }; } catch (error) { return { plugin, error }; } });
}

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

// Throws a Refusal unless the copy of `plugin` that Codex loads these `hooks`
// from is, file for file and byte for byte, the release the owner's
// marketplace publishes. `marketplace()` resolves with the marketplace file.
async function verifyPublished(plugin, hooks, marketplace, fetchBytes) {
  const foreign = hooks.find(hook => hook.pluginId !== `${plugin}@${MARKET}`);
  if (foreign) throw new Refusal(`Codex lists ${plugin} hooks under ${foreign.pluginId}, not ${plugin}@${MARKET}`);
  // The directory Codex loads the hooks from, not the one this script is in.
  const declared = join('hooks', 'hooks.json');
  const roots = new Set(hooks.map(hook => String(hook.sourcePath).endsWith(sep + declared) ? hook.sourcePath.slice(0, -declared.length - 1) : null));
  const [root] = roots;
  if (roots.size !== 1 || !root) throw new Refusal(`Codex does not report one plugin directory for the ${plugin} hooks`);

  let entry;
  try { entry = JSON.parse(await marketplace()).plugins.find(listing => listing.name === plugin); }
  catch (error) { throw error instanceof Refusal ? error : new Refusal(`${MARKETPLACE} is not a marketplace file: ${error.message}`); }
  if (!entry) throw new Refusal(`${MARKETPLACE} has no plugin named ${plugin}`);
  const { url, sha } = entry.source ?? {};
  const repository = /^(https:\/\/github\.com\/Dev-Jahn\/[A-Za-z0-9_-][A-Za-z0-9._-]*)\.git$/.exec(url)?.[1];
  if (!repository) throw new Refusal(`${MARKETPLACE} gives ${plugin} the source ${JSON.stringify(url)}, not a https://github.com/Dev-Jahn/<repository>.git`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Refusal(`${MARKETPLACE} pins ${plugin} to ${JSON.stringify(sha)}, not a full commit id`);

  const published = archiveFiles(await fetchBytes(`${repository}/archive/${sha}.tar.gz`));
  const installed = installedFiles(root);
  const version = files => { try { return JSON.parse(files.get('.codex-plugin/plugin.json')).version; } catch { return 'unknown'; } };
  const differing = [...new Set([...published.keys(), ...installed.keys()])].sort().flatMap(path =>
    !installed.has(path) ? [`${path} is missing`]
      : !published.has(path) ? [`${path} is not in the release`]
        : installed.get(path)?.equals(published.get(path)) ? [] : [`${path} differs`]);
  if (differing.length) {
    throw new Refusal(`${root} (version ${version(installed)}) is not the published release ${version(published)} (${repository} at ${sha}): ${differing.join('; ')}`);
  }
}

// Records trust, the way Codex's own /hooks review does, for every hook of
// `plugins` that Codex does not trust — but only for a plugin copy verified to
// be the published release. Resolves with one outcome per plugin:
// { plugin, hooks: [{ eventName, was, now }] }, or { plugin, error } with a
// Refusal when it must not record for that plugin, having changed nothing of
// it. Starts one App Server to list, and one more only when it has to record.
export async function trustHooks(plugins = [DEFAULT], fetchBytes = download) {
  let before, marketplace;
  try { before = await appServer(listed); } catch (error) { return plugins.map(plugin => ({ plugin, error })); }
  const outcomes = [];
  for (const plugin of plugins) {
    try {
      const hooks = hooksOf(before, plugin), lapsed = hooks.filter(hook => hook.trustStatus !== 'trusted');
      if (lapsed.length) await verifyPublished(plugin, hooks, () => marketplace ??= fetchBytes(MARKETPLACE), fetchBytes);
      outcomes.push({ plugin, hooks, lapsed });
    } catch (error) { outcomes.push({ plugin, error }); }
  }
  const lapsed = outcomes.flatMap(outcome => outcome.lapsed ?? []);
  let after = before;
  if (lapsed.length) {
    try {
      after = await appServer(async request => {
        // The hash recorded is the one Codex computes now. A hook whose hash
        // moved since it was listed belongs to files that changed while they
        // were being verified, so it is left for the next run.
        const current = new Map((await listed(request)).map(hook => [hook.key, hook.currentHash]));
        const state = Object.fromEntries(lapsed.filter(hook => current.get(hook.key) === hook.currentHash).map(hook => [hook.key, { trusted_hash: hook.currentHash }]));
        if (Object.keys(state).length) await request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', mergeStrategy: 'upsert', value: state }] });
        return listed(request);
      });
    } catch (error) {
      return outcomes.map(outcome => outcome.lapsed?.length ? { plugin: outcome.plugin, error } : outcome);
    }
  }
  const now = new Map(after.map(hook => [hook.key, hook.trustStatus]));
  return outcomes.map(({ plugin, hooks, error }) => error ? { plugin, error }
    : { plugin, hooks: hooks.map(hook => ({ eventName: hook.eventName, was: hook.trustStatus, now: now.get(hook.key) ?? 'not listed' })) });
}

// The plugins whose hook trust `khala-codex auto-trust --run` restores: one
// name per line in <khala home>/codex-auto-trust. No file means none.
const autoTrustFile = () => join(resolve(process.env.KHALA_HOME || join(homedir(), '.khala')), 'codex-auto-trust');

export function autoTrusted() {
  let text;
  try { text = readFileSync(autoTrustFile(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const plugins = text.split('\n').filter(Boolean);
  for (const plugin of plugins) if (!NAME.test(plugin)) throw new Error(`${autoTrustFile()} holds ${JSON.stringify(plugin)}, which is not a plugin name`);
  return plugins;
}

// Replaced whole, so a reader never sees half a file.
function replace(file, text) {
  writeFileSync(`${file}.${process.pid}`, text);
  renameSync(`${file}.${process.pid}`, file);
}

// Setting the list also records, in <list file>.path, a PATH on which the run
// works: the service that calls `auto-trust --run` has a minimal PATH of its
// own, with neither node nor codex on it. `node` is the node binary to record.
export function setAutoTrusted(plugins, node = process.execPath) {
  for (const plugin of plugins) if (!NAME.test(plugin)) throw new Error(`${JSON.stringify(plugin)} is not a plugin name`);
  const file = autoTrustFile();
  if (!plugins.length) { rmSync(file, { force: true }); rmSync(`${file}.path`, { force: true }); return; }
  const dirs = [dirname(node), ...(process.env.PATH ?? '').split(delimiter).filter(dir => dir && dir !== dirname(node))];
  const runs = dir => { try { accessSync(join(dir, 'codex'), constants.X_OK); return true; } catch { return false; } };
  if (!dirs.some(runs)) throw new Error(`codex is not on the PATH that the automatic run would use (${dirs.join(delimiter)}); nothing was set.`);
  replace(`${file}.path`, dirs.join(delimiter) + '\n');
  replace(file, [...new Set(plugins)].map(plugin => plugin + '\n').join(''));
}
