import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/context.mjs';

const [checkout, sha] = process.argv.slice(2);
if (!checkout || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Usage: pin-marketplace.mjs /marketplace/checkout <40-character commit>');
const path = join(checkout, '.agents/plugins/marketplace.json');
const marketplace = JSON.parse(readFileSync(path, 'utf8'));
if (marketplace.name !== 'jahns-codex-marketplace') throw new Error('Unexpected marketplace.');
const manifest = JSON.parse(readFileSync(join(ROOT, '.codex-plugin/plugin.json'), 'utf8'));
const matches = marketplace.plugins.filter(plugin => plugin.name === manifest.name);
if (matches.length > 1) throw new Error('Duplicate marketplace entries.');
const entry = matches[0] ?? { name: manifest.name };
Object.assign(entry, {
  source: { source: 'url', url: 'https://github.com/Dev-Jahn/khala-network-codex.git', sha },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Developer Tools', version: manifest.version, description: manifest.description,
});
if (!matches.length) marketplace.plugins.push(entry);
writeFileSync(path, JSON.stringify(marketplace, null, 2) + '\n');
