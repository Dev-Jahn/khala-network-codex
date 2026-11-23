import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';

// Codex runs only the hooks it trusts and says nothing about the rest, so a
// hook cannot report its own lapsed trust (after a Codex update, for one).
// Codex's App Server is asked instead. Resolves with this plugin's hooks as
// Codex lists them; rejects when that cannot be determined.
export async function hookTrust(timeout = 5000) {
  const server = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
  let timer;
  try {
    const listed = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`codex app-server did not answer within ${timeout / 1000} s`)), timeout);
      server.on('error', error => reject(new Error(error.code === 'ENOENT' ? 'codex is not on PATH' : `codex did not start: ${error.message}`)));
      server.on('exit', (code, signal) => reject(new Error(`codex app-server exited (${signal ?? code}) without answering`)));
      server.stdin.on('error', reject);
      const send = message => server.stdin.write(JSON.stringify(message) + '\n');
      createInterface({ input: server.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) reject(new Error(`codex app-server: ${message.error.message}`));
        else if (message.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [homedir()] } }); }
        else resolve(message.result?.data);
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'khala_codex', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
    });
    if (!Array.isArray(listed)) throw new Error('codex app-server answered hooks/list without a hook list');
    const hooks = listed.flatMap(entry => entry.hooks ?? []).filter(hook => hook.pluginId?.startsWith('khala-network-codex@'));
    if (!hooks.length) throw new Error('Codex lists no khala-network-codex hooks (is the plugin installed and enabled?)');
    return hooks;
  } finally {
    clearTimeout(timer);
    server.kill();
  }
}
