import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { nativeConduitReady } from '../lib/launch.mjs';
import { fixture, put } from './helpers.mjs';

test('native launch requires a fresh, running compatible conduit, not just an upgraded binary', t => {
  const { ctx } = fixture(t);
  const path = join(ctx.home, 'presence', 'conduit@test.ear');
  const ear = (version, written, state = 'running') => `ears 1\nnode test\nwritten-at ${written}\nstate ${state}\ncomponent conduit release=${version} adapter=1 ears=1\n`;
  assert.equal(nativeConduitReady(ctx, 1000), false);
  put(path, ear('0.9.5', 1000)); assert.equal(nativeConduitReady(ctx, 1000), false);
  put(path, ear('0.9.7', 1000)); assert.equal(nativeConduitReady(ctx, 1000), true);
  put(path, ear('0.9.7', 1000)); assert.equal(nativeConduitReady(ctx, 1300), false);
  put(path, ear('0.9.7', 1001)); assert.equal(nativeConduitReady(ctx, 1000), false);
  put(path, ear('0.9.7', 1000, 'stopped')); assert.equal(nativeConduitReady(ctx, 1000), false);
});
