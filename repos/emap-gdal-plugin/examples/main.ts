import { GdalService } from '../src/index.js';
import type { OverviewResampling } from '../src/index.js';
const element = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element ${id}`);
  return value as T;
};
const fileInput = element<HTMLInputElement>('file'), levels = element<HTMLInputElement>('levels');
const method = element<HTMLSelectElement>('method'), build = element<HTMLButtonElement>('build');
const cancel = element<HTMLButtonElement>('cancel'), status = element<HTMLPreElement>('status');
const outputs = element<HTMLElement>('outputs'), urls: string[] = [];
const gdal = new GdalService({ assetPath: '/gdal/' });
let controller: AbortController | undefined;
const clear = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url); outputs.replaceChildren(); };
cancel.onclick = () => controller?.abort();
build.onclick = async () => {
  const file = fileInput.files?.[0];
  if (!file) { status.textContent = '请先选择栅格文件。'; return; }
  clear(); controller = new AbortController(); build.disabled = true; cancel.disabled = false;
  try {
    const factors = levels.value.trim() ? levels.value.split(/[,\s]+/).filter(Boolean).map(Number) : undefined;
    const result = await gdal.createPyramid(file,
      { levels: factors, resampling: method.value as OverviewResampling },
      { signal: controller.signal, onProgress: ({ phase }) => { status.textContent = `处理阶段：${phase}`; } });
    status.textContent = JSON.stringify({ source: result.sourceName,
      resampling: result.resampling, levels: result.levels,
      files: result.files.map((value) => ({ name: value.name, bytes: value.size })),
      warnings: result.warnings }, null, 2);
    for (const value of result.files) {
      const link = document.createElement('a'), url = URL.createObjectURL(value);
      urls.push(url); link.href = url; link.download = value.name;
      link.textContent = `保存 ${value.name}（${value.size} bytes）`; outputs.append(link);
    }
  } catch (error) {
    status.textContent = error instanceof Error
      ? `${error.name}: ${error.message}` : String(error);
  } finally { controller = undefined; build.disabled = false; cancel.disabled = true; }
};
window.addEventListener('pagehide', () => { controller?.abort(); gdal.dispose(); clear(); }, { once: true });
