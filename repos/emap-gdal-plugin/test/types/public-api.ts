import type { Context } from 'cordis';
import { gdalPlugin, planOverviews } from '../../src/index.js';
import type { PyramidResult, GdalOutput } from '../../src/index.js';
import { gdalGeoTIFFPlugin } from '../../src/geotiff.js';
export async function contract(ctx: Context, file: File): Promise<void> {
  ctx.plugin(gdalPlugin({ assetPath: '/gdal/' }));
  ctx.plugin(gdalGeoTIFFPlugin());
  const pyramid: PyramidResult = await ctx.gdal.createPyramid(file, { levels: [2, 4] });
  const output: GdalOutput = await ctx.gdal.ogr2ogr([file], { args: ['-f', 'GeoJSON'] });
  const overview: File = pyramid.overviewFile;
  const nativeFile: File = output.primary;
  void overview; void nativeFile;
  planOverviews(1024, 768, { resampling: 'average' });
  // @ts-expect-error This fork cannot write internal overviews.
  await ctx.gdal.buildOverviews(file, { external: false });
  // @ts-expect-error Native pointers are not part of the public contract.
  await ctx.gdal.translate({ pointer: 123 });
  // @ts-expect-error Use the resampling union, not arbitrary spellings.
  await ctx.gdal.createPyramid(file, { resampling: 'invalid' });
}
