# emap-plugin 开发约定

这是单 Git 仓库的多插件项目。插件源码统一位于 `repos/<name>` 并随本仓库提交和推送；
每个插件仍拥有独立的 npm package、package.json、lockfile、版本、测试和发布周期，不要求版本同步。

## 开发入口

开发插件时先阅读本仓库的 [插件开发 skill](.agents/skills/emap-plugin-development/SKILL.md)，
再阅读目标插件自己的 `AGENTS.md`、`README.md` 和 `package.json`。
该 skill 是本项目唯一维护入口；不要查找旧仓库副本或复制到每个插件中维护。
按任务读取 skill 的本地 references；仅修改文档或链接不需要加载无关的 GDAL 实现。
新增插件使用 `npm run new:plugin -- <slug>`，随后在对应插件目录安装依赖。

## Git、发布与验证

- 所有插件代码都由根仓库 `mapseekai/emap-plugin` 跟踪；`repos/<name>` 下不得再创建嵌套 `.git`。
- Git 提交和推送从根仓库统一进行；不要把插件改动遗漏在父仓库提交之外。
- npm 发布仍在目标插件目录独立执行；不得从根目录假装统一版本或统一发布。
- 各插件保留自己的 lockfile、`prepack` / `prepublishOnly` 和发布检查。
- 检查命令以各插件 `package.json` 为准；根仓库的 `npm run verify` 执行脚手架及所有登记插件验证。

## 边界

仅通过 `@mapseekai/emap` 的公开导出接入，禁止依赖宿主内部源码或本机绝对路径。
原生 Cordis 固定 `4.0.0-rc.10`，必须保持 external / peer dependency。
Provider 通过 `ctx.effect` 管理服务与资源，并声明 cordis Context 类型增强。
重计算优先使用浏览器 Worker；禁止在地图渲染线程运行 GDAL WASM。
单元测试与实现同名 colocate；跨模块、浏览器和包验证放 `test/`。
文档/skill 修改检查引用、命令和适用范围；模板修改还需运行 `node --test test/scaffold.test.mjs`。
保留无关的未提交修改，不因插件任务改动宿主工程、全局工具配置或依赖版本。
未经授权不得发布 npm、创建其他远端或推送到其他仓库。
