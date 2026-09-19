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
npm run bootstrap               # 各插件 npm ci；首次无锁文件时 npm install
npm run build                   # 逐插件构建
npm run test                    # 根脚手架测试 + 逐插件测试
npm run verify                  # 根脚手架测试 + 逐插件 verify
npm run new:plugin -- terrain   # 在 repos/ 下创建一个新的独立 npm 包
```

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

`apps/emap-connector/` 是独立的 Tauri 桌面应用，不通过 npm 发布，复用 PostGIS 插件的公开网关。
支持网页自定义协议唤起、本地授权、系统凭据存储及按站点/连接限制的短期会话。
Windows x64、macOS ARM64/Intel、Linux x64 的原生构建配置和验证边界见
[连接器 README](apps/emap-connector/README.md)。

```sh
npm run connector:verify        # 需先安装/构建 PostGIS 插件及连接器依赖
npm run connector:dev
npm run connector:build
```

桌面应用不计入 `repositories.json` 的独立 npm 插件清单；根 `verify` 仍只验证登记插件。
连接器有单独的 `.github/workflows/connector-ci.yml`，CI 产物不等同于正式签名发布。
