# Third-party notices

This plugin is MPL-2.0. That license does not relicense third-party components.
The runtime dependency `@mapseekai/gdal3.js@2.8.2` declares LGPL-2.1-or-later.
Its JavaScript, WebAssembly and data assets are distributed without modification.

## Exact dependency and source

- npm archive: https://registry.npmjs.org/@mapseekai/gdal3.js/-/gdal3.js-2.8.2.tgz
- npm integrity: `sha512-0UbPx99nlTZtUR9NEE+029UT8BuBeGtmi7j2KVWuQ6+3C11Xq5qAqD3ikQclwMupqWGTxdqqW2OsFlgSflaqJg==`
- Public fork: https://github.com/zwishing/gdal3.js
- Corresponding npm `gitHead`: `363d0712b6536a14ea6592cd47dc0d6124249cfd`
- Pinned source tree: https://github.com/zwishing/gdal3.js/tree/363d0712b6536a14ea6592cd47dc0d6124249cfd
- Native versions, source download URLs, build instructions and patches: the `Makefile` and `GDAL_EMCC_FLAGS.mk` in that source tree.
- The npm dependency also contains JavaScript source under `src/`.

The dependency's npm repository field points to bugra9/gdal3.js (the original upstream).
The pinned zwishing fork above is the source containing this release's overview additions.

## Notices and replacement

`third-party/` contains verbatim license/notice texts for the native source versions
listed in the pinned Makefile: GDAL, PROJ, GEOS, SQLite, SpatiaLite, libtiff,
libgeotiff, libjpeg-turbo, zlib, Zstandard, LERC, WebP, Expat and libiconv.
The gdal3.js license is deployed as `GDAL3-LICENSE.txt`; the asset-copy command also
copies this notice and the `third-party/` directory alongside the computation assets.
Retain applicable copyright and license notices when redistributing these files.
The plugin loads separate replaceable assets; `workerUrl`, `wasmUrl` and `dataUrl`
can point to a compatible replacement built from the dependency source.
