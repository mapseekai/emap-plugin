import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
export async function startRuntime(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'emap-connector-test-'));
  const native = options.nativeExecutable ?? process.env.EMAP_TEST_SERVICE ?? fileURLToPath(new URL('../dist/service/emap-connector-service' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
  let executable, args;
  if (native) {
    executable = join(directory, process.platform === 'win32' ? 'service.exe' : 'service');
    await cp(native, executable); args = ['--stdio', '0'];
  }
  // The native service runs with no Node, JS resources or development node_modules.
  const child = spawn(executable, args, {
    cwd: directory, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(); let serial = 0; let readyResolve, readyReject; let stderr = '';
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timeout = setTimeout(() => readyReject(new Error('Packaged runtime did not become ready')), 15000);
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.stderr.on('data', bytes => { stderr += String(bytes).slice(0, 4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'ready') { clearTimeout(timeout); readyResolve(message); }
    if (message.event === 'fatal') readyReject(new Error(message.error.code));
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else item.resolve(message.result);
    }
  });
  child.once('error', readyReject);
  child.once('exit', () => {
    clearTimeout(timeout); readyReject(new Error('Runtime exited: ' + stderr));
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Runtime exited')); } pending.clear();
  });
  const close = async () => {
    child.stdin.end(); const timer = setTimeout(() => child.kill(), 6000);
    await exit; clearTimeout(timer); lines.close(); await rm(directory, { recursive: true, force: true });
  };
  try {
    const startup = await ready;
    return { child, directory, base: `http://127.0.0.1:${startup.port}`, close,
      rpc(method, params = {}) {
        return new Promise((resolve, reject) => {
          const id = String(++serial); const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 25000);
          pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
      },
    };
  } catch (error) { await close(); throw error; }
}
