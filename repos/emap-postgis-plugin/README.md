# @mapseekai/emap-postgis-plugin

emap 原生 Cordis 插件：通过服务端连接 PostGIS，执行 SELECT，并将查询结果加载为点、线、面图层。
前端 `postgis` 服务、`postgisLayers` 图层服务与 Node 查询网关独立；数据库凭据不进入浏览器。
空间数据通过 WKB/EWKB 传输，转换成 emap 数据集；不经过 GeoJSON，不依赖 GDAL 插件。

转换复用公开的 `@mapseekai/emap/arrow.decodeWkb`，沿用 GeoParquet 的 `PathImporter → cleanPathsAfterImport → buildTopology`。
插件补充 EWKB SRID 校验、WKB 边界/顶点预算与 GeometryCollection 分组，几何坐标不序列化为 GeoJSON。

## 网页一键唤起本地连接器

新增独立 `./connector` 浏览器入口，可与 [postgis-connector 桌面应用](../../apps/postgis-connector/README.md)
配合完成网页唤起、原生授权与短期会话。用户安装一次后，无需终端、Node.js 或手工 Token。
参见 [本地连接器接入](docs/local-connector.md) 和 `examples/connector.html`。
原有远程网关入口保持不变；以下 `.env` 启动方式仍供开发者/服务端部署使用。
这些接口包含在 `@mapseekai/emap-postgis-plugin@0.4.1` 中。

## 本地启动

```sh
npm ci
npm run build
cp examples/.env.example .env
# 编辑 .env：专用只读数据库账号、随机应用令牌、允许的页面来源。
npm run start:server
# 在另一终端启动前端示例：
npm run dev
```

页面中输入的是应用 API 令牌，不是数据库密码。示例不保存令牌到 localStorage。
参数化 SELECT、地图接入、接口说明、Worker 配置和生产限制见
[连接与接入文档](docs/connection-and-integration.md)。

## 验证与发布边界

`npm run verify` 检查类型、单元/生命周期测试、构建、包入口与浏览器/服务端依赖隔离。
`npm run test:integration` 和 `npm run test:browser` 使用隔离的临时 PostGIS Docker 容器，需要 Docker。
`npm run verify:all` 运行全部验证。测试不连接业务数据库，临时容器由测试负责清理。

该插件与其他插件共用根 Git 仓库，但拥有独立 package-lock、npm 版本与发布生命周期。Cordis 固定为 `4.0.0-rc.10` peer，emap 为 `^0.14.2`。
当前 npm 包版本为 `0.4.1`；不要把服务端 `./server` 入口导入浏览器代码。
## API 与 SQL

`map.ctx.postgis` 提供 `connections()`、`testConnection()`、`tables()`、`query()`、`queryWkb()` 和 `queryDataset()`。
`query()` 返回属性行；`queryWkb()` 返回原始二进制信封；`queryDataset()` 返回 `{ dataset, srid, rowCount, hasMore, ... }`。
`map.ctx.postgisLayers.load()` 使用 `queryDataset()` 和公开的 `sourceFactory.fromDataset()` 创建点、线、面图层；`remove(sourceId)`、`list()` 管理本插件拥有的图层。
纯转换函数从 `@mapseekai/emap-postgis-plugin/dataset` 导出：`wkbToDataset(result, options)`。
它是同步底层 API；地图默认使用可取消的 Worker 转换，不应在主线程对大数据调用此函数。

```sql
-- 原生空间字段：只有一个时可自动识别
SELECT id, name, geom FROM public.roads ORDER BY id;
-- bytea EWKB：设置 geometryColumn: 'shape'
SELECT id, ST_AsEWKB(geom) AS shape FROM public.roads ORDER BY id;
-- bytea WKB：额外设置 sourceSrid 为真实来源 SRID，不可随意填写
SELECT id, ST_AsBinary(geom) AS shape FROM public.roads ORDER BY id;
-- 也支持 encode(ST_AsEWKB(geom), 'hex') AS shape
```

支持一个 SELECT，包含只读 WITH、JOIN、空间函数和 `$1` 参数。禁止多语句、DML、写入 CTE、SELECT INTO 和锁定查询。
输出列必须使用唯一别名；多个空间字段或 bytea/hex 文本字段必须指定 `geometryColumn`。
`sourceSrid` 仅用于没有 SRID 的输入，不覆盖已有 SRID；`targetSrid` 默认 4326，可按需设置。
输出 `format` 默认 `ewkb`，可选择 `wkb`；后者通过响应的 `srid` 字段传递坐标系。
服务端统一执行 Force2D / CurveToLine / Transform；不把未知 SRID 静默当作经纬度。

