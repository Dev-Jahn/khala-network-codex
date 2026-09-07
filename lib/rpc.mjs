import WebSocket from '../vendor/ws/wrapper.mjs';
import { createConnection } from 'node:net';

// Codex serves WebSockets (including the HTTP upgrade) over its Unix socket.
// Connect to the explicitly selected server; never create or resume a thread.
export class Rpc {
  constructor(socket) {
    this.nextID = 1;
    this.pending = new Map();
    this.ws = new WebSocket('ws://localhost', {
      // ws+unix URLs cannot represent a ':' in a socket path; use the explicit
      // connection callback so paths never become URL syntax.
      createConnection: () => createConnection({ path: socket }), handshakeTimeout: 10000, perMessageDeflate: false });
    this.ws.on('error', error => this.fail(error));
    this.ws.on('close', () => this.fail(new Error('Codex WebSocket closed')));
    this.ws.on('message', line => {
      try {
        const message = JSON.parse(line.toString());
        if (message.method) { this.onNotification?.(message); return; }
        if (message.id === undefined) return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    this.error = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  request(method, params) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = this.nextID++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => { if (error) this.fail(error); });
    });
  }
  async initialize() {
    await new Promise((resolve, reject) => {
      if (this.error) { reject(this.error); return; }
      if (this.ws.readyState === WebSocket.OPEN) { resolve(); return; }
      this.ws.once('open', resolve); this.ws.once('error', reject);
    });
    this.serverInfo = await this.request('initialize', { clientInfo: { name: 'khala_codex', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.ws.send('{"method":"initialized"}');
    return this;
  }
  close() { this.fail(new Error('Codex RPC closed')); this.ws.terminate(); }
}
