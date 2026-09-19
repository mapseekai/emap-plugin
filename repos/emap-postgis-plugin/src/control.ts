import type { Control } from '@mapseekai/emap';
import type { PostgisContract, FeatureQueryRequest } from './types.js';
import type { PostgisLayersContract } from './layers.js';
import { assertActive } from './errors.js';
export interface PostgisControlOptions {
  postgis: PostgisContract; layers: PostgisLayersContract; sql?: string;
}
/** Create a new control per map; service handles are supplied explicitly. */
export function postgisControl(options: PostgisControlOptions): Control {
  let life: AbortController | undefined;
  let operation: AbortController | undefined;
  return {
    inject: ['postgis', 'postgisLayers'],
    onAdd() {
      life = new AbortController(); const lifecycle = life;
      const root = document.createElement('section'); root.setAttribute('aria-label', 'PostGIS 查询');
      root.style.cssText = 'width:340px;max-height:75vh;overflow:auto;background:white;color:#222;padding:12px;border-radius:6px;box-shadow:0 2px 12px #0003;font:13px sans-serif;pointer-events:auto';
      const title = document.createElement('strong'); title.textContent = 'PostGIS · SELECT 查询'; root.append(title);
      const field = <T extends HTMLElement>(label: string, element: T): T => {
        const wrapper = document.createElement('label'); wrapper.style.cssText = 'display:block;margin:8px 0';
        wrapper.append(document.createTextNode(label), document.createElement('br'), element); root.append(wrapper);
        element.style.cssText = 'box-sizing:border-box;width:100%'; return element;
      };
      const connection = field('连接', document.createElement('select'));
      const sql = field('SELECT 语句', document.createElement('textarea')); sql.rows = 5;
      sql.value = options.sql ?? ''; sql.placeholder = 'SELECT id, name, geom FROM public.roads ORDER BY id';
      const parameters = field('参数（JSON 数组，对应 $1、$2）', document.createElement('input')); parameters.value = '[]';
      const geometry = field('几何字段（单个空间字段可留空）', document.createElement('input'));
      const idColumn = field('要素 ID 字段（可选）', document.createElement('input'));
      const limit = field('每页条数', document.createElement('input')); limit.type = 'number'; limit.value = '1000'; limit.min = '1';
      const status = document.createElement('pre'); status.setAttribute('aria-live', 'polite');
      status.style.cssText = 'white-space:pre-wrap;max-height:160px;overflow:auto';
      async function run(action: (signal: AbortSignal) => Promise<string>): Promise<void> {
        operation?.abort(); const task = new AbortController(); operation = task;
        status.textContent = '正在查询…';
        try {
          const message = await action(task.signal); assertActive(task.signal); assertActive(lifecycle.signal);
          status.textContent = message;
        } catch (error) {
          if (operation === task && !lifecycle.signal.aborted) status.textContent = task.signal.aborted ? '已取消' : error instanceof Error ? error.message : String(error);
        }
      }
      const button = (label: string, handler: () => void) => {
        const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
        item.style.margin = '3px'; item.addEventListener('click', handler, { signal: lifecycle.signal }); root.append(item);
      };
      const input = (): FeatureQueryRequest => ({ connectionId: connection.value, sql: sql.value,
        parameters: JSON.parse(parameters.value || '[]'), limit: Number(limit.value),
        geometryColumn: geometry.value.trim() || undefined, idColumn: idColumn.value.trim() || undefined,
      });
      button('测试连接', () => void run(async (signal) => JSON.stringify(await options.postgis.testConnection(connection.value, { signal }))));
      button('空间表', () => void run(async (signal) => JSON.stringify(await options.postgis.tables(connection.value, { signal }), null, 2)));
      button('查询属性', () => void run(async (signal) => {
        const result = await options.postgis.query(input(), { signal });
        return `${result.rowCount} 行${result.hasMore ? '（还有下一页）' : ''}\n` + JSON.stringify(result.rows.slice(0, 20), null, 2);
      }));
      button('加载到地图', () => void run(async (signal) => {
        const loaded = await options.layers.load({ sourceId: `postgis-${crypto.randomUUID()}`, query: input() }, { signal });
        return `已加载 ${loaded.result.rowCount} 条记录 / ${loaded.layerIds.length} 个图层${loaded.result.hasMore ? '；结果已分页，请收紧筛选或通过 API 翻页' : ''}`;
      }));
      button('取消', () => operation?.abort()); root.append(status);
      void run(async (signal) => {
        const items = await options.postgis.connections({ signal }); assertActive(signal); assertActive(lifecycle.signal);
        for (const item of items) connection.add(new Option(item.label, item.id));
        return items.length ? '连接已就绪，可输入 SELECT 语句' : '服务端未配置连接';
      });
      return root;
    },
    onRemove() { operation?.abort(); life?.abort(); operation = undefined; life = undefined; },
  };
}
