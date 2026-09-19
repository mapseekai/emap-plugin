# emap Connector

emap 的本地 PostGIS 连接器。地图和 SQL 编辑仍在网页中，桌面组件负责本机查询服务、站点授权、数据库凭据和进程生命周期。

**用户体验：安装一次 → 网页点击连接 → 必要的浏览器确认 → 本地选择数据库并授权 → 网页查询和上图。**
普通用户不需要安装 Node.js、运行 npm、编辑 `.env` 或复制 Token。

这是单仓库中的独立私有桌面应用，不是新的 Cordis 插件，也不通过 npm 发布。生产查询服务已改为 `native-service/` Rust 可执行文件，保持 PostGIS 插件的 HTTP/WKB 协议。
对照测试使用 `@mapseekai/emap-postgis-plugin/server` 的公开接口；不导入宿主或插件私有源码。

## 平台与分发

| 目标 | 安装产物 | CI 原生构建环境 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe`，当前用户安装 | Windows 2022 |
| macOS Apple Silicon | `.app` / `.dmg` | macOS 15 ARM64 |
| macOS Intel | `.app` / `.dmg` | macOS 15 Intel |
| Linux x64 | `.deb`，复用发行版系统 WebKit/GTK | Ubuntu 22.04 |

配置最低 macOS 12。Windows ARM64、Linux ARM64、所有 Linux 发行版/桌面环境及所有浏览器组合，不在本版已验证范围内。
Windows/Linux/Intel macOS 的安装、冷启动协议唤起和操作系统凭据存储，必须由相应平台 CI 和人工验收确认；**有构建配置不代表已经验证通过**。
本次实际验证记录见 [verification.md](docs/verification.md)。

新原生服务使用 `pg_query 6.2.0`（PostgreSQL 17.7 解析器），旧 npm 网关使用 PostgreSQL 18 解析器。常用 SELECT/WITH/空间函数已进行对照测试，但不能把有限样例等同于全部 PostgreSQL 18 新语法兼容。

默认 CI 只构建未签名测试产物并上传 Actions artifacts，不创建 Release，不发布 npm，不携带签名凭据。
正式分发前完成 Windows 签名、macOS Developer ID 签名/公证和安装验收。不能要求终端用户关闭系统安全保护。

## 使用流程

1. 用户安装与自己的系统和 CPU 架构对应的连接器。
2. 网页点击“打开连接器并连接”，使用 `emap-connect://start?request_id=...` 唤起已经安装的程序。
3. 本地窗口添加数据库，默认验证 TLS 证书；远程数据库不提供“忽略证书错误”选项。
4. 用户核对完整网页 Origin 和配对编号，选择一个数据库，允许本次访问，或记住此站点与数据库的授权关系。
5. 网页自动获得短期会话，沿原有 `WKB/EWKB → Dataset Worker → emap` 路径查询和上图。

没有数据库信息时仍需要首次填写；网页唤起不是自动发现企业数据库。
数据库必须可从用户电脑访问，内网场景可能需要 VPN。也可使用用户自行配置的本地数据库隧道。

关闭窗口后保留托盘；菜单可重新打开或退出。没有托盘支持时保留普通窗口行为。
退出程序会终止子进程和会话。不会默认设置开机启动，不修改防火墙，不向局域网监听。
当前未实现自动更新、自动安装、后台空闲退出或跨进程会话恢复。每次新网页配对会发送一次协议唤起；已运行时由单实例接管，不启动第二个服务。

## 本地凭据与授权

数据库配置在**连接器自己的本地 WebView**中填写，经 Tauri IPC 送到原生进程，绝不发送给远程 emap 网页。
远程网页只能使用授权后的连接 ID 和短期会话，不获得数据库密码。

- macOS：Keychain；Windows：Credential Manager；Linux：Secret Service。
- 选择记住密码时，由系统凭据存储保存；不降级为明文磁盘文件。
- 系统凭据存储不可用/锁定时，取消“记住密码”可仅在当前进程中使用；重启后重新输入。
- 非秘密连接元数据和记住的站点授权保存到 Tauri 当前用户配置目录的 `settings.json`。Unix 目录权限 0700、原子写入文件；不保存浏览器 Token。
- 修改/删除连接会撤销该连接原有授权。撤销站点授权会中止关联的在途查询。

本版只读边界沿用网关：接受任意可登录账号、执行只读事务、SQL AST 验证、结果和并发限制。
**这些约束不是任意 SQL 的完整沙箱**：数据库必须使用专门的最小权限账号，并限制函数、schema 和表权限。
授权网页能够获得查询结果，因此用户必须信任授权的网页；不抵御本机同用户权限的恶意软件。

