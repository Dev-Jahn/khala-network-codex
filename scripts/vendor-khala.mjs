import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/context.mjs';

export const UPSTREAM_REPOSITORY = 'Dev-Jahn/khala-network';
export const REQUIRED_ASSETS = [
  'khala-link-darwin-amd64',
  'khala-link-darwin-arm64',
  'khala-link-linux-amd64',
  'khala-link-linux-arm64',
];

export function releaseAssetDigests(release) {
  const byName = new Map((release.assets ?? []).map(asset => [asset.name, asset.digest]));
  return Object.fromEntries(REQUIRED_ASSETS.map(name => {
    const digest = byName.get(name);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
      throw new Error(`Missing release checksum: ${name}`);
    }
    return [name, digest.slice(7)];
  }));
}

export function readCheckoutInfo(checkout) {
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain', '--', 'bin/khala')) throw new Error('Upstream brain has uncommitted changes.');
  const bytes = readFileSync(join(checkout, 'bin/khala'));
  const match = bytes.toString().match(/^KHALA_VERSION=(\d+\.\d+\.\d+)$/m);
  if (!match) throw new Error('Upstream bin/khala has no valid KHALA_VERSION.');
  return { bytes, commit: git('rev-parse', 'HEAD'), version: match[1] };
}

export function vendorKhala(checkout, { release } = {}) {
  const { bytes, commit, version } = readCheckoutInfo(checkout);
  execFileSync('gh', ['api', `repos/${UPSTREAM_REPOSITORY}/commits/${commit}`], { stdio: 'ignore' });
  const resolvedRelease = release ?? JSON.parse(execFileSync(
    'gh', ['api', `repos/${UPSTREAM_REPOSITORY}/releases/tags/v${version}`], { encoding: 'utf8' },
  ));
  if (resolvedRelease.tag_name !== `v${version}`) {
    throw new Error(`Release tag ${resolvedRelease.tag_name} does not match CLI version ${version}.`);
  }
  const assets = releaseAssetDigests(resolvedRelease);
  writeFileSync(join(ROOT, 'vendor/khala/khala'), bytes, { mode: 0o755 });
  writeFileSync(join(ROOT, 'vendor/khala/upstream.json'), JSON.stringify({
    repository: `https://github.com/${UPSTREAM_REPOSITORY}`, commit, version,
    sha256: createHash('sha256').update(bytes).digest('hex'), assets,
  }, null, 2) + '\n');
  console.log(`Vendored unchanged Khala ${version} at ${commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkout = process.argv[2];
  if (!checkout) throw new Error('Usage: node scripts/vendor-khala.mjs /path/to/upstream-checkout');
  vendorKhala(checkout);
}
