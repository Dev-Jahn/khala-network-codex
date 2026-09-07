import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../lib/context.mjs';

const read = path => readFileSync(join(ROOT, path), 'utf8');
const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
assert.equal(manifest.name, 'khala-network-codex');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(JSON.parse(read('package.json')).version, manifest.version);
assert.ok(!JSON.stringify(manifest).includes('[TODO:'));
for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
  assert.ok(JSON.parse(read('hooks/hooks.json')).hooks[event]);
}
assert.match(read('skills/khala/SKILL.md'), /^---\nname: khala\n/);
const upstream = JSON.parse(read('vendor/khala/upstream.json'));
assert.match(upstream.commit, /^[0-9a-f]{40}$/);
assert.equal(createHash('sha256').update(read('vendor/khala/khala')).digest('hex'), upstream.sha256);
assert.ok(read('vendor/khala/khala').includes(`KHALA_VERSION=${upstream.version}\n`));
for (const [path, hash] of Object.entries(JSON.parse(read('vendor/ws.sha256.json')))) {
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'vendor/ws', path))).digest('hex'), hash, path);
}
console.log(`Plugin ${manifest.version}, hooks, skill, and pinned vendor files validated.`);
