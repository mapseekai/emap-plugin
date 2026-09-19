# 本机 Connector 客户端接入

`0.1.1-connector.0` 是本地联调预发布版，未发布 npm。
`./connector-client` 在已有 `./connector` 配对协议之上管理查询客户端与 Worker；未改变原生服务或授权协议。

```ts
import { createPostgisConnector } from '@mapseekai/emap-postgis-plugin/connector-client';

const connector = createPostgisConnector({
  conversion: { worker: true, workerUrl: '/resources/postgis-dataset-worker.js' },
  onState: (state, pairingCode) => { /* 更新状态，不持久化会话 */ },
});
// 必须从用户点击中直接调用，在调用前不要 await、动态 import 或检测服务。
const connection = await connector.connect({ signal });
await connection.client.testConnection(connection.connectionId, { signal });
const tables = await connection.client.tables(connection.connectionId, { signal });
// 查询结果继续使用 client.queryDataset()，由宿主负责挂载地图。
await connection.close();
await connector.dispose();
```

`connection` 只暴露 endpoint、connectionId、expiresAt、client 和 close，不向 UI 暴露 Token。
Token 仅用于请求头，不能写入工程文件、浏览器存储或日志。过期后查询返回 SESSION_EXPIRED。
`client.dispose()` 同时释放 Worker 和原生会话；取消配对、关闭页面、切换工程和卸载插件时调用 connector.dispose()。
UI 必须检查异步结果归属，拒绝过期结果上图。关闭会话不等于撤销连接器中记住的站点授权。

浏览器可分别询问打开外部应用和本机网络访问权限。使用 HTTPS 或 localhost；失败不代表一定未安装。
默认 baseUrl 为 http://127.0.0.1:18787；无需用户输入地址或 Token。每次点击仍发送协议唤起，已运行实例接管。
原有 HTTP 网关和 `createPostgisClient()` 保持兼容，可作为高级模式提供。
