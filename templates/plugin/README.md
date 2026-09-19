# emap-__SLUG__-plugin

独立的 emap 原生 Cordis 插件。该模板仅提供 ready 服务，业务 API 尚待实现。

```sh
npm install
npm run verify
```

接入：`map.ctx.plugin(__SERVICE__Plugin())`，服务为 `map.ctx.__SERVICE__`。
Cordis 固定 4.0.0-rc.10，不打包到插件。资源释放必须通过 ctx.effect 绑定。
该仓库拥有独立 Git、锁文件与版本。不要提交 node_modules 或自行发布。
