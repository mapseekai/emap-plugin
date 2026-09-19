# emap-plugin

emap 外部插件的多仓库开发入口。首个插件是 `@mapseekai/emap-gdal-plugin`。

```text
emap-plugin/                    # 管理仓库（独立 Git）
  repositories.json             # 仓库清单；remote=null 表示尚未配置远端
  scripts/                      # 批量校验及新插件脚手架
  repos/
    emap-gdal-plugin/            # GDAL / 栅格金字塔
    emap-postgis-plugin/         # PostGIS SELECT 查询及矢量图层（独立仓库）
```

`repos/*` 不提交到管理仓库。每个插件需单独提交/推送；管理仓库不假装保存子仓库源码。
目前只创建本地 Git 仓库，没有创建远端、提交或发布。配置远端后分别 clone 到清单指定路径。
可以在将来有确定远端时改为 Git submodule；当前不创建无效的 `.gitmodules`。

```sh
npm run bootstrap     # 各仓库 npm ci；首次无锁文件时 npm install
npm run verify        # 各仓库类型、单元测试、构建和浏览器验证
npm run new:plugin -- terrain
```

GDAL 使用方式、WASM 部署、金字塔 API、emap 接入见
[GDAL 插件 README](repos/emap-gdal-plugin/README.md)。
PostGIS 查询服务和地图接入见 [PostGIS 插件 README](repos/emap-postgis-plugin/README.md)。
新插件不会依赖 GDAL。只有确实重复的稳定协议才提取共享包，避免过早创造 SDK。

## 插件开发规范

开发前阅读本仓库的 [AGENTS.md](AGENTS.md) 与
[插件开发 skill](.agents/skills/emap-plugin-development/SKILL.md)。
格式、控件、能力与服务接入见 skill 的 [本地参考](.agents/skills/emap-plugin-development/references/patterns.md)。
这些规范在管理仓库维护，不再依赖宿主源码仓库中的文档或 skill 路径。

[新插件模板](templates/plugin/README.md) 会携带自己的 `AGENTS.md`。
在 `repos/<name>` 布局内使用管理仓库的统一规范；插件单独克隆后，若管理仓库不在相对位置，
按该插件自己的 `AGENTS.md`、`README.md` 和 `package.json` 开发，不把管理目录当作运行时依赖。
修改统一规范只需更新此处的 skill，不在多个仓库维护重复副本。
工作区文件包含本项目、GDAL 和 PostGIS 插件，不要求存在同级宿主源码目录。
