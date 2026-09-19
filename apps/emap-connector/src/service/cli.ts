#!/usr/bin/env node
import { PostgisGateway } from '@mapseekai/emap-postgis-plugin/server';
import { ConsentBroker, type Grant } from './broker.js';
import { startHttp } from './http.js';
import { gatewayOptions, validateProfile, type Profile } from './profiles.js';
import { ConnectorError, CONNECTION_ID, DEFAULT_PORT, object, requireString, launchRequest } from './security.js';

/** Private, line-delimited IPC. No management endpoint is exposed on HTTP. */
async function main(): Promise<void> {
  if (process.argv[2] !== '--stdio' || process.argv.length > 4) {
    process.stdout.write('emap Connector service is managed by the desktop app.\nDeveloper IPC: node service.cjs --stdio [port]\n'); return;
  }
  const port = process.argv[3] === undefined ? DEFAULT_PORT : Number(process.argv[3]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConnectorError('INVALID_PORT', 'Invalid port');
  const gateways = new Map<string, PostgisGateway>();
  const profiles = new Map<string, Omit<Profile, 'password' | 'ca'>>();
  const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + '\n'); };
  const notify = () => send({ event: 'changed' });
  const broker = new ConsentBroker({ hasConnection: id => gateways.has(id), onPairing: () => send({ event: 'pairing' }) });
  const http = await startHttp({ broker, getGateway: id => gateways.get(id), port });
  let stopping = false; let queued = 0;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const force = setTimeout(() => process.exit(1), 5000); force.unref();
    await http.close(); await Promise.all([...gateways.values()].map(g => g.dispose()));
    process.exit(0);
  };
  const upsert = async (input: unknown) => {
    const profile = validateProfile(input);
    broker.revoke(undefined, profile.id);
    await gateways.get(profile.id)?.dispose();
    const gateway = new PostgisGateway(gatewayOptions(profile));
    gateways.set(profile.id, gateway);
    const { password, ca, ...metadata } = profile; profiles.set(profile.id, metadata);
    notify(); return { ok: true };
  };
  const execute = async (raw: unknown): Promise<unknown> => {
    const command = object(raw, ['id', 'method', 'params']); const p = command.params ?? {};
    switch (command.method) {
      case 'initialize': {
        const params = object(p, ['profiles', 'grants']);
        if (!Array.isArray(params.profiles) || !Array.isArray(params.grants) || params.profiles.length > 32 || params.grants.length > 128)
          throw new ConnectorError('INVALID_ARGUMENT', 'Invalid saved configuration');
        for (const profile of params.profiles) await upsert(profile);
        broker.restore(params.grants as Grant[]); notify(); return { ok: true };
      }
      case 'open': {
        const params = object(p, ['url']);
        if (typeof params.url !== 'string') throw new ConnectorError('INVALID_LAUNCH', 'Launch URL required');
        broker.open(launchRequest(params.url)); return { ok: true };
      }
      case 'validate': validateProfile(p); return { ok: true };
      case 'upsert': return upsert(p);
      case 'remove': {
        const params = object(p, ['connectionId']); const id = requireString(params.connectionId, CONNECTION_ID, 'connectionId');
        broker.revoke(undefined, id); await gateways.get(id)?.dispose(); gateways.delete(id); profiles.delete(id); notify(); return { ok: true };
      }
      case 'test': {
        const params = object(p, ['connectionId']); const id = requireString(params.connectionId, CONNECTION_ID, 'connectionId');
        const gateway = gateways.get(id); if (!gateway) throw new ConnectorError('UNKNOWN_CONNECTION', 'Connection not available');
        return gateway.testConnection(id);
      }
      case 'approve': {
        const params = object(p, ['requestId', 'connectionId', 'remember']);
        if (typeof params.requestId !== 'string' || typeof params.connectionId !== 'string' || typeof params.remember !== 'boolean')
          throw new ConnectorError('INVALID_ARGUMENT', 'Invalid approval');
        const grant = broker.approve(params.requestId, params.connectionId, params.remember); notify(); return { grant };
      }
      case 'deny': {
        const params = object(p, ['requestId']); if (typeof params.requestId !== 'string') throw new ConnectorError('INVALID_ARGUMENT', 'Request ID required');
        broker.deny(params.requestId); notify(); return { ok: true };
      }
      case 'revoke': {
        const params = object(p, ['origin', 'connectionId']);
        if (typeof params.origin !== 'string' || typeof params.connectionId !== 'string') throw new ConnectorError('INVALID_ARGUMENT', 'Exact origin and connection required');
        broker.revoke(params.origin, params.connectionId); notify(); return { ok: true };
      }
      case 'snapshot': return { ...broker.snapshot(), connections: [...profiles.values()], port: http.port };
      case 'shutdown': void stop(); return { ok: true };
      default: throw new ConnectorError('INVALID_COMMAND', 'Unknown native command');
    }
  };
  let buffer = ''; let queue = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 262144) { void stop(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (++queued > 64) { void stop(); return; }
      queue = queue.then(async () => {
        let id: unknown;
        try {
          const message = JSON.parse(line); id = message.id;
          if (typeof id !== 'string' || id.length > 80) throw new ConnectorError('INVALID_COMMAND', 'RPC ID required');
          const result = await execute(message); send({ id, result });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'COMMAND_FAILED';
          // Never serialize raw driver errors or input values (credentials/SQL may be present).
          const message = error instanceof ConnectorError ? error.message : 'Operation failed; check database settings, permissions and TLS';
          send({ id, error: { code, message } });
        } finally { queued--; }
      });
    }
  });
  process.stdin.on('end', () => void stop()); process.stdin.on('error', () => void stop());
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  send({ event: 'ready', port: http.port, protocolVersion: 1 });
}
void main().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'START_FAILED';
  process.stdout.write(JSON.stringify({ event: 'fatal', error: { code, message: code === 'EADDRINUSE' ? 'Port 18787 is already in use. Close the conflicting process and restart.' : 'Unable to start the local connector' } }) + '\n');
  process.exitCode = 1;
});
