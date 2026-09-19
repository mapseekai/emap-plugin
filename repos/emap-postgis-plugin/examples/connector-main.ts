/// <reference types="vite/client" />
import { Emap } from '@mapseekai/emap';
import '@mapseekai/emap/style.css';
import workerUrl from '../dist/dataset-worker.js?worker&url';
import { createConnector, type ConnectorSession } from '../dist/connector.js';
import { postgisPlugin } from '../dist/index.js';
import { postgisLayerPlugin } from '../dist/layers.js';
import { postgisControl } from '../dist/control.js';
const status = document.querySelector<HTMLElement>('#status')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const disconnect = document.querySelector<HTMLButtonElement>('#disconnect')!;
let map: Emap | undefined, session: ConnectorSession | undefined, pending: AbortController | undefined;
let generation = 0;
const connector = createConnector({ onState(state, detail) {
  if (state === 'starting') status.textContent = `正在打开本地连接器… 配对编号 ${detail}`;
  if (state === 'waiting-for-approval') status.textContent = `请在连接器中核对当前站点和编号 ${detail}，选择数据库并授权。`;
} });
async function release(): Promise<void> {
  const oldMap = map, oldSession = session; map = undefined; session = undefined;
  await oldMap?.dispose(); await oldSession?.close();
}
connect.addEventListener('click', () => {
  const own = ++generation; pending = new AbortController(); const signal = pending.signal;
  connect.disabled = true; cancel.disabled = false;
  // Call before any await so external-protocol navigation retains the click gesture.
  const paired = connector.connect({ signal });
  void (async () => {
    try {
      const nextSession = await paired;
      if (signal.aborted || own !== generation) { await nextSession.close(); return; }
      session = nextSession;
      const nextMap = await Emap.create({ container: 'map', preset: 'viewer', plugins: [
        postgisPlugin({ endpoint: session.endpoint, token: () => nextSession.token, conversion: { workerUrl } }),
        postgisLayerPlugin(),
      ] });
      if (signal.aborted || own !== generation) { await nextMap.dispose(); await nextSession.close(); return; }
      map = nextMap;
      await map.addControl(postgisControl({ postgis: map.ctx.postgis, layers: map.ctx.postgisLayers,
        sql: 'SELECT id, geom FROM public.your_table ORDER BY id' }), 'top-right');
      status.textContent = '已授权。请在右侧选择空间表或输入自己的 SELECT；会话最长 1 小时。';
      disconnect.disabled = false;
    } catch (error) {
      await release(); status.textContent = error instanceof Error ? error.message : String(error);
    } finally { if (own === generation) { pending = undefined; cancel.disabled = true; connect.disabled = Boolean(map); } }
  })();
});
cancel.addEventListener('click', () => pending?.abort(new DOMException('已取消连接', 'AbortError')));
disconnect.addEventListener('click', () => {
  generation++; pending?.abort(); disconnect.disabled = true;
  void release().finally(() => { connect.disabled = false; status.textContent = '已断开网页会话，连接器可在托盘中继续使用。'; });
});
window.addEventListener('pagehide', () => { generation++; pending?.abort(); void release(); void connector.dispose(); });
