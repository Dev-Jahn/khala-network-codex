import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/context.mjs';
import {
  UPSTREAM_REPOSITORY,
  readCheckoutInfo,
  releaseAssetDigests,
  vendorKhala,
} from './vendor-khala.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;

export function compareVersions(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right)) {
    throw new Error(`Invalid version comparison: ${left} and ${right}.`);
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function versionFromRelease(release) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
  if (!match) throw new Error(`Invalid upstream release tag: ${release.tag_name}.`);
  return match[1];
}

function fetchLatestRelease() {
  return JSON.parse(execFileSync(
    'gh', ['api', `repos/${UPSTREAM_REPOSITORY}/releases/latest`], { encoding: 'utf8' },
  ));
}

function withCheckout(tag, useCheckout) {
  const temporary = mkdtempSync(join(tmpdir(), 'khala-upstream-'));
  const checkout = join(temporary, 'checkout');
  try {
    execFileSync('git', ['-c', 'advice.detachedHead=false',
      'clone', '--quiet', '--depth', '1', '--branch', tag, '--single-branch',
      `https://github.com/${UPSTREAM_REPOSITORY}.git`, checkout,
    ]);
    return useCheckout(checkout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function syncUpstream({
  dryRun = false,
  readPinned = () => JSON.parse(readFileSync(join(ROOT, 'vendor/khala/upstream.json'), 'utf8')),
  fetchLatestRelease: fetchRelease = fetchLatestRelease,
  withCheckout: checkoutTag = withCheckout,
  readCheckout = readCheckoutInfo,
  vendorCheckout = vendorKhala,
  log = console.log,
} = {}) {
  const pinned = readPinned();
  const release = fetchRelease();
  const version = versionFromRelease(release);
  const assets = releaseAssetDigests(release);
  const comparison = compareVersions(version, pinned.version);
  if (comparison < 0) {
    throw new Error(`Refusing to move backwards from ${pinned.version} to ${version}.`);
  }
  if (comparison === 0) {
    log(`Khala ${pinned.version} is up to date.`);
    return false;
  }

  return checkoutTag(release.tag_name, checkout => {
    const checkedOut = readCheckout(checkout);
    if (checkedOut.version !== version) {
      throw new Error(`CLI version ${checkedOut.version} does not match tag ${release.tag_name}.`);
    }
    if (dryRun) {
      log(`Khala ${version} is available at ${checkedOut.commit}.`);
      for (const [name, digest] of Object.entries(assets)) log(`${name} sha256:${digest}`);
      log('Dry run: no files changed.');
      return true;
    }
    vendorCheckout(checkout, { release });
    return true;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run') || args.length > 1) {
    throw new Error('Usage: node scripts/sync-upstream.mjs [--dry-run]');
  }
  const changed = syncUpstream({ dryRun: args[0] === '--dry-run' });
  console.log(changed ? 'Upstream sync found a newer release.' : 'Upstream sync made no changes.');
}
