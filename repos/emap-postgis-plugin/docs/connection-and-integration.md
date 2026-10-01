# PostGIS 连接与 emap 接入

## 运行边界

插件前端通过 HTTP(S) 调用 Node 查询服务，由查询服务连接 PostgreSQL/PostGIS。
数据库主机、账号、密码和 TLS 参数只配置在服务器上，不传给浏览器。
当前空间传输为 WKB/EWKB，浏览器转换成 emap 数据集后通过公开服务加载。
地图数据是查询页的快照；本插件不将地图编辑写回数据库，不提供实时订阅或瓦片服务。

服务名为 `postgis`；加载图层需另装 `postgisLayerPlugin()`，服务名为 `postgisLayers`。
可选 `postgisControl()` 提供连接选择、测试连接、空间表、SELECT、属性预览和加载地图按钮。

## 启动查询服务

在本插件仓库运行：

```sh
npm ci
npm run build
cp examples/.env.example .env
# 编辑 .env 中的只读数据库连接、随机应用令牌和允许访问的页面来源。
npm run start:server
```

示例服务默认监听 `127.0.0.1:8787`，路径前缀 `/postgis`。
示例连接 ID 固定为 `main`。多连接应用可自行实例化 `PostgisGateway`，传入多个连接配置。
连接允许普通或管理员账号，不因管理员角色而拒绝连接；身份、表权限与查询只读限制仍适用。
生产部署建议使用专用的最小权限 SELECT-only 角色，并由数据库管理员限制可访问的 schema、表和函数。
管理员账号只应供受信用户使用，AST 校验与只读事务不是任意用户函数或外部副作用的完整沙箱。
`.env` 已被 Git 忽略；不要将数据库配置放进任何 `VITE_` 环境变量或静态网页。

## 接入已有 emap

以下函数由宿主调用，传入已就绪的 emap 实例及可信应用用户的 API 令牌。
本地开发先构建本插件，再从宿主项目执行 `npm install /绝对路径/emap-postgis-plugin`。
包尚未发布时，不应直接假定公共 npm 上已经存在此版本。

```ts
import type { Emap } from '@mapseekai/emap';
import { postgisPlugin } from '@mapseekai/emap-postgis-plugin';
import { postgisLayerPlugin } from '@mapseekai/emap-postgis-plugin/layers';
import { postgisControl } from '@mapseekai/emap-postgis-plugin/control';
import workerUrl from '@mapseekai/emap-postgis-plugin/worker?url';

export async function attachPostgis(map: Emap, token: string) {
  const provider = map.ctx.plugin(postgisPlugin({
    endpoint: 'http://127.0.0.1:8787/postgis', token, conversion: { workerUrl },
  }));
  await provider.await();
  const feature = map.ctx.plugin(postgisLayerPlugin());
  await feature.await();
  const control = postgisControl({
    postgis: map.ctx.postgis, layers: map.ctx.postgisLayers,
    sql: 'SELECT id, name, geom FROM public.roads ORDER BY id',
  });
  await map.addControl(control, 'top-right');
  return async () => {
    await map.removeControl(control); await feature.dispose(); await provider.dispose();
  };
}
```

## SELECT 结果上图

安装服务后执行：

```ts
const loaded = await map.ctx.postgisLayers.load({
  sourceId: 'postgis-roads',
  query: {
    connectionId: 'main',
    sql: 'SELECT id, name, geom FROM public.roads WHERE road_type = $1 ORDER BY id',
    parameters: ['主干路'],
    geometryColumn: 'geom', idColumn: 'id', limit: 1000, offset: 0,
  },
  fitBounds: true,
  paint: { line: { 'line-color': '#1677ff', 'line-width': 2 } },
});
console.log(loaded.layerIds, loaded.result.hasMore);
// 仅删除本插件拥有的图层；不会删除被其他业务接管的数据源。
map.ctx.postgisLayers.remove('postgis-roads');
```

