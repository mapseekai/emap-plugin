# emap-plugin 开发约定

这是多仓库管理仓库，不是共享版本的 npm workspace。
插件在 `repos/<name>` 下拥有独立 Git、package.json、lockfile、测试及发布周期。
`repos/` 被管理仓库忽略；涉及插件的变更必须在对应子仓库单独检查和提交。

## 开发入口

开发插件时先阅读本仓库的 [插件开发 skill](.agents/skills/emap-plugin-development/SKILL.md)，
再阅读目标插件自己的 `AGENTS.md`、`README.md` 和 `package.json`。
该 skill 是本项目唯一维护入口；不要查找旧仓库副本或复制到每个插件中维护。
按任务读取 skill 的本地 references；仅修改文档或链接不需要加载无关的 GDAL 实现。
新增插件使用 `npm run new:plugin -- <slug>`，随后在该仓库独立安装依赖。

## 边界与验证

仅通过 `@mapseekai/emap` 的公开导出接入，禁止依赖宿主内部源码或本机绝对路径。
原生 Cordis 固定 `4.0.0-rc.10`，必须保持 external / peer dependency。
Provider 通过 `ctx.effect` 管理服务与资源，并声明 cordis Context 类型增强。
重计算优先使用浏览器 Worker；禁止在地图渲染线程运行 GDAL WASM。
单元测试与实现同名 colocate；跨模块、浏览器和包验证放 `test/`。
检查命令以各仓库 `package.json` 为准；管理仓库的 `npm run verify` 执行脚手架及各插件验证。
文档/skill 修改检查引用、命令和适用范围；模板修改还需运行 `node --test test/scaffold.test.mjs`。
保留无关的未提交修改，不因插件任务改动宿主工程、全局工具配置或依赖版本。
不得擅自发布 npm、创建远端或推送代码。
