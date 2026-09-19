# 独立 emap 插件开发约定

在管理仓库的 `repos/<name>` 布局中，先阅读
[管理约定](../../AGENTS.md) 与 [插件开发 skill](../../.agents/skills/emap-plugin-development/SKILL.md)。
链接按本文件所在目录解析；模板目录和默认生成目录使用相同的相对层级。
独立克隆后若管理目录不存在，以本文件、[README.md](README.md) 和 [package.json](package.json) 为准。
不要查找宿主源码仓库中的旧 skill，不复制一份统一 skill 在此单独维护。

- 这是独立 Git 与 npm 包；使用本仓库的 lockfile、版本和验证脚本。
- 仅通过 `@mapseekai/emap` 的公开导出接入，不导入宿主内部源码或其他插件的私有文件。
- Cordis 固定 `4.0.0-rc.10`，保持 peer / external，不创造替代 Context 或插件包装器。
- Provider 声明 `provide`、导出服务契约并增强 cordis Context；消费者显式声明 `inject`。
- 资源通过 `ctx.effect` 归属插件，先登记资源释放，再提供服务；取消与过期结果保护需显式实现。
- 重计算使用 Worker，按实现需要设置队列、超时与内存预算；不共享跨地图的可变原生状态。
- 单元测试与实现同名 colocate，跨模块/生命周期/浏览器/公开契约验证放 `test/`。
- 业务/API 变更运行 `npm run verify`；按实际能力补充浏览器和包验证，不虚报模板尚不存在的检查。
- 仅文档变更检查引用、命令和契约；保留无关修改，未经授权不发布、推送或创建远端。

此模板的 ready 服务只是占位接口，不代表任何业务能力已经实现。
