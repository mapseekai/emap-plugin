import { Emap, Context } from '@mapseekai/emap';
import { postgisPlugin } from '@mapseekai/emap-postgis-plugin';
import { postgisLayerPlugin } from '@mapseekai/emap-postgis-plugin/layers';
import { createConnector } from '@mapseekai/emap-postgis-plugin/connector';
let map, connector, session;
export function install(baseUrl) {
  const states = [];
  connector = createConnector({ baseUrl,
    // Test substitutes OS dispatch only. All browser HTTP, proof, CLI and DB work is real.
    launch: url => { void window.nativeLaunch(url); }, onState: state => states.push(state),
  });
  document.querySelector('#connect').addEventListener('click', () => {
    window.connectionResult = connector.connect().then(async result => {
      session = result;
      map = await Emap.create({ container: 'map', preset: 'viewer', plugins: [
        postgisPlugin({ endpoint: session.endpoint, token: () => session.token, conversion: { workerUrl: new URL('/dataset-worker.js', location.href).href } }),
        postgisLayerPlugin(),
      ] });
      await map.setCRS('EPSG:3857');
      const tables = await map.ctx.postgis.tables(session.connectionId);
      const loaded = await map.ctx.postgisLayers.load({ sourceId: 'connector-test', query: {
        connectionId: session.connectionId, sql: 'SELECT id,name,geom FROM shapes ORDER BY id', idColumn: 'id',
      }, fitBounds: true });
      await new Promise(resolve => setTimeout(resolve, 1000));
      let coloredPixels = 0;
      for (const canvas of document.querySelectorAll('#map canvas')) {
        const ctx = canvas.getContext('2d'); if (!ctx || !canvas.width || !canvas.height) continue;
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250)) coloredPixels++;
      }
      return { nativeCordis: Context.is(map.ctx), states, connectionId: session.connectionId,
        tables: tables.map(t => t.table), layerCount: loaded.layerIds.length,
        types: map.getLayers().map(l => l.type), sourceCrs: map.getSource('connector-test').getCRS(), coloredPixels,
        persistedToken: Object.values(localStorage).includes(session.token) || Object.values(sessionStorage).includes(session.token),
      };
    });
    window.connectionResult.catch(() => {});
  });
}
export async function tryQueryAfterRevoke() {
  try { await map.ctx.postgis.query({ connectionId: session.connectionId, sql: 'SELECT 1' }); return 'ALLOWED'; }
  catch (error) { return error.code; }
}
export async function cleanup() { await map?.dispose(); await connector?.dispose(); }
