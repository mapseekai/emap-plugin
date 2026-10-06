# @mapseekai/emap-gdal-plugin

为 emap 提供浏览器端 GDAL API 的原生 Cordis 插件。首版重点支持外部影像金字塔 `.ovr`。
固定使用 `@mapseekai/gdal3.js@2.8.2`、`cordis@4.0.0-rc.10`，已与 `@mapseekai/emap@0.14.2` 联调。

## 在线安装

在实际调用 `Emap.create()` 的宿主应用中安装，不需要克隆本管理仓库或本地 tgz：

```sh
npm install @mapseekai/emap-gdal-plugin@0.2.0
```

首次创建应用时，安装已验证的宿主依赖组合：

```sh
npm install @mapseekai/emap@0.14.2 cordis@4.0.0-rc.10 @mapseekai/emap-gdal-plugin@0.2.0
```

已有宿主请保持兼容的 emap/Cordis 版本，不因安装插件升级其他依赖。
GDAL 依赖由本包自动安装；宿主无需直接初始化 `@mapseekai/gdal3.js`。
这是 npm 包分发，不是托管 GDAL 计算服务；用户文件仍在浏览器 Worker 中处理。

## 本地开发

```sh
npm ci
npm run verify      # 类型 + 单元/生命周期测试 + 构建 + 真实浏览器 GDAL/emap 测试
npm run dev         # 打开终端给出的 Vite 地址，选择本地影像生成 .ovr
npm pack            # 仅生成本地安装包，不发布
```

项目的 `.npmrc` 使用 `legacy-peer-deps=true`，绕过 npm 10 的可选 Vitest peer 依赖解析崩溃。
实际 Cordis/emap 依赖均显式固定并通过跨包身份与生命周期测试，不使用全局 npm 配置。
浏览器测试优先使用 `CHROME_BIN` 或本机 Google Chrome；其他环境先运行 `npx playwright install chromium`。

## 宿主接入与资源部署

在线安装已包含构建产物，宿主不需要构建插件。安装后从宿主根目录运行：

```sh
npx emap-gdal-copy-assets public/emap-gdal
```

需要 emap 显示 GeoTIFF 时，再复制宿主版本对应的 Worker（跨平台 Node 命令）：

```sh
node --input-type=module -e "import { mkdirSync, copyFileSync } from 'node:fs'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); mkdirSync('public/emap-assets',{recursive:true}); copyFileSync(require.resolve('@mapseekai/emap/dist/emap-geotiff-worker.js'),'public/emap-assets/emap-geotiff-worker.js');"
```

命令复制 `gdal3.js`、`gdal3WebAssembly.wasm`、`gdal3WebAssembly.data` 和第三方许可证/源码出处。
三个计算资源必须来自同一版依赖；Worker 使用同源 URL，WASM 应返回 `application/wasm`。
静态资源目录必须由应用实际托管，不能返回 SPA 的 HTML fallback。存在 CSP 时允许同源 Worker 和对应的 WASM 执行策略。
默认资源地址相对发布后的 JS；Vite/Webpack 等重新打包时，建议显式配置 `assetPath`，不要依赖默认相对位置。

```ts
import { gdalPlugin } from '@mapseekai/emap-gdal-plugin';

// map 是通过 Emap.create() 创建的现有地图；也可放入其 plugins 数组。
const fiber = map.ctx.plugin(gdalPlugin({
  assetPath: '/emap-gdal/',
  maxPendingTasks: 8,
  maxOutputBytes: 256 * 1024 ** 2,
  timeoutMs: 300_000,
  environment: { GDAL_CACHEMAX: '64' },
}));
await fiber.await();

const controller = new AbortController();
const result = await map.ctx.gdal.buildOverviews(file, {
  levels: [2, 4, 8, 16],
  resampling: 'average',
  config: { COMPRESS_OVERVIEW: 'DEFLATE' },
}, { signal: controller.signal, onProgress: ({ phase }) => console.log(phase) });
// result.overviewFile 是 File，可保存或直接交给 emap；不会修改 file。
// map 已安装 geoTIFF/raster Provider 时：
await map.ctx.geoTIFF.addFile('imagery', file, { overviewFile: result.overviewFile });
// 不再需要时：await fiber.dispose();
```

`createPyramid` 是 `buildOverviews` 的别名。省略 `levels` 时按 2 的幂自动生成，直到最大尺寸不超过 `minSize`（默认 256）。
原图已经不大于 `minSize` 时返回 `GDAL_NO_OVERVIEWS_NEEDED`；显式指定层级可强制生成。
## 一步创建金字塔并加入 emap

```ts
import { Emap } from '@mapseekai/emap';
import { rasterPlugin, geoTIFFPlugin } from '@mapseekai/emap/geotiff';
import { gdalPlugin } from '@mapseekai/emap-gdal-plugin';
import { gdalGeoTIFFPlugin } from '@mapseekai/emap-gdal-plugin/geotiff';

const map = await Emap.create({
  container: 'map', preset: 'viewer',
  plugins: [
    gdalPlugin({ assetPath: '/emap-gdal/' }),
    rasterPlugin(),
    geoTIFFPlugin({ workerUrl: '/emap-assets/emap-geotiff-worker.js' }),
    gdalGeoTIFFPlugin(),
  ],
});
const { metadata, pyramid } = await map.ctx.gdalRaster.addFile('imagery', file, {
  pyramid: { resampling: 'average', levels: [2, 4, 8, 16] },
});
```

