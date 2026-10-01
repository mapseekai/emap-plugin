# emap-plugin

emap 外部插件的单仓库管理项目。插件源码统一提交到这个 GitHub 仓库，但每个插件作为独立 npm 包单独版本、验证和发布。

```text
emap-plugin/
  repositories.json             # 插件目录 / npm 包清单
  scripts/                      # 批量校验及新插件脚手架
  repos/
    emap-gdal-plugin/           # @mapseekai/emap-gdal-plugin
    emap-postgis-plugin/        # @mapseekai/emap-postgis-plugin
```

两个插件都由本仓库 Git 跟踪，不使用子仓库、submodule 或嵌套 `.git`。新增插件也直接进入 `repos/` 并随根仓库提交。

```sh
npm ci                          # 根管理工具依赖（必须先安装）
npm run management:test         # 仅根命令/脚手架测试，不安装或构建业务插件
npm run management:verify       # 根管理门禁（当前同 management:test）
npm run bootstrap               # 各插件 npm ci；首次无锁文件时 npm install
npm run build                   # 逐插件构建
npm run test                    # 根管理测试 + 逐插件测试
npm run verify                  # 根管理门禁 + 逐插件 verify（不包含 Connector）
npm run verify:all              # 根管理门禁 + 逐插件完整门禁 + Connector 完整门禁
npm run new:plugin -- terrain   # 在 repos/ 下创建一个新的独立 npm 包
```

## 验证范围与前置环境

使用 Node.js `>=22.18 <25` 和 npm；干净检出后先在根目录运行 `npm ci`。
根锁文件只安装脚手架验证需要的 TypeScript 和固定版本 Cordis。
脚手架测试在临时目录生成插件，使用根 `node_modules` 执行生成包的
`verify`，不借用 GDAL 或任何业务插件的依赖，也不需要宿主源码。
`management:verify` 覆盖根命令调度、路径边界和模板生成/类型检查/运行测试；
不运行 `test/review`，也不代替插件或应用门禁。

`verify` 保留登记插件各自 `verify` 的原有范围。
`verify:all` 对登记插件优先执行 `verify:all`，没有该入口则执行 `verify`，
然后执行 Connector 的 `verify:all`（包括集成、选项、原生一致性、浏览器、
UI 与 Tauri Rust 检查）。先运行 `npm run bootstrap`，并在
`apps/postgis-connector` 执行 `npm ci`；完整验证还需要 Rust/Cargo、
平台 Tauri 构建依赖、浏览器及各目标 README 指定的数据库/原生环境。
完整门禁不代表签名发布、安装器实机安装或全部操作系统验收已经完成。
具体依赖、环境变量与剩余发布验收见各插件和连接器 README。

Management CI 对根工具、清单、模板和规则变化运行 `npm ci` +
`management:verify`。昂贵的插件浏览器/原生构建及应用完整门禁由各自 CI
负责，不在管理 CI 重复执行。

## 独立发布

Git 仓库统一，但 npm 包仍单独发布。进入目标插件目录执行其自己的发布流程：
```sh
cd repos/emap-gdal-plugin
npm run verify
npm publish

cd ../emap-postgis-plugin
npm run verify:all
npm publish
```

是否实际发布由维护者决定；根仓库不会自动把所有插件一起发版。每个插件保留自己的 `package.json`、版本号、package-lock 和 `prepublishOnly`。

GDAL 使用方式、WASM 部署、金字塔 API、emap 接入见
[GDAL 插件 README](repos/emap-gdal-plugin/README.md)。
PostGIS 查询服务和地图接入见 [PostGIS 插件 README](repos/emap-postgis-plugin/README.md)。
新插件不会依赖 GDAL。只有确实重复的稳定协议才提取共享包，避免过早创造 SDK。

## 插件开发规范

开发前阅读本仓库的 [AGENTS.md](AGENTS.md) 与
[插件开发 skill](.agents/skills/emap-plugin-development/SKILL.md)。
格式、控件、能力与服务接入见 skill 的 [本地参考](.agents/skills/emap-plugin-development/references/patterns.md)。
这些规范在根仓库维护，不依赖宿主源码仓库中的文档或 skill 路径。

[新插件模板](templates/plugin/README.md) 会携带自己的 `AGENTS.md`。
插件运行时不依赖管理目录，但开发、提交与推送都以本 Git 根仓库为边界。
工作区文件包含管理项目、GDAL 和 PostGIS 插件，不要求存在同级宿主源码目录。

## 本地数据库连接器

`apps/postgis-connector/` 是独立的 Tauri 桌面应用，不通过 npm 发布，复用 PostGIS 插件的公开网关。
支持网页自定义协议唤起、本地授权、系统凭据存储及按站点/连接限制的短期会话。
Windows x64、macOS ARM64/Intel、Linux x64 的原生构建配置和验证边界见
[连接器 README](apps/postgis-connector/README.md)。

```sh
npm run connector:verify        # 需先安装/构建 PostGIS 插件及连接器依赖
npm run connector:dev
npm run connector:build
```

桌面应用不计入 `repositories.json` 的独立 npm 插件清单；根 `verify` 仍只验证登记插件。
连接器有单独的 `.github/workflows/connector-ci.yml`，CI 产物不等同于正式签名发布。
