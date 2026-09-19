/// <reference types="vite/client" />
import workerUrl from '../dist/dataset-worker.js?worker&url';
import { Emap } from '@mapseekai/emap';
import '@mapseekai/emap/style.css';
import { postgisPlugin } from '../dist/index.js';
import { postgisLayerPlugin } from '../dist/layers.js';
import { postgisControl } from '../dist/control.js';
const form = document.querySelector<HTMLFormElement>('#connect')!;
const status = document.querySelector<HTMLElement>('#status')!;
let map: Emap | undefined;
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button')!; button.disabled = true;
  try {
    status.textContent = '正在连接…'; await map?.dispose(); map = undefined;
    const endpoint = document.querySelector<HTMLInputElement>('#endpoint')!.value;
    const token = document.querySelector<HTMLInputElement>('#token')!.value;
    map = await Emap.create({ container: 'map', preset: 'viewer', plugins: [
      postgisPlugin({ endpoint, token, conversion: { workerUrl } }), postgisLayerPlugin(),
    ] });
    await map.addControl(postgisControl({ postgis: map.ctx.postgis, layers: map.ctx.postgisLayers }), 'top-right');
    status.textContent = '请在右侧选择连接并输入 SELECT。普通属性查询不要求几何字段。';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
});
window.addEventListener('pagehide', () => { void map?.dispose(); });
