import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PostgisGateway } from '../../dist/server/index.js';
import { wkbToDataset } from '../../dist/dataset.js';
import { testDatabase } from './database.mjs';
const database = await testDatabase(); const checks = [];
const gateway = new PostgisGateway({ connections: { main: { config: database.config } }, onError: (error) => console.error(error.message) });
const request = (sql, extra = {}) => ({ connectionId: 'main', sql, ...extra });
const check = async (label, run) => { await run(); checks.push(label); };
try {
  const version = await gateway.testConnection('main'); assert.equal(version.ok, true);
  await check('connection discovery and spatial table catalog', async () => {
    assert.equal(gateway.connections().length, 1); assert((await gateway.tables('main')).some((t) => t.table === 'shapes'));
  });
  await check('native geometry -> EWKB -> real mapshaper Dataset', async () => {
    const result = await gateway.queryWkb(request('SELECT id,name,precise,geom FROM shapes ORDER BY id', { idColumn: 'id' }));
    assert.equal(result.rowCount, 3); assert.equal(result.format, 'ewkb');
    assert.equal(result.rows[0].properties.precise, '9007199254740993');
    assert(!Object.hasOwn(result.rows[0].properties, 'geom'));
    const { dataset } = wkbToDataset(result);
    assert.deepEqual(new Set(dataset.layers.map((l) => l.geometry_type)), new Set(['point','polyline','polygon']));
    assert.equal(dataset.info.crs_string, 'EPSG:4326');
  });
  for (const expression of ['ST_AsEWKB(geom)', 'ST_AsBinary(geom)', "encode(ST_AsEWKB(geom),'hex')", "geom::geography"]) {
    await check(`SELECT ${expression} AS shape`, async () => {
      const result = await gateway.queryWkb(request(`SELECT id,${expression} AS shape FROM shapes WHERE id=$1`, { parameters: [1], geometryColumn: 'shape', sourceSrid: 4326 }));
      assert.equal(result.rowCount, 1); assert.equal(wkbToDataset(result).dataset.layers[0].geometry_type, 'point');
    });
  }
  await check('standard WKB metadata, target CRS and known-SRID preservation', async () => {
    const result = await gateway.queryWkb(request('SELECT geom FROM shapes WHERE id=1', { format: 'wkb', targetSrid: 3857, sourceSrid: 4490 }));
    assert.equal(result.srid, 3857); assert.equal(result.format, 'wkb');
    const shape = wkbToDataset(result).dataset.layers[0].shapes[0]; assert(Math.abs(shape[0][0] - 1168854.6533293726) < 0.001);
  });
  await check('WITH, bound parameters and pagination', async () => {
    const page = await gateway.queryWkb(request('WITH q AS (SELECT * FROM shapes WHERE id > $1) SELECT * FROM q ORDER BY id', { parameters: [0], limit: 1, offset: 1 }));
    assert.equal(page.rows[0].properties.name, 'line'); assert.equal(page.hasMore, true);
  });
  await check('collections, Z/M normalization, NULL and EMPTY', async () => {
    for (const geom of ["ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))',4326)",
      "ST_GeomFromText('POINT ZM(1 2 3 4)',4326)", 'NULL::geometry', "ST_GeomFromText('POINT EMPTY',4326)"]) {
      const result = await gateway.queryWkb(request(`SELECT ${geom} AS geom`));
      assert.equal(result.rowCount, 1); assert.doesNotThrow(() => wkbToDataset(result));
    }
  });
  await check('rejects writes, duplicate output names and ambiguous geometry', async () => {
    for (const sql of ['DELETE FROM shapes', 'WITH q AS (DELETE FROM shapes RETURNING *) SELECT * FROM q', 'SELECT geom,geom FROM shapes', 'SELECT geom AS a,geom AS b FROM shapes'])
      await assert.rejects(gateway.queryWkb(request(sql)));
  });
  await check('accepts administrative accounts while queries remain read-only', async () => {
    const unsafe = new PostgisGateway({ connections: { main: { config: database.adminConfig } } });
    try { assert.equal((await unsafe.testConnection('main')).ok, true); await assert.rejects(unsafe.query({connectionId:'main',sql:'DELETE FROM shapes'}),e=>e.code==='SELECT_ONLY'); }
    finally { await unsafe.dispose(); }
  });
  await mkdir('test-results/integration', { recursive: true });
  const report = { postgisVersion: version.postgisVersion, count: checks.length, checks };
  await writeFile('test-results/integration/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await gateway.dispose(); await database.dispose(); }
