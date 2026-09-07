import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../lib/context.mjs';

const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node scripts/vendor-khala.mjs /path/to/upstream-checkout');
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--', 'bin/khala')) throw new Error('Upstream brain has uncommitted changes.');
const commit = git('rev-parse', 'HEAD');
execFileSync('gh', ['api', `repos/Dev-Jahn/khala-network/commits/${commit}`], { stdio: 'ignore' });
const bytes = readFileSync(join(checkout, 'bin/khala'));
const version = bytes.toString().match(/^KHALA_VERSION=([0-9.]+)$/m)[1];
const release = JSON.parse(execFileSync('gh', ['api', `repos/Dev-Jahn/khala-network/releases/tags/v${version}`], { encoding: 'utf8' }));
const assets = Object.fromEntries(release.assets.filter(asset => asset.name.startsWith('khala-link-')).map(asset => {
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error(`Missing release checksum: ${asset.name}`);
  return [asset.name, asset.digest.slice(7)];
}));
writeFileSync(join(ROOT, 'vendor/khala/khala'), bytes, { mode: 0o755 });
writeFileSync(join(ROOT, 'vendor/khala/upstream.json'), JSON.stringify({
  repository: 'https://github.com/Dev-Jahn/khala-network', commit, version,
  sha256: createHash('sha256').update(bytes).digest('hex'), assets,
}, null, 2) + '\n');
console.log(`Vendored unchanged Khala ${version} at ${commit}`);
