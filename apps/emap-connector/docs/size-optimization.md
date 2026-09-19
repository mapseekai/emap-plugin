# 安装包体积优化记录（2026-09-19）

目标：每个安装包严格小于 10,000,000 字节（十进制 10 MB）。
**macOS ARM64 最终原生小包已经达标；其他平台有构建配置，但本轮没有实际运行其安装包构建和验收。**

## 最终实测

| 项目 | 字节数 | 十进制 MB |
| --- | ---: | ---: |
| 原始 Node 版 DMG | 41,640,278 | 41.64 |
| 上一轮裁符号 DMG | 36,383,661 | 36.38 |
| 本轮原生版 DMG | 3,401,950 | 3.40 |
| 解包后应用文件大小合计（非文件系统占用） | 8,776,164 | 8.78 |
| Tauri 原生外壳 | 4,559,072 | 4.56 |
| Rust PostGIS 查询服务 | 3,903,920 | 3.90 |

相对最初 DMG 减少 91.83%。
SHA-256：`caa986ba5f60c6cf8e4bbee8bd316a1218de4045216953fa30e033fc67b19e44`。
最终 DMG 已通过 `hdiutil verify`；仍是未进行 Developer ID 签名/公证的开发测试包。

## 分析和实际删减

上一轮原生外壳已经降到 4.56 MB，继续清理图标、页面或文档没有足够收益。主要负担是 91 MB 的通用 Node 二进制。
本轮将本机 HTTP、授权状态、PostgreSQL 驱动与 WKB 查询实现为精简 Rust 服务，完全移除安装包中的 Node/V8 运行时。
保留 Tauri 外壳和既有网页配对协议，无需重做地图界面。

- 不再随包复制 Node、npm 模块、libpg-query WASM、类型声明、source map 和旧 JS 服务脚本。
- SQL 解析保留，改为静态链接的 PostgreSQL 原生解析器，不是改用正则或取消校验。
- 必需的第三方许可证去重后保留；运行时资源只含许可和版本/构建信息。
- 旧 JS 实现仅在源码中作为回归参考，不进入安装包；原 PostGIS npm 包的远程 Node 网关不受影响。
- 没有首次启动下载 Node、依赖用户安装 Node 或把查询后端转移到云端。
- 增加 `package:payload` 检查，防止 Node/npm/WASM 等重新混入生产包；`package:size` 继续强制 <10 MB。

## 功能及协议

网页自定义协议、单实例、原生授权窗口、OS 凭据存储、Origin/连接范围、短期 Token、撤销和 WKB/EWKB → Dataset → emap 保留。
查询服务每次请求使用独立只读事务和连接；撤销或浏览器断开时发送 PostgreSQL CancelRequest，并关闭连接。
网络错误可能阻止取消报文送达，因此仍保留 15 秒数据库 statement_timeout。

同时修正曲线属性打包：先排除空间字段再编码属性 JSON，避免原 `to_jsonb(q)-keys` 先将曲线隐式转成 GeoJSON 后失败。

原生服务使用 `pg_query 6.2.0` 的 PostgreSQL 17.7 语法解析器；原 npm 网关使用 PostgreSQL 18 解析器。
已通过下列契约样例，不声称所有 PostgreSQL 18 新语法完全兼容。
普通 `/query` 的非空间复杂类型使用 PostgreSQL JSON 表达；例如 bytea 为十六进制文本、日期使用服务器 JSON 时间表示，不能假定与 Node Buffer/Date 的对象序列化完全相同。
空间加载的 `/wkb` 响应仍按原协议工作，并经过逐值对照。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| 原生服务 Rust 测试 | 10 项通过 |
| Tauri 配置/凭据/协议 Rust 测试 | 5 项通过 |
| 旧 JS 参考回归 | 33 项通过；不是把它们算作新 Rust 实现测试 |
| 独立临时目录执行原生 CLI | 通过，无 Node、npm 或开发依赖目录 |
| 真实临时 PostGIS 集成 | 7 项通过 |
| 后端对照与安全专项 | 10 组检查通过，含 13 组 WKB/EWKB 逐值一致、5 组参数化 SELECT、8 组不安全 SQL 拒绝及取消/来源/权限验证 |
| Chrome + 实际 emap | 通过，点线面 3 图层、Worker、3857 投影，撤销后拒绝访问 |
| 最终 `.app` 内的服务复测 | CLI、数据库、后端对照、Chrome 全部通过，二进制 SHA 与构建产物一致 |
| 最终 DMG | 完整性和 <10 MB 体积检查通过 |

测试使用独立临时数据库，不连接业务数据库。原生点击授权、OS 协议分发仍由测试 IPC 代替；未自动安装或注册应用。
系统凭据存储 UI、公开 HTTPS 网站访问回环网络的权限弹窗、签名/公证和所有平台安装体验仍需各平台验收。

## 跨平台分发

- macOS：本轮实际完成 ARM64 `.app` / `.dmg`；Intel 保留原生 CI。
- Windows：NSIS 当前用户安装，保留原生 CI，并增加原生 PostgreSQL 解析器的 libclang 构建前提；本轮未实跑。
- Linux：小包默认 `.deb`，声明发行版 WebKit/GTK 依赖；本轮未实跑。
- AppImage 不再作为小包默认目标，因为它会打包桌面运行库。可单独构建，但不得宣称其已满足 10 MB。
- Windows 未具备 WebView2 时可能需要获取系统 WebView2；Linux 可能需由包管理器安装系统图形依赖。它们不是本应用的 Node/查询后端。

所有平台 CI 上传前保留严格体积门禁。有配置不等于三平台安装包已经验证达标。

## 文件与命令

产物：`src-tauri/target/release/bundle/dmg/emap Connector_0.1.0_aarch64.dmg`。

```sh
npm run verify
npm run test:integration
npm run test:parity
npm run test:browser
npm run prepare:native
npm run check:rust
npm run build:native -- --ci
npm run package:payload
npm run package:size
```

机器可读记录：`test-results/size-optimization-native.json`；契约对照：`test-results/native-parity.json`。
本轮未提交、推送、发布 npm 或创建公开 Release。
