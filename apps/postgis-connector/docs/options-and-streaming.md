# 连接与全量导入更新

本地 Connector 0.2.0；PostGIS 插件 0.3.0-dev.0（未发布）。

- 账号：移除管理角色拒绝，保留认证、权限、SELECT AST、只读事务和 TLS 验证。
- 时长：`sessionDurationMs` 为 60000–86400000，原生审批与到期检查执行真实值。旧持久化记录默认一小时，扩大时长需再授权。
- 全量：一个 REPEATABLE READ 只读事务内声明 NO SCROLL 游标；以 FETCH 分批读取，不用多次 OFFSET 查询。每次请求保持一个一致快照。
- 传输：NDJSON 的 meta / batch / end / error 消息。batch 带连续 offset；客户端只在 end 校验通过后提交 Dataset。默认 256 行/批，目标帧 512 KiB，硬帧限制沿用 10 MiB。
- 资源：有界 channel、Worker 增量导入、单次拓扑构建；每次 FETCH 的 statement timeout 及 60 秒空闲限制保留。断开/撤销通过 CancelRequest 取消数据库操作。
- 限制：浏览器最终需要容纳完整 Dataset；默认流式转换预算为 1000 万顶点、256 MiB 几何、512 MiB 流式源数据，Loom 单图层导出预算仍为 64 MiB。超限报错，不静默截断。

管理员账号不能被描述为安全沙箱。授权网站能读取该账号可访问的数据；自定义函数与外部副作用必须按可信站点模型处理。
测试只使用临时 Docker 数据库，没有修改用户业务数据库、保存的配置或钥匙串。
