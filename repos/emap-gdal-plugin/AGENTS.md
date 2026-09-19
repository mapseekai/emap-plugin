# emap-gdal-plugin

## 开发入口

在管理仓库的 `repos/emap-gdal-plugin` 布局中，遵循
[管理约定](../../AGENTS.md) 和本项目的 [插件开发 skill](../../.agents/skills/emap-plugin-development/SKILL.md)。
上述链接按本文件位置解析，不按 shell 当前目录解析。
本插件与其他插件共用根 Git 仓库，但独立版本和 npm 发布；不要在插件目录创建嵌套 `.git`。
不要退回查找宿主源码仓库里的 skill，不将管理目录作为构建或运行时依赖。

## 插件约束

本插件使用 npm 和原生 Cordis Provider，不包装或替代 emap Runtime。
仅使用 emap 公开包导出；Cordis 固定 `4.0.0-rc.10`，保持 peer / external。
GDAL Worker 协议与 `@mapseekai/gdal3.js@2.8.2` 绑定，升级必须重新检查协议及浏览器回归。
资源通过 `ctx.effect` 归属插件；不暴露 WASM 指针，不共享上游全局单例。
每个任务结束、取消、超时或插件卸载均终止其独立 Worker。
重计算只在 Worker，纯数据验证与队列在主线程。输出是宿主持有的 File，不自动持久化。
不得声称支持库中不存在的 gdal_calc、gdal2tiles 或原地内部金字塔写入。
实现/API/资源变更运行 `npm run verify`（包含真实浏览器 WASM 测试），并如实报告未执行的检查。
仅文档或 skill 引用变更检查链接、命令和契约，不必因此重跑完整 WASM 套件。
保留无关修改；未经授权不得发布、推送、创建远端或改动宿主源码。