`query()` 返回普通行和字段信息；`queryWkb()` 返回空间二进制查询结果；
`queryDataset()` 返回转换好的 emap 数据集。普通统计 SELECT 不要求包含几何字段。
空间上图 SELECT 必须返回几何字段；多个几何字段时明确指定输出列别名 `geometryColumn`。
JOIN 产生重复列名时用 AS 改为唯一名称，避免属性覆盖。分页需稳定且唯一的 ORDER BY。
每页默认 1000 条、默认服务上限 10000 条，返回 `hasMore`，不会无限取完整张表。
`sourceId` 必须唯一；刷新可先 remove 再 load，不会静默覆盖宿主已有图层。
所有查询和 load 可在第二参数传入 `{ signal }`；卸载插件会取消请求并清理其自有资源。

## 安全与部署

只允许单条 SELECT 或只读 WITH SELECT；拒绝多语句、写入 CTE、SELECT INTO 和行锁。
参数使用 `$1`、`$2` 绑定，不拼接用户输入。SQL 解析检查之外，每次执行还使用数据库只读事务。
查询默认 15 秒、结果 10 MiB、SQL 50000 字节，请求体 64 KiB；这些不是数据库执行内存的硬上限。
复杂聚合或单条巨型几何仍可能消耗较多资源，需在数据库侧配置资源治理并限制查询规模。
只读事务和函数黑名单并非任意 SQL 沙箱；自定义函数、外部连接等仍须由数据库权限限制。
Node 网关使用 PostgreSQL 18 的 `pgsql-parser`，原生 Connector 使用 PostgreSQL 17 的 `pg_query`。
共同测试语料见 [`test/fixtures/sql-policy.json`](../test/fixtures/sql-policy.json)：覆盖共同语法子集的允许/拒绝与错误码，并非全语法兼容承诺。
两边解析器可能在版本特有语法、AST 或反解析文本上不同；新增 SQL 行为应补充共享语料并运行双方单测与 Connector 的 `test:parity`，不能只验证一边。
当前应用令牌可访问服务端配置的所有连接，只适合可信用户；公共或多租户系统需接入自己的用户鉴权和连接级授权。
禁止把共享应用令牌硬编码进公开网站。浏览器 API 令牌与数据库密码是两种不同凭据。

生产环境使用 HTTPS 反向代理、精确 CORS 来源及数据库验证型 TLS，禁止关闭证书验证。
不要向互联网公开 PostgreSQL 端口；通常只需让 Node 查询服务访问数据库。
默认 Worker 做空间数据转换；部署时同时提供构建产物中的 `dataset-worker.js`，必要时指定 `conversion.workerUrl`。
卸载服务会销毁其请求；服务端每次查询结束销毁数据库会话，优先隔离状态而非复用连接。

## Worker 与示例页面

`npm run dev` 启动 `examples/index.html`。先按前文启动查询服务，再在页面填写应用令牌。
Vite 应用可将独立 Worker 作为静态资源导入，无需二次打包 Cordis：

```ts
import workerUrl from '@mapseekai/emap-postgis-plugin/worker?url';
// 在 postgisPlugin 的选项中传入：
// conversion: { workerUrl }
```

其他构建工具可把包的 `./worker` 导出复制为同源静态资源，并传入其 URL。Worker 不继承页面 import map；该独立产物没有外部模块导入。

## 验证

```sh
npm run verify
npm run test:integration
npm run test:browser
npm run verify:all
```

后两类测试会创建隔离的临时 PostGIS Docker 容器，不读取业务数据库连接配置；运行前需要 Docker。
容器只绑定本机随机端口，使用随机凭据和专用只读角色，测试结束后清理其自有容器。
可通过 `POSTGIS_TEST_IMAGE` 选择已准备的 PostGIS 测试镜像。
真实数据库报告位于 `test-results/integration/report.json`，浏览器报告及截图位于 `test-results/browser/`。
`verify` 还会检查公开包入口和前后端依赖边界；只有 `verify:all` 同时包含数据库与浏览器验证。
