# emap-__SLUG__-plugin

emap 原生 Cordis 插件包。源码位于 `emap-plugin` 单 Git 仓库中，但本包独立版本、验证和 npm 发布。

```sh
npm install
npm run verify
```

接入：`map.ctx.plugin(__SERVICE__Plugin())`，服务为 `map.ctx.__SERVICE__`。
Cordis 固定 4.0.0-rc.10，不打包到插件。资源释放必须通过 ctx.effect 绑定。
不要在插件目录创建独立 Git 仓库；提交从项目根目录统一完成，npm 发布仍从本插件目录单独执行。
