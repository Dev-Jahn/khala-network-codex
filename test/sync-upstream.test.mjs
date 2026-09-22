import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, syncUpstream } from '../scripts/sync-upstream.mjs';

const assetNames = [
  'khala-link-darwin-amd64',
  'khala-link-darwin-arm64',
  'khala-link-linux-amd64',
  'khala-link-linux-arm64',
];
const digest = `sha256:${'a'.repeat(64)}`;
const release = (version, assets = assetNames.map(name => ({ name, digest }))) => ({
  tag_name: `v${version}`,
  assets,
});

function harness({ pinned = '0.9.7', latest = release('0.9.8'), checkoutVersion = '0.9.8' } = {}) {
  const calls = { checkout: 0, vendor: 0 };
  const output = [];
  return {
    calls,
    output,
    run: options => syncUpstream({
      dryRun: false,
      readPinned: () => ({ version: pinned }),
      fetchLatestRelease: () => latest,
      withCheckout: (_tag, useCheckout) => {
        calls.checkout++;
        return useCheckout('/stub/checkout');
      },
      readCheckout: () => ({ version: checkoutVersion, commit: 'b'.repeat(40) }),
      vendorCheckout: () => { calls.vendor++; },
      log: line => output.push(line),
      ...options,
    }),
  };
}

test('compares strict semantic versions numerically', () => {
  assert.equal(compareVersions('0.9.8', '0.9.7'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
  assert.throws(() => compareVersions('v1.2.3', '1.2.3'), /Invalid version/);
});

test('newer release checks out its tag and vendors it', () => {
  const subject = harness();
  assert.equal(subject.run(), true);
  assert.deepEqual(subject.calls, { checkout: 1, vendor: 1 });
});

test('equal release reports up to date without checkout or file changes', () => {
  const subject = harness({ latest: release('0.9.7') });
  assert.equal(subject.run(), false);
  assert.deepEqual(subject.calls, { checkout: 0, vendor: 0 });
  assert.match(subject.output.join('\n'), /up to date/i);
});

test('older latest release is refused', () => {
  const subject = harness({ pinned: '0.9.8', latest: release('0.9.7') });
  assert.throws(() => subject.run(), /Refusing to move backwards/);
  assert.deepEqual(subject.calls, { checkout: 0, vendor: 0 });
});

test('tag and checked-out CLI version mismatch is refused', () => {
  const subject = harness({ checkoutVersion: '0.9.9' });
  assert.throws(() => subject.run(), /does not match tag/);
  assert.deepEqual(subject.calls, { checkout: 1, vendor: 0 });
});

test('release missing any required asset digest is refused', () => {
  const assets = assetNames.slice(0, -1).map(name => ({ name, digest }));
  const subject = harness({ latest: release('0.9.8', assets) });
  assert.throws(() => subject.run(), /Missing release checksum.*linux-arm64/);
  assert.deepEqual(subject.calls, { checkout: 0, vendor: 0 });
});
