# PostGIS 插件验证记录

日期：2026-09-18（Asia/Singapore）。本地开发验证，不代表 npm 发布或生产部署。

## 已执行并通过

最终执行 `npm run verify:all`，退出码 0。

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| Vitest 单元及生命周期 | 7 个文件、52 项通过 |
| ESM 与独立 Dataset Worker 构建 | 通过；Worker 无外部导入，不打包 Cordis |
| npm 包导出与浏览器/服务端依赖边界 | 通过，npm pack 仅 dry-run |
| 真实 PostGIS 集成 | 11 项检查通过，测试容器报告 PostGIS 3.6.1 |
| 真实 Chromium + emap 0.13.0 | 13 项累计检查通过，包括卸载/重启 |

数据库测试使用独立临时 Docker 容器与临时只读账号，不读取业务数据库连接配置。
验证 geometry、geography、bytea WKB/EWKB、hex 文本、参数化 SELECT、WITH、分页、CRS、Z/M 归二维、集合、空值和权限拒绝。
浏览器测试走真实数据库和 HTTP 网关，直接加载发布用 Worker；仅取消用例人为延迟 HTTP 执行，确保可重复触发卸载。
几何恢复、CRS 转换、点线面图层、SQL 控件均使用真实 emap；未以模拟 Dataset 代替端到端加载。

测试产物（不入包）：`test-results/integration/report.json`、`test-results/browser/report.json`、`test-results/browser/screenshot.png`。
回归测试覆盖 WKB 边界/顶点预算、大小端、SRID 冲突、孔洞、共享弧段、集合拆分、空几何、Worker 并发/取消，以及宿主图层快照下的所有权清理。

## 未涵盖及发布注意

未连接用户业务库，未做生产网络/真实数据规模的容量测试，也未验证数据库特有权限、RLS、自定义函数和所有自定义坐标系。
十六进制传输增加编码体积；当前不是 Arrow IPC 网络协议或矢量瓦片接口。没有进行相对于 GeoJSON 的性能基准测试。
服务端 SQL 应仅向受信任用户开放；只读事务不隔离可产生外部副作用的函数。

本次 `npm audit` 返回 9 个依赖包告警（4 moderate、5 high），结果保存在 `test-results/audit.json`。
涉及既有 emap/mapshaper 的归档/格式处理依赖，以及 Vitest 开发依赖；没有执行 `audit fix --force` 或擅自升级宿主/固定 Cordis 基线。
这意味着功能验证通过不等于安全审计通过。生产发布前需单独评估依赖升级及实际可达路径；本任务没有声称这些告警已修复。

对无关宿主工程没有写入；未进行 npm 发布、Git 推送、远端仓库创建或生产数据库变更。

浏览器补充验证画布实际存在非白色绘制像素，并在相机动画后截图，不仅检查图层注册。

Vite 示例生产构建通过；存在大于 500 kB 的 chunk 体积提示，未把它作为性能基准或已优化的证明。
