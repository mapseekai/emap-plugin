# 原生安装与上线验收

以下清单用于区分“代码/CI 配置具备”与“目标平台实际验收通过”。未勾选项不应对外宣称完成。

## 可追溯验收门禁

为每个支持的平台建立独立 JSON 报告：`windows-x64`、`macos-arm64`、`macos-x64`、`linux-x64`。
在对应版本的干净 Git checkout 中，对**最终签名/公证后的**安装包执行：

```sh
# 在 apps/postgis-connector/；报告使用 ignored test-results/ 或仓库外路径
npm run release:prepare -- macos-arm64 test-results/release-macos-arm64.json /path/to/final.dmg
# 按下表完成报告 checks，每项填写 status: "passed"、reviewer、evidence
npm run release:check -- test-results/release-macos-arm64.json /path/to/final.dmg
```

`release:prepare` 拒绝覆盖已有报告；重新构建、修改、签名或重新公证产物后应创建新报告并重新验收，
不能沿用旧哈希。报告包含包版本、源码 commit、干净工作树状态、安装包文件名/大小/SHA-256。
`release:check` 对照当前源码与实际文件，拒绝缺项、pending、缺少验收人/证据、脏工作树、
错误版本/commit、篡改或 >=10,000,000 字节的安装包。

| checks ID | 必需证据（针对报告中的具体版本/安装包） |
| --- | --- |
| `automated-suite` | 本版本完整自动验证的 CI run/日志，原生矩阵及数据库/浏览器检查均通过 |
| `install-uninstall` | 干净目标机器的安装、卸载和无 Node/Rust/npm 启动记录 |
| `cold-warm-start` | URI 冷启动、已运行单实例、多标签页记录 |
| `browser-permissions` | HTTPS/CSP 与目标浏览器矩阵；拒绝唤起/本地网络权限及组织策略提示 |
| `pairing` | 核对完整 Origin/配对编号、拒绝、记住授权、重新配对 |
| `revocation` | 修改/删除连接、撤销授权中止在途 SQL 和旧会话 |
| `process-cleanup` | 关闭窗口、托盘退出、强制结束后的进程/数据库活动检查 |
| `port-conflict` | 18787 被占用时明确失败，不连接不兼容服务 |
| `credential-store` | 本平台真实系统凭据保存/锁定/恢复；不可用时仅本次模式，不回退明文 |
| `tls-network` | 企业 CA、证书错误拒绝、VPN/内网及最小权限/函数权限检查 |
| `large-results` | 大结果/复杂 SQL、分页、取消、Worker 预算与峰值内存记录 |
| `geometry` | WKB/EWKB、SRID、拓扑和地图编辑不回写回归 |
| `licenses` | 第三方许可、源码义务、依赖清单审核记录 |
| `download` | 下载地址/系统架构展示及对应校验和；可在批准的 staging 环境核对 |
| Windows: `signature`, `webview2` | OS 签名验证日志/证书身份和 WebView2 首次初始化 |
| macOS: `signature`, `notarization` | 最终 app/sidecar 签名及 hardened runtime 验证；公证、staple/Gatekeeper 验证 |
| Linux: `package-integrity`, `gnome-kde` | 最终 deb 完整性/依赖核对及 GNOME/KDE 实机验收 |

证据应是可访问的 CI run、审查记录或归档日志链接/路径，包含环境、日期、结果。
不得填入 Token、数据库密码、签名私钥或证书秘密。checker 校验记录完整性和文件绑定，
**不会验证证据内容真伪，也不会自动检查数字签名或执行安装器**；仍需发布负责人审阅批准。
未签名 CI 报告所有项目均为 pending，不得复制勾选以宣称通过；发布前需保存最终报告及相应日志。
发布所有平台需要所有对应报告通过；此命令不创建 Release、不上传、不安装、不修改系统注册。

## 构建和签名

- [ ] Windows x64 的 NSIS 安装/卸载、当前用户权限、签名与 WebView2 初始化。
- [ ] macOS ARM64 的 Developer ID 签名、公证、下载后的首次安装及系统凭据授权。
- [ ] macOS Intel 的原生构建、签名、公证、首次安装。
- [ ] Linux x64 的 `.deb`（AppImage 不属于小包目标），至少一个 GNOME、一个 KDE 会话；无 Secret Service 时的显式仅本次密码模式。
- [ ] 第三方许可证、原生 PostgreSQL 解析器许可、源码义务及可追溯依赖清单审查。
- [ ] 正式版本号、安装包校验和、下载站点；网站按系统/架构展示对应安装包。

CI 配置只上传未签名产物，不配置开发者证书、不创建公开 Release。签名材料不得进代码仓库或普通测试日志。
macOS 签名后的 Rust 原生服务运行，需与 hardened runtime / entitlements 一并验收；本次未使用开发者证书验证该链路。

## 用户路径

- [ ] 新电脑无 Node/Rust/npm：安装后网页冷启动连接器。
- [ ] 连接器已运行：网页唤起复用单实例，多个标签页分别授权/关闭。
- [ ] 浏览器拒绝打开应用：网页超时和重试，不误报未安装。
- [ ] HTTPS 生产站点访问本机服务：Chrome、Edge、Firefox、Safari 的实际权限行为与站点 CSP。
- [ ] 拒绝本地网络授权、撤销浏览器权限、组织策略阻止时，给出可操作提示。
- [ ] 正确比对完整 Origin/配对编号，选定连接，拒绝、记住授权、重新配对。
- [ ] 改变连接指向、删除连接、撤销站点：旧会话失效，包括进行中的查询。
- [ ] 关闭窗口、托盘退出、强制关闭原生进程：不遗留数据库查询或不必要的子进程。
- [ ] 本机端口 18787 被占用，显示明确冲突，不连接不兼容服务。
- [ ] 系统 Keychain/Credential Manager/Secret Service 锁定和恢复，绝不回退明文。

## 数据与部署

- [ ] 企业 TLS/自签名 CA、VPN/内网可达性，以及独立最小权限角色。
- [ ] 确认 SQL 函数权限和只读策略，不把应用限制误认为完整 SQL 沙箱。
- [ ] 大结果、复杂空间函数、分页、浏览器取消和 Worker 预算。
- [ ] 回归当前 WKB/EWKB 与坐标系/拓扑路径，地图编辑不回写数据库。

本次自动测试执行范围见 verification.md。尤其要注意：测试里的私有 IPC 授权模拟不是安装器或操作系统弹窗的验收结果。
