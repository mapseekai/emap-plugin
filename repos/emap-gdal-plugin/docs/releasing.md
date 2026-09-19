# npm 发布与在线使用

## 使用方

```sh
npm install @mapseekai/emap-gdal-plugin@0.1.0
npx emap-gdal-copy-assets public/emap-gdal
```

宿主需有兼容的 `@mapseekai/emap` 和固定的 `cordis@4.0.0-rc.10`。
具体注册、金字塔生成、GeoTIFF Worker 复制见 [README](../README.md)。
分发方式是 npm 在线安装；JS/WASM/data 由宿主静态站点同源托管。
不需要克隆管理仓库，不要把第三方 CDN 的跨域地址直接交给 classic Worker。
应用部署在子路径时，`assetPath` 和 GeoTIFF `workerUrl` 要包含对应前缀。
npm 包发布不会自动部署业务应用或把用户影像上传到服务器。

## 维护者

发布需要本次明确授权及 npm 写权限；不提交 token，不修改账户安全配置。

```sh
npm whoami --registry=https://registry.npmjs.org
npm ci
npm run verify
npm pack --ignore-scripts
```

先用 `node test/browser/installed.mjs ./mapseekai-emap-gdal-plugin-0.1.0.tgz`
在临时宿主中验证安装包，再发布同一个已验证的归档。

```sh
npm publish ./mapseekai-emap-gdal-plugin-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org
npm view @mapseekai/emap-gdal-plugin@0.1.0 version dist.integrity --json --registry=https://registry.npmjs.org
node test/browser/installed.mjs @mapseekai/emap-gdal-plugin@0.1.0
```

`installed.mjs` 创建全新的临时宿主，从指定归档/registry 安装插件及基线 peer，
运行实际安装的资源复制 CLI，并用浏览器执行 GDAL/emap 集成测试。
报告写入 `test-results/installed/`；临时宿主在结束时清理。
测试工具从开发仓库加载，但待测插件、emap、Cordis 和静态资源只使用临时宿主的安装内容。
新版本发布前更新版本、依赖锁及文档中的示例版本，并重新验证。
同一包名/版本不可覆盖；失败后先查 registry 状态，避免把网络超时误判为发布失败。
需要 npm 2FA 时由维护者在自己的终端/浏览器完成，不把验证码或 token 写入仓库。
CLI 发布未自动产生 GitHub Actions provenance；不要将本地测试宣称为已部署 CI。