每页默认 1000 行，网关默认最大 10000 行、10 MiB 响应、15 秒查询超时。
通过 `limit`、`offset` 翻页，并检查 `hasMore`；分页查询应显式 ORDER BY 唯一键。
分页是在独立事务中查询，并非跨页一致快照；数据变动时建议使用主键游标条件。

## 几何与资源边界

支持点、线、面、Multi*；Polygon 孔洞按 WKB 环序处理，默认建立共享弧段拓扑。
GeometryCollection 按几何族拆层并保留属性，因此地图要素数可能大于查询行数。
NULL/EMPTY 保留属性，但全无可绘制几何的结果不自动上图。空间查询中的 int8/numeric 属性以字符串保留精度。
显示为二维：网关主动去除 Z/M；独立转换工具舍弃 Z，明确拒绝 M/ZM 和未线性化曲线。

Worker 默认最多并发 2 个，转换超时 30 秒、100 万顶点、10 MiB 几何输入预算；超额并发返回 BUSY，不无限排队。
这些预算不是 JavaScript 堆硬上限；主线程仍负责响应 JSON 解析、Dataset 恢复和宿主挂载。
`conversion` 可设置 `workerUrl`、`maxConcurrent`、`timeoutMs`、`maxVertices`、`maxGeometryBytes`、`noTopology`。
取消/卸载终止 Worker 和 HTTP 等待，阻止过期结果上图。图层读取是宿主快照，清理通过独有 source-layer 绑定识别归属，不依赖对象引用。
新增其他图层接管的数据源会保留；复制插件图层且沿用全部绑定的同 ID 图层仍被视为插件所有。
`worker:false` 为显式同步路径，不能硬取消正在执行的 JavaScript；Node 默认直接转换。
地图编辑不回写数据库，不支持 INSERT/UPDATE/DELETE、实时订阅或矢量瓦片。

## 部署与安全

本节描述原有远程网关；本地 Connector 另行提供按网页来源和单数据库连接授权，详见本地连接器文档。

浏览器必须通过网关，不能使用数据库连接串。数据库账号只能在服务端配置；应用 Token 不等于数据库密码。
只供受信任应用用户使用。AST 校验与 READ ONLY 事务不是任意 SQL 的完整沙箱，自定义函数仍可能有外部副作用。
数据库连接允许普通或管理员账号，不因角色的管理权限而拒绝连接；实际可访问的表和函数由数据库权限决定。
生产部署仍建议使用独立最小权限账号，仅授予必要 schema/table 的 USAGE/SELECT，审查并限制非必要函数执行权限。
管理员账号只应供受信用户使用；Token 授权访问所有配置连接，不提供逐用户、逐连接授权。
生产使用 HTTPS、精确 Origin 白名单及经验证的数据库 TLS，并在应用入口增加用户鉴权与限流。
服务端导出在 `./server`，不得导入浏览器入口。Cordis 保持 peer/external；Worker 构建产物没有 Cordis 依赖。

## 验证与发布

```sh
npm run verify       # 类型、单元/生命周期、构建、包边界
npm run verify:all   # 再执行真实数据库与浏览器检查，需要 Docker 和 Chromium
```

集成测试只创建隔离的临时容器，默认镜像 `imresamu/postgis:17-3.6-alpine3.22`；
可用 `POSTGIS_TEST_IMAGE` 指定兼容镜像，`CHROME_BIN` 指定浏览器。测试完成释放容器及监听端口。
运行记录见 [docs/verification.md](docs/verification.md)，部署样例见 `examples/`。
此版本的本地构建不代表已经 npm 发布或部署线上服务。

## 全量读取与授权时长

使用 `client.queryDatasetStream({ connectionId, sql })` 读取全部结果；可传 `maxRows` 限定条数（不限于 10000），并用第二个参数的 `onProgress({ rowsRead })` 显示进度。
数据由同一只读事务/游标分批传输，在 Worker 中增量构建一个 Dataset。完整结束标记缺失、取消、授权撤销或字节/内存预算超限都会报错，不将部分结果冒充完整表。
`queryDataset` / `queryWkb` 仍保留原有单页限制。全量读取没有总行数上限，但最终浏览器 Dataset 和工程文件仍受内存/存储预算约束。

`connector.connect({ sessionDurationMs })` 支持 1 分钟至 24 小时；默认 1 小时。Connector 0.2.0+ 在本机核对并执行该时长。旧连接器仅兼容默认 1 小时，非默认时长会提示更新。
较长期限不会自动扩大已记住的较短授权，必须重新确认。窗口关闭/项目切换可提前结束会话。

数据库连接现在允许普通或管理员账号；仍验证身份、表权限、TLS，并执行 SELECT-only AST 检查与只读事务。
管理员账号只应供受信用户和站点使用：只读事务/AST 检查不是防御任意用户函数、外部副作用的完整 SQL 沙箱。
