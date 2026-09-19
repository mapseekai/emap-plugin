# 从网页接入 emap 本地连接器

本模块是当前源码新增接口；需要安装含 `./connector` 导出的构建版本，而不是假定旧 npm 版本已有此 API。
原有远程 HTTP 网关方式保持不变；`/connector` 只负责唤起、配对和会话，不将数据库驱动打进网页。

## 最小宿主接入

```ts
import { createConnector } from '@mapseekai/emap-postgis-plugin/connector';
import { postgisPlugin } from '@mapseekai/emap-postgis-plugin';
import { postgisLayerPlugin } from '@mapseekai/emap-postgis-plugin/layers';

// map 为已就绪的 emap。为每个页面/地图创建自己的连接器 handle。
const connector = createConnector({
  onState(state, pairingCode) {
    // 将 state 和 pairingCode 显示给用户，用于与本地窗口核对。
    console.log(state, pairingCode ?? '');
  },
});

let detach: (() => Promise<void>) | undefined;
connectButton.addEventListener('click', () => {
  // 不要在这之前 await；系统外部协议唤起需要保留真实的点击手势。
  connectButton.disabled = true;
  void connector.connect().then(async session => {
    const provider = map.ctx.plugin(postgisPlugin({
      endpoint: session.endpoint,
      token: () => session.token,
    }));
    let layers: ReturnType<typeof map.ctx.plugin> | undefined;
    try {
      await provider.await();
      layers = map.ctx.plugin(postgisLayerPlugin());
      await layers.await();
      console.log(await map.ctx.postgis.tables(session.connectionId));
      detach = async () => {
        await layers?.dispose();
        await provider.dispose();
        await session.close();
        connectButton.disabled = false;
      };
    } catch (error) {
      await layers?.dispose();
      await provider.dispose();
      await session.close();
      throw error;
    }
  }).catch(error => {
    connectButton.disabled = false;
    statusElement.textContent = error instanceof Error ? error.message : String(error);
  });
});

// 宿主卸载时先销毁图层/Provider，再释放连接器会话。
async function dispose() {
  await detach?.();
  await connector.dispose();
}
```

含取消操作、独立地图创建、SQL 控件、Worker 资源和迟到结果保护的可运行示例：
`examples/connector.html`、`examples/connector-main.ts`。运行插件 `npm run dev` 后访问 `/connector.html`。

已安装连接器的首次唤起、协议注册和各浏览器的授权提示，需要在真实安装环境验证。浏览器或系统可能分别询问“打开本地应用”和“允许访问本机网络”。
不存在以一次网页授权自动安装并执行 CLI 的零安装模式。

## 接口

`createConnector({ baseUrl?, timeoutMs?, fetch?, launch?, onState? })`
默认 `http://127.0.0.1:18787`，只允许数字回环地址，不扫描其他端口。

`connect({ signal?, preferredConnectionId? })` 必须从用户点击中直接调用。同一 handle 最多一个待配对请求。
`preferredConnectionId` 只是偏好，不绕过本地授权；首次未知连接仍由用户选择。
`launch` 是宿主可选的自定义 URI 打开方式，不是 Shell，也不能用它附带密码、SQL 或回调地址。

成功返回 `{ endpoint, connectionId, expiresAt, token, close }`。token 为短期应用会话，绝不是数据库密码；不得写入 localStorage、配置文件、URL 或日志。
`session.close()` 清除本地 token 并尽力通知服务；之后读取 token 会抛错。
`connector.dispose()` 取消配对，关闭该 handle 的所有会话；不能继续使用已销毁 handle。

状态：`starting`、`waiting-for-approval`、`connected`、`denied`、`cancelled`、`error`。
常见错误包括 `CONNECTOR_TIMEOUT`、`PROTOCOL_MISMATCH`、`PAIR_DENIED`、`UNAUTHORIZED`、`CONNECTION_DENIED`。
超时不等同于“未安装”：也可能是用户拒绝启动、本机网络权限被拒绝、站点 CSP 或端口冲突。

## 安全和兼容

仍然通过网关访问 PostGIS，只是网关由本地桌面应用管理。远程网页不接触数据库密码。
一个 token 绑定一个确切网页来源和一个数据库连接；授权/撤销在本地窗口完成。
源站必须信任自己的前端代码和第三方脚本，因为被授权的网页本身能读取查询结果。
CSP 要允许 `connect-src http://127.0.0.1:18787`；不要建议用户关闭浏览器安全检查。

本地连接器不会修改 emap 的 Dataset、WKB/EWKB 或 Cordis 契约，数据库权限和 SQL 安全仍遵循原网关文档。
更多平台/打包说明见 [连接器 README](../../../apps/emap-connector/README.md)。
