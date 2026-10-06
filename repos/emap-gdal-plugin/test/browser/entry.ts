import { GdalService, gdalPlugin } from '../../dist/index.js';
import { gdalGeoTIFFPlugin } from '../../dist/geotiff.js';
import { Emap } from '@mapseekai/emap';
import { Context } from '@mapseekai/emap/context';
import { rasterPlugin, geoTIFFPlugin, openGeoTIFF } from '@mapseekai/emap/geotiff';
export async function run() {
  const checks: string[] = [];
  const check = (ok: unknown, name: string) => {
    if (!ok) throw new Error(name);
    checks.push(name); console.log('PASS', name);
  };
  const equal = (a: unknown, b: unknown, name: string) => check(JSON.stringify(a) === JSON.stringify(b), name);
  let created = 0, terminated = 0, active = 0, peak = 0;
  const createWorker = (url: URL, config: WorkerOptions) => {
    const worker = new Worker(url, config), stop = worker.terminate.bind(worker);
    let closed = false;
    created++; active++; peak = Math.max(peak, active);
    worker.terminate = () => { if (!closed) { closed = true; active--; terminated++; stop(); } };
    return worker;
  };
  const options = { assetPath: '/gdal/', createWorker, timeoutMs: 60000 };
  const gdal = new GdalService(options);
  const file = new File([await (await fetch('/test/fixtures/overview-uint16.tif')).blob()], '高景.test.tif');
  const before = new Uint8Array(await file.arrayBuffer());
  const phases: string[] = [];
  try {
    const pyramid = await gdal.buildOverviews(file, { levels: [2, 4, 8], resampling: 'average' },
      { onProgress: (event) => phases.push(event.phase) });
    equal(pyramid.overviewFile.name, '高景.test.tif.ovr', 'Unicode sidecar filename');
    equal(phases, ['queued', 'initializing', 'opening', 'executing', 'exporting', 'completed'], 'honest task phases');
    const overview: any = await gdal.gdalinfo(pyramid.overviewFile);
    equal(overview.size, [32, 24], 'actual overview base dimensions');
    equal(overview.bands[0].type, 'UInt16', 'preserves UInt16 samples');
    equal(overview.bands[0].overviews.map((v: any) => v.size), [[16, 12], [8, 6]], 'actual nested overview dimensions');
    const attached: any = await gdal.gdalinfo([pyramid.overviewFile, file]);
    equal(attached.bands[0].overviews.map((v: any) => v.size), [[32, 24], [16, 12], [8, 6]], 'GDAL reopens original plus sidecar');
    const after = new Uint8Array(await file.arrayBuffer());
    check(before.every((byte, i) => after[i] === byte) && before.length === after.length, 'original bytes unchanged');
    const rebuilt = await gdal.gdaladdo([file, pyramid.overviewFile], { args: ['-ro', '-r', 'nearest', '4'] });
    equal((await gdal.gdalinfo(rebuilt.primary) as any).size, [16, 12], 'native gdaladdo external rebuild');
    const translated = await gdal.translate(file, { args: ['-of', 'GTiff', '-outsize', '1024', '768'] });
    const auto = await gdal.createPyramid(translated.primary);
    equal(auto.levels.map((v) => v.factor), [2, 4], 'automatic overview factors');
    equal((await gdal.gdalinfo(auto.overviewFile) as any).size, [512, 384], 'automatic overviews exist in output TIFF');
    const warped = await gdal.warp(file, { args: ['-of', 'GTiff', '-t_srs', 'EPSG:4326'] });
    check((await gdal.getInfo(warped.primary)).projectionWkt?.includes('WGS 84'), 'raster reprojection');
    const vectors = new File([JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { id: 1 }, geometry: { type: 'Point', coordinates: [12, 48] } }] })], 'points.geojson');
    const shape = await gdal.ogr2ogr(vectors, { args: ['-f', 'ESRI Shapefile'], outputName: 'points' });
    check(['shp', 'shx', 'dbf'].every((ext) => shape.files.some((f) => f.name.endsWith(`.${ext}`))), 'complete Shapefile outputs');
    const roundtrip = await gdal.vectorTranslate(shape.files);
    check(JSON.parse(await roundtrip.primary.text()).features.length === 1, 'vector format round trip');
    const raster = await gdal.rasterize(vectors, { args: ['-of', 'GTiff', '-burn', '7', '-ot', 'Byte',
      '-te', '11.9', '47.9', '12.1', '48.1', '-ts', '20', '20'] });
    equal((await gdal.getInfo(raster.primary)).width, 20, 'vector rasterization');
    const pixel = await gdal.locationInfo(raster.primary, [48, 12]);
    check(pixel.pixel >= 9 && pixel.pixel <= 10 && pixel.line >= 9 && pixel.line <= 10, 'coordinate to pixel lookup');
    const coordinates = await gdal.transform([[12, 48]], ['-s_srs', 'EPSG:4326', '-t_srs', 'EPSG:3857']);
    check(coordinates[0][0] > 1000000 && coordinates[0][1] > 6000000, 'coordinate transformation');
    const drivers = await gdal.drivers();
    check(Boolean(drivers.raster.GTiff && drivers.vector.GeoJSON), 'real compiled driver discovery');
    const controller = new AbortController();
    await gdal.buildOverviews(file, { levels: [2] }, { signal: controller.signal,
      onProgress: (e) => { if (e.phase === 'executing') controller.abort(); } }).then(
      () => { throw new Error('Expected cancellation'); },
      (error) => check(error.name === 'AbortError', 'active cancellation is AbortError'));
    check(active === 0, 'cancelled Worker terminated');
    check((await gdal.getInfo(file)).width === 64, 'fresh Worker recovers after cancellation');
    const limited = new GdalService({ ...options, maxOutputBytes: 1 });
    try { await limited.buildOverviews(file, { levels: [2] }).then(
      () => { throw new Error('Expected output budget rejection'); },
      (error) => check(error.code === 'GDAL_OUTPUT_BUDGET', 'output allocation budget')); }
    finally { limited.dispose(); }
    const source = await openGeoTIFF(file, { overviewFile: pyramid.overviewFile,
      workerUrl: '/emap-assets/emap-geotiff-worker.js', workerCount: 1 });
    try {
      equal(source.metadata.levels.length, 4, 'emap reads original plus three GDAL pyramid levels');
      const level = source.metadata.levels[1];
      await source.readWindow({ level: level.id, window: [0, 0, 2, 2], samples: [0] });
      check(true, 'emap decodes generated overview pixels');
    } finally { source.dispose(); }
    const map = await Emap.create({ container: 'map', preset: 'viewer', plugins: [
      gdalPlugin(options), rasterPlugin(),
      geoTIFFPlugin({ workerUrl: '/emap-assets/emap-geotiff-worker.js', workerCount: 1 }),
      gdalGeoTIFFPlugin(),
    ] });
    try {
      check(Context.is(map.ctx), 'native Cordis identity across public package bundles');
      const result = await map.ctx.gdalRaster.addFile('gdal-fixture', file, { pyramid: { levels: [2, 4, 8] } });
      equal(result.metadata.levels.length, 4, 'one-call pyramid and emap layer registration');
      check(map.ctx.raster.getLayers().some((layer) => layer.id === 'gdal-fixture'), 'raster layer registered');
    } finally { await map.dispose(); }
    check(active === 0 && created === terminated, 'every owned GDAL Worker released');
    check(peak === 1, 'serial task execution limits simultaneous GDAL Workers');
    return { checks, count: checks.length, createdWorkers: created, terminatedWorkers: terminated,
      peakWorkers: peak, overviewBytes: pyramid.overviewFile.size, upstream: '2.8.2', emap: '0.14.2' };
  } finally { gdal.dispose(); }
}