## 开发

先构建公开依赖，再安装应用依赖：

```sh
# 仓库根目录
cd repos/emap-postgis-plugin
npm ci
npm run build
cd ../../apps/emap-connector
npm ci
npm run dev
```

开发者需要 Node 22.18+（本版锁定验证 22.23.1）、Rust 1.92 以及对应平台 Tauri 构建依赖；普通用户不需要这些工具。
应用级 `.npmrc` 使用 `legacy-peer-deps`，避免桌面应用安装浏览器插件的无关 peer/可选测试依赖；未修改全局 npm 配置。

网页演示：

```sh
# 在另外一个开发终端
cd repos/emap-postgis-plugin
npm run dev
# 打开 Vite 提供地址下的 /connector.html
```

macOS 的自定义协议冷启动需要已安装应用；仅运行 `tauri dev` 不等于操作系统已注册该协议。
开发和测试不得用网页接口自动批准请求，也不得增加生产可达的测试审批开关。

## 打包

在**目标系统原生环境**运行，原生服务与桌面外壳的 Rust target 必须一致：

```sh
# Windows x64
npm run build:native -- --bundles nsis
# macOS，分别在 ARM64 / Intel 上构建
npm run build:native -- --bundles app,dmg
# Linux x64
npm run build:native -- --bundles deb
```

打包钩子编译 Rust 原生查询服务并构建本地管理界面，再复制原生服务为带目标 triple 的 sidecar。
**安装包不含 Node/V8、npm 模块、SQL 解析器 WASM、类型声明或 source map；启动后也不下载 Node。**
`dist/service` 可脱离开发目录运行。开发时的 Node/npm 仅用于构建前端及执行测试。
第三方依赖许可与版本清单经过去重后保留，不能为了体积删除必需的许可证。

Linux 小包默认使用 `.deb` 并声明系统 WebKit/GTK 依赖，不再默认构建自带大量桌面库的 AppImage。
可另行执行 AppImage 打包，但不属于本次 <10 MB 分发目标；不能把它当作已达标小包。
Windows 继续使用系统 WebView2；未安装时安装器可能需要获取系统 WebView2，这不是下载本应用的查询后端。

产物位于 `src-tauri/target/release/bundle/`。`src-tauri/runtime`、`binaries`、`target` 是生成物，已忽略，不提交可执行运行时进 Git。
不要将不同 CPU 或系统的原生服务混装。所有安装产物上传前执行 `npm run package:size`，必须严格小于 10,000,000 字节。

## 测试

```sh
npm run verify                 # 类型、Rust 服务测试、旧 JS 参考测试、构建、隔离 CLI 运行
npm run test:integration        # 独立临时 PostGIS Docker
npm run test:parity             # 与旧网关对照，HTTP 安全、主动查询取消等
npm run test:browser            # Chrome + 真 CLI + 真数据库 + Worker + emap Canvas
npm run prepare:native
npm run check:rust              # 原生协议与配置持久化测试
```

测试只创建自身拥有的临时目录、进程和 Docker 数据库，结束后清理，不读取业务连接。
浏览器自动化以私有测试 IPC 代替“操作系统分发 URI”和“用户点击原生授权按钮”；HTTP、配对校验、SQL、几何转换和地图绘制都是真实链路。
它不声称覆盖签名安装、操作系统授权弹窗、Keychain 交互或所有浏览器的本地网络权限。

## 目录

```text
native-service/    Rust 原生查询、授权、Loopback HTTP、私有 stdio 管理协议
src/service/       旧版 JS 行为参考，仅开发回归测试，不进入安装包
src/ui/            本地设置、授权、撤销和托盘控制窗口
src-tauri/         Tauri、单实例、Deep Link、OS 凭据存储、打包配置
scripts/           原生服务构建、许可去重、sidecar 准备、体积检查
test/             隔离 CLI、数据库和真实浏览器检查
```

进一步说明：[协议与安全边界](docs/protocol.md) · [上线验收清单](docs/release-checklist.md) ·
[网页插件接入](../../repos/emap-postgis-plugin/docs/local-connector.md)。

## 0.2.0 本地更新

普通及管理员账号均可连接，不再强制专用只读账号。查询仍采用只读事务；请仅授权可信站点。
网页可请求 1 分钟至 24 小时会话，本机审批显示请求时长；旧授权默认保留 1 小时上限，延长需要重新批准。
`/postgis/wkb/stream` 以同一数据库快照的游标读取全部数据，分批传输且支持取消。无固定总行数上限；单行/帧、查询时间和浏览器内存预算仍有效。
新增 `npm run test:options` 验证管理员、15,001 条全量读取、一致快照、4 小时授权及取消。