宿主还需单独部署匹配 emap 版本的 `emap-geotiff-worker.js`；GDAL 资源复制命令不会替宿主管理其他插件资源。
该可选 Feature 注入 `gdal`、`geoTIFF` 和 `raster`，仅通过公开服务挂载图层。
卸载时取消进行中的任务，并按 metadata 对象身份只清理自己创建的图层。
纯 GDAL 处理无需安装此 Feature，也无需创建地图；可直接 `new GdalService(options)`，使用结束后调用 `dispose()`。
## API 范围

| 服务方法 | 功能 |
| --- | --- |
| `buildOverviews` / `createPyramid` | 自动或指定层级的外置 TIFF `.ovr` 金字塔 |
| `gdaladdo` | 此 fork 提供的外置金字塔创建/重建参数接口 |
| `inspect` / `getInfo` | 数据集概要、原生 metadata、打开告警 |
| `gdalinfo` / `ogrinfo` | 栅格/矢量信息与 GDAL 查询参数 |
| `translate` / `gdal_translate` | 栅格格式转换、窗口裁剪、缩放、波段选择 |
| `warp` / `gdalwarp` | 栅格重投影与重采样 |
| `rasterize` / `gdal_rasterize` | 矢量栅格化 |
| `vectorTranslate` / `ogr2ogr` | 矢量格式转换、SQL/筛选、投影转换参数 |
| `transform` / `gdaltransform` | 坐标转换；通常使用 `[x, y]` 或 `[x, y, z]` |
| `locationInfo` / `gdal_location_info` | 此 fork 的 `[纬度, 经度]` 到像素行列，注意与 XY 顺序不同 |
| `drivers` | 查询该 WASM 实际编入的驱动，不假定包含桌面 GDAL 的全部驱动 |

转换方法签名统一为 `(input, { args?: string[], outputName?: string }, taskOptions?)`。
通用转换的 `outputName` 是不含扩展名的名称；金字塔选项则是 `.ovr` 文件名，默认 `<原图文件名>.ovr`。
原生命令别名仍使用本插件的 File 输入契约，不接受 GDAL Dataset 指针。

```ts
const clipped = await map.ctx.gdal.translate(file, {
  args: ['-of', 'GTiff', '-srcwin', '0', '0', '1024', '1024'], outputName: 'clip',
});
const projected = await map.ctx.gdal.warp(file, {
  args: ['-of', 'GTiff', '-t_srs', 'EPSG:3857'], outputName: 'projected',
});
```
## 输入、输出与任务语义

输入接受 `File`、`FileList`、`File[]`，或者 `{files, datasetIndex?, openOptions?, vfsHandlers?}`。
Shapefile 的 `.shp/.shx/.dbf/.prj`、原图与 `.ovr` 必须在同一个输入集合中传入；发现多个主数据集时要求明确 `datasetIndex`。
只提供本地归档 VFS（vsizip/vsigzip/vsitar）；不提供任意本机路径 API。
输出 `primary` 是主文件，`files` 包含完整伴随文件集合。输出归宿主所有，不自动写磁盘、上传或产生图层。

每个 Provider 实例串行执行任务，默认最多接受 8 个未完成任务。不同地图互不共享 GDAL 单例或文件系统。
每个任务都创建独立 classic Worker，成功、失败、取消、超时或插件卸载后终止 Worker，回收整个 WASM 实例。
这是有意选择的隔离优先方案：连续小操作会付出重复初始化开销，暂未实现跨任务复用或批处理 session。
取消返回 `AbortError`；执行超时返回 `GDAL_TIMEOUT`；队列满返回 `GDAL_QUEUE_FULL`。
`timeoutMs` 从出队开始计时，不包括排队。`onProgress` 只提供阶段，不伪造原生百分比。

默认 `maxOutputBytes=256 MiB` 在导出前检查文件总大小，避免继续把超大输出复制到主线程。
这不是 WASM 堆硬上限：GDAL 计算与输出仍占用浏览器内存，超大影像应结合机器预算实测，不能据此承诺无限文件尺寸。
上游使用 WORKERFS 引用输入 File；插件不主动将整个原图读取到主线程数组。

## 首版边界

当前是栅格 overview 金字塔，不是 XYZ/TMS 瓦片服务，也不提供 gdal2tiles、gdal_calc、矢量金字塔或修改原 TIFF 的内部金字塔 API。
仅封装该 npm fork 实际存在的 GDAL 应用；格式与参数能力以 `drivers()` 和真实返回为准。
VRT 转换输出被明确拒绝，因为独立返回的 VRT 会引用任务结束后消失的临时文件系统。
没有自动注册为 AI capability；宿主可在其授权策略下调用服务，避免把任意 GDAL 参数直接开放给不可信 agent。
已验证的浏览器与测试结果见 [验证记录](docs/verification.md)。尚未对 GB 级生产影像及 Safari/Firefox 做专项验证。
第三方许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。该文件记录依赖版本、npm 归档、公开 fork 的对应提交及原生构建源码入口。

维护者发布流程见 [发布指南](docs/releasing.md)。
