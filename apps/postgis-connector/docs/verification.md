> 本页第一版记录使用 Node 后端，属于历史验证。当前原生小包结果及准确测试边界见 [size-optimization.md](size-optimization.md)。

# 本地连接器验证记录

记录时间：2026-09-19T15:34:54+08:00。
本次环境：用户授权的 macOS ARM64，Node 22.23.1、Rust 1.92.0。
变更基于 emap-plugin 的 d9fc11b 工作树；本次没有提交、推送、发布 npm 或创建公开 Release。

## 已执行并通过

| 检查 | 结果 |
| --- | --- |
| 根脚手架回归 | 1 项通过 |
| PostGIS 插件 npm run verify | 62 项测试，类型、Worker 构建和前后端包隔离通过 |
| Connector npm run verify | 33 项单元/HTTP 安全测试，类型和构建通过 |
| 隔离 CLI 运行 | 将服务及其资源复制到独立临时目录，健康检查/启动票据/配对/拒绝均通过 |
| Rust 原生测试 | 5 项通过：URI 校验、元数据无密码、损坏配置保留、记住授权及撤销、无系统凭据存储的会话模式 |
| 临时 PostGIS 集成 | 7 项检查通过，真实 SQL 解析 WASM、数据库、EWKB 和 Dataset |
| Chrome 实际地图 | 真实浏览器配对、HTTP、临时 CLI、临时 PostGIS、Dataset Worker、emap Canvas 通过 |
| 网页示例 | Vite 双入口生产构建通过，包含 connector.html |
| macOS ARM64 打包 | release .app 和 .dmg 构建通过，自定义协议写入 Info.plist |
| 随包 Node 运行时 | 使用 .app 内的 Node 与 runtime 资源，隔离 CLI 检查通过 |
| DMG 完整性 | hdiutil verify 通过 |
| 工作树格式 | git diff --check 通过 |

Chrome 检查观察到 3 个实际图层：circle、line、fill；源数据投影到 EPSG:3857。
Canvas 检测到 459901 个非空白像素。Token 未写入 localStorage/sessionStorage。
撤销后查询返回 UNAUTHORIZED，客户端/进程/临时数据库均在测试结束后清理。

**浏览器测试边界：仅“操作系统 URI 分发”和“本地批准按钮”由私有测试 IPC 代替。**
这不是安装器、Tauri 原生 UI、操作系统授权弹窗或系统钥匙串读写的全链路自动验收。

## 当前安装产物

相对本应用目录：

```text
src-tauri/target/release/bundle/macos/emap Connector.app
src-tauri/target/release/bundle/dmg/emap Connector_0.1.0_aarch64.dmg
```

DMG 大小：41640278 字节（39.71 MiB）。
SHA-256：`0625b6bc1898ad893af6ca4e8712270bb93695ce48dbdd9185c46fef167f1e84`。
这是本机构建的开发测试产物，未执行 Developer ID 签名/公证，不代表正式签名发布。

## 尚未验证 / 未执行

- Windows x64、Linux x64、macOS Intel 的新 CI 工作流尚未运行；只已配置原生构建矩阵和对应系统实现。
- 没有实际安装应用、修改本机协议关联、启用开机启动、操作用户的真实系统凭据或连接业务数据库。
- 各操作系统的冷启动/热启动 URI、安装卸载、托盘、Keychain/Credential Manager/Secret Service 需要对应实机验收。
- HTTPS 公共站点及 Chrome/Edge/Firefox/Safari 的本地网络权限组合尚未全面验证。本轮 Chrome 测试源站为 loopback 开发站点。
- 未发布新 npm 包、未发布安装包下载地址、未配置自动更新和正式签名。

CI 文件：`../../.github/workflows/connector-ci.yml`。
上线前逐项完成 [release-checklist.md](release-checklist.md)，不能把本记录扩展为所有平台已验证。
