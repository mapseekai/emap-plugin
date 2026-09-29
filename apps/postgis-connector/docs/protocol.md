# 本地连接器协议 v1

## 信任边界

```text
emap 网页 --自定义 URI（仅随机请求 ID）--> 已安装的 Tauri 程序
    |                                           |
    | HTTP + CORS + 来源绑定授权                 | 私有 stdin/stdout IPC
    v                                           v
127.0.0.1:18787 ----------------------> Rust 原生查询服务 ---> 指定 PostGIS
```

原生 UI 是授权控制面；HTTP 只是配对和数据面。HTTP 上没有 save、initialize、approve、config、open、shell 等管理端点。
原生进程加载打包的本地资源，不给远程页面 Tauri 权限。shell sidecar 仅由 Rust 固定启动，不向本地 JS 开放 shell 权限。

## 配对状态机

1. 浏览器生成 32 字节随机 `requestId` 和 32 字节随机 `verifier`，均使用 base64url 无填充编码。
2. 在点击事件中、第一次 await 之前启动 `emap-connect://start?request_id=...`。URL 不接受密码、SQL、来源、回调地址、端口或任意命令。
3. Tauri 检查协议、主机、参数个数和 ID 格式，经私有 IPC 创建 2 分钟有效的启动票据。
4. 浏览器通过 `GET /connector/health` 识别应用名及协议版本。不枚举端口或扫描内网。
5. `POST /connector/pair` 发送 requestId、SHA-256(verifier) 的 challenge 和可选 preferredConnectionId。服务只接受有原生启动票据的请求；**来源取浏览器实际 Origin 头，不取 Deep Link 自报字段**。
6. 原生窗口展示确切 Origin、请求编号、可用连接。用户选择授权；已有唯一匹配的记住授权可以自动通过。多个授权未指定连接时仍要求选择。
7. 浏览器 `POST /connector/pair/status` 发送 requestId/verifier。配对证明匹配且已批准后发出随机会话 Token，配对记录立即消费；不能二次兑换。
8. 会话固定到该 Origin、该连接，最长 1 小时；Token 只留在浏览器内存。重启连接器不恢复 Token。

本地同用户恶意程序可伪造 HTTP 头/自定义协议，不在此浏览器安全边界的防护范围内。请求编号不是密码；challenge 也不是会话凭据。

## HTTP 接口

基础地址固定默认 `http://127.0.0.1:18787`，客户端 SDK 可显式配置别的本机端口，但桌面安装版监听 18787。
占用时明确报错，不任意选择隐藏端口。SDK 不把超时直接解释成“没有安装”。

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/connector/health` | 合法网页 Origin；仅返回应用名和协议版本 |
| POST | `/connector/pair` | 原生启动票据、确切 Origin、challenge |
| POST | `/connector/pair/status` | 确切 Origin 和 verifier，一次性兑换 |
| POST | `/connector/pair/cancel` | 同来源及配对证明 |
| POST | `/connector/session/close` | Bearer Token，与来源绑定 |
| GET | `/postgis/connections` | 仅返回当前 Token 获批的一个连接 |
| GET | `/postgis/tables?connectionId=...` | 同来源、同连接 |
| POST | `/postgis/test`、`/query`、`/wkb` | 同来源、同连接，沿用原有网关查询协议 |

只允许 HTTPS 的确切 Origin，开发时允许 HTTP loopback；拒绝 Origin 缺失、`null`、带路径/凭据的值及非回环 HTTP 站点。
Host 必须严格等于监听的 numeric loopback authority，防止浏览器 DNS rebinding；不允许 `0.0.0.0` 或外网监听。
CORS 对合法 Origin 回显只用于配对连通性，**不等于数据库授权**；所有查询仍需会话凭据。
兼容请求中的旧式 Private Network Access preflight，现代浏览器自己的本地网络权限不能由连接器绕过。
前端站点自己的 CSP 必须允许到本机服务的 connect-src；HTTPS 页面到本机 HTTP 的支持需要按目标浏览器验收。

## 预算与生命周期

- 启动票据 16、待处理配对 16、活动会话 64、记住授权 128；过期记录定时释放。
- 最多 16 个 HTTP 在途请求、每分钟 600 个应用请求；请求体 64 KiB，配对响应 64 KiB。
- 查询沿用网关的 10 MiB 响应上限、15 秒查询超时、10000 行上限、每数据库最多 4 个并行查询。
- 每个配置只创建一个 connectionId 的 Gateway 实例，查询不能通过 body 更改 host、password 或跨连接。
- 关闭网页调用 session.close/dispose；页面崩溃时不能保证发送关闭请求，剩余会话会在绝对 TTL 到期后失效。
- 网络在令牌兑换完成后断开时，客户端可能未取得令牌；孤立会话依靠 TTL 或本地撤销清理。
- 撤销不会抹除已经发送给网页的数据或已经加载的地图图层。撤销授权会 Abort 在途请求并阻止迟到结果返回；浏览器取消、插件卸载仍沿用原转换器/Worker 取消。
- 原生退出杀死 sidecar；父进程退出关闭 stdin 时 sidecar 清理监听及数据库会话，设置有界强制退出。

## 凭据与错误处理

本地管理 IPC 使用固定命令和有界 NDJSON，不把数据库错误、密码或完整 SQL 写入网页错误。
系统凭据存储失败不降级为文件明文，支持显式会话内密码；本地配置目录记录连接元数据而非密码。
配置损坏时拒绝加载、不悄悄覆盖旧文件。修改连接撤销旧权限；仍须使用数据库最小权限角色，不能将 SQL 验证当作完整沙箱。

## 实现参考

- Tauri Deep Link / Single Instance：https://v2.tauri.app/plugin/deep-linking/
- Tauri sidecar：https://v2.tauri.app/develop/sidecar/
- 系统凭据存储选择：https://docs.rs/keyring/3.6.3/keyring/
- Chrome 本地网络访问权限：https://developer.chrome.com/blog/local-network-access

## 原生小包实现

HTTP、配对和 stdio 协议版本保持 1，数据库服务由 Rust 实现。每个查询独占连接，不跨用户复用会话。
取消时发送 PostgreSQL CancelRequest 后关闭连接；取消报文受 1 秒超时约束，仍保留数据库侧 15 秒 statement_timeout 作为保护。网络中断时不能承诺取消报文一定送达。
空间属性先排除几何字段再 JSON 编码，避免曲线几何被隐式转为 GeoJSON。
