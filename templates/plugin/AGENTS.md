# emap 插件包开发约定

本插件位于根仓库的 `repos/<name>`。开发前先阅读
[根仓库约定](../../AGENTS.md) 与 [插件开发 skill](../../.agents/skills/emap-plugin-development/SKILL.md)。

- 本插件与其他插件共用一个 Git 仓库，但拥有独立 npm 包、package.json、lockfile、版本、验证与发布周期。
- 不在插件目录创建嵌套 `.git`；提交和推送统一从根仓库进行。
- npm 发布从本插件目录单独执行，未经授权不得发布。
- 仅通过 `@mapseekai/emap` 的公开导出接入，不导入宿主内部源码或其他插件的私有文件。
- Cordis 固定 `4.0.0-rc.10`，保持 peer / external，不创造替代 Context 或插件包装器。
- Provider 声明 `provide`、导出服务契约并增强 cordis Context；消费者显式声明 `inject`。
- 资源通过 `ctx.effect` 归属插件，取消与过期结果保护需显式实现。
- 重计算使用 Worker，按实现需要设置队列、超时与内存预算；不共享跨地图的可变原生状态。
- 单元测试与实现同名 colocate，跨模块/生命周期/浏览器/公开契约验证放 `test/`。
- 业务/API 变更运行 `npm run verify`；保留无关修改。

此模板的 ready 服务只是占位接口，不代表任何业务能力已经实现。
