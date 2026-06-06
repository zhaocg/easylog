# EasyLog

EasyLog 是一个轻量、可自托管的游戏日志采集与查看后台。它适合 Unity 等游戏客户端把运行日志、错误、堆栈、玩家信息、版本信息等统一通过 HTTP 上传到后端，然后在网页中实时查看、过滤、检索和导出。

它的设计目标很朴素：给个人开发者、小团队、测试服、灰度包和 Playtest 一个免费、简单、够用的日志控制台。

## 功能特性

- Unity 客户端通过 HTTP 批量上传日志
- 网页端实时刷新日志列表
- 支持按时间、Level、关键词、Player、Session、Version、Platform 过滤
- 日志详情抽屉，支持查看 Message、StackTrace、Custom JSON
- Message 和 StackTrace 一键复制
- CSV / JSON 导出
- 多用户登录，支持 admin / developer 角色
- 每个项目可创建多个接入 Token
- Token 可复制、删除、吊销
- 每个项目支持日志保留天数
- Unity 客户端本地持久化缓存，降低闪退丢日志风险
- 使用 `eventId` 做重传去重
- 无运行时第三方依赖，数据默认写入本地 JSON / JSONL 文件

## 适用场景

- Unity 开发阶段日志回收
- 测试服、体验服、灰度包日志查看
- Playtest 玩家问题排查
- 小团队内部错误追踪
- 本地或内网自托管日志平台

EasyLog 不是大规模日志平台的替代品。如果你的日志量已经非常大，建议把存储层替换为 PostgreSQL、ClickHouse、Elasticsearch 或 OpenSearch。

## 技术栈

- Backend: Node.js 原生 `http` + 文件存储
- Frontend: 原生 HTML / CSS / JavaScript
- Unity SDK: C# `MonoBehaviour` + `UnityWebRequest`
- Storage: `data/` 下的 JSON / JSONL 文件

## 快速开始

要求：

- Node.js `>= 20`

启动服务：

```bash
npm start
```

打开：

```text
http://localhost:3100
```

默认管理员账号：

```text
admin@easylog.local
admin1234
```

首次公开部署前，请务必修改默认密码。可以在第一次启动前设置：

```bash
EASYLOG_ADMIN_PASSWORD="your-strong-password" npm start
```

Windows PowerShell 示例：

```powershell
$env:EASYLOG_ADMIN_PASSWORD="your-strong-password"
npm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | Web 和 API 服务端口 |
| `EASYLOG_DATA_DIR` | `./data` | 数据目录 |
| `EASYLOG_ADMIN_PASSWORD` | `admin1234` | 首次创建默认管理员时使用 |
| `EASYLOG_AUTH_SECRET` | 自动生成 | JWT 签名和 Token 加密用密钥 |

如果已经启动过一次，默认管理员已经写入 `data/users.json`，之后再改 `EASYLOG_ADMIN_PASSWORD` 不会自动修改已有用户密码。

## 使用流程

1. 启动 EasyLog。
2. 使用默认管理员登录。
3. 创建 Project。
4. 在 Project 中生成接入 Token。
5. 在 Unity 客户端里配置 `ingestUrl` 和 `ingestToken`。
6. 运行游戏，日志会自动上传到 EasyLog。
7. 在网页中实时查看、过滤、检索和导出日志。

## Unity 接入

复制 SDK：

```text
unity/EasyLogClient.cs
```

到你的 Unity 项目中，然后：

1. 在首个场景创建一个空 GameObject，例如 `EasyLog`。
2. 挂载 `EasyLogClient` 组件。
3. 设置 `ingestUrl`，例如：

```text
http://127.0.0.1:3100/api/v1/logs
```

4. 在网页中生成接入 Token，并粘贴到 `ingestToken`。
5. 根据需要设置 `minimumLevel`、`batchSize`、`flushIntervalSeconds`。

客户端会监听 Unity 的：

```csharp
Application.logMessageReceivedThreaded
```

也可以主动记录业务日志：

```csharp
EasyLogClient client = FindObjectOfType<EasyLogClient>();
client.SetPlayer("player-001");
client.Track("Player entered dungeon", EasyLogLevel.Info, "gameplay");
```

## Unity 客户端关键配置

| 字段 | 说明 |
| --- | --- |
| `ingestUrl` | EasyLog 上传接口地址 |
| `ingestToken` | 项目接入 Token |
| `playerId` | 玩家 ID，可运行时通过 `SetPlayer` 更新 |
| `sessionId` | 当前游戏会话 ID，留空会自动生成 |
| `deviceId` | 设备 ID，留空会使用 Unity 设备标识 |
| `category` | 日志分类 |
| `batchSize` | 每次最多上传多少条日志 |
| `flushIntervalSeconds` | 定时上传间隔 |
| `minimumLevel` | 最低采集级别 |
| `spoolFileName` | 本地缓存日志文件名 |
| `maxSpoolLines` | 本地最多保留多少行未上传日志 |
| `flushImmediatelyOnError` | Error / Exception / Fatal 是否触发尽快上传 |

## 本地缓存与闪退恢复

Unity 客户端不会只把日志放在内存里等定时上传。每条日志产生后会先写入本地文件：

```text
Application.persistentDataPath/easylog_spool.jsonl
```

如果游戏在上传前闪退，未上传日志仍会留在本地文件里。下次游戏启动时，EasyLog 会读取本地缓存并补传。

上传成功后，客户端才会删除本地已经上传的行。如果网络失败、服务器不可用或 Token 无效，本地缓存不会被删除，下次继续重试。

组件右键菜单提供：

```text
Open EasyLog Log Directory
```

可以快速打开本地日志缓存目录。

## eventId 与去重

客户端会为每条日志生成 `eventId`：

```text
sessionId-sequence
```

例如：

```text
e29f3c1b3f9f44d2a6f7d6d12a8b0b3c-42
```

这样可以处理一种常见情况：日志已经上传到服务端，但客户端还没来得及删除本地缓存就闪退了。下次启动补传时，服务端会根据 `eventId` 过滤重复日志。

当前投递语义是：

```text
at-least-once + server-side dedupe
```

也就是优先避免丢日志，同时尽量避免重复显示。

## 时间精度

Unity 客户端上传的日志时间精确到毫秒：

```text
yyyy-MM-ddTHH:mm:ss.fffZ
```

网页显示格式示例：

```text
2026-06-06 15:18:51.645
```

## 接入 Token 的作用

Token 是客户端上传日志的专用凭证，主要用于：

- 鉴权：没有有效 Token 的请求不会被接收
- 项目归属：服务端通过 Token 判断日志属于哪个 Project
- 环境隔离：可以给开发包、测试包、线上包创建不同 Token
- 可撤销：Token 泄露后可以删除，不影响其他 Token
- 最小权限：Token 只能上传日志，不能登录后台、查看日志或管理项目

请不要把真实 Token 提交到公开仓库。

## Ingest API

### 上传单条日志

```bash
curl -X POST "http://localhost:3100/api/v1/logs" \
  -H "Authorization: Bearer YOUR_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "level": "error",
    "message": "Boss fight crashed",
    "playerId": "player-42",
    "sessionId": "session-1",
    "buildVersion": "0.1.0",
    "platform": "WindowsPlayer",
    "scene": "Arena"
  }'
```

PowerShell 示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3100/api/v1/logs" `
  -Headers @{ Authorization = "Bearer YOUR_INGEST_TOKEN" } `
  -ContentType "application/json" `
  -Body '{
    "level":"error",
    "message":"Boss fight crashed",
    "playerId":"player-42",
    "sessionId":"session-1",
    "buildVersion":"0.1.0",
    "platform":"WindowsPlayer",
    "scene":"Arena"
  }'
```

### 批量上传

```json
{
  "logs": [
    {
      "eventId": "session-1-1",
      "timestamp": "2026-06-06T12:00:00.123Z",
      "level": "warn",
      "message": "Inventory item missing",
      "playerId": "player-42",
      "sessionId": "session-1",
      "buildVersion": "0.1.0",
      "platform": "WindowsPlayer",
      "scene": "Town",
      "custom": {
        "itemId": "sword_001"
      }
    }
  ]
}
```

一次请求最多上传 `1000` 条日志。请求体最大约 `5 MB`。

成功响应：

```json
{
  "received": 10,
  "accepted": 9,
  "deduplicated": 1
}
```

字段含义：

- `received`：本次请求收到的日志条数
- `accepted`：实际写入服务端的日志条数
- `deduplicated`：因 `eventId` 重复而跳过的日志条数

## 日志字段

| 字段 | 说明 |
| --- | --- |
| `eventId` | 客户端事件 ID，用于去重 |
| `timestamp` | 客户端日志时间 |
| `level` | `trace` / `debug` / `info` / `warn` / `error` / `exception` / `fatal` |
| `message` | 日志内容 |
| `stackTrace` | 堆栈信息 |
| `category` | 日志分类 |
| `playerId` | 玩家 ID |
| `sessionId` | 会话 ID |
| `buildVersion` | 游戏版本 |
| `platform` | 平台 |
| `scene` | Unity 场景 |
| `deviceId` | 设备 ID |
| `custom` | 自定义 JSON 字段 |

服务端会对部分敏感内容做基础脱敏，例如 `password`、`token`、`secret`、`authorization`、邮箱等。

## 数据目录

默认数据目录：

```text
data/
```

典型文件：

```text
data/
  users.json
  projects.json
  secrets.json
  logs/
    <projectId>.jsonl
```

说明：

- 用户、项目、Token 元数据存储在 JSON 文件中
- 日志按 Project 写入 JSONL
- Token 明文只在创建或复制时展示，服务端保存 hash 和加密副本
- `data/` 不应该提交到 Git

## 开发

启动开发服务：

```bash
npm run dev
```

后台启动：

```bash
npm run dev:bg
```

运行测试：

```bash
npm test
```

当前测试覆盖：

- 密码 hash 和验证
- JWT 签名和校验
- 日志字段标准化和脱敏
- Token 创建、复制、删除
- `eventId` 去重

## 项目结构

```text
src/
  server.js       # HTTP 路由、静态资源、API
  storage.js      # 用户、项目、Token、日志存储
  security.js     # 密码、JWT、Token hash / 加密
public/
  index.html      # Web UI
  app.js          # 前端交互
  styles.css      # 样式
unity/
  EasyLogClient.cs
unity_sample/
  sample/         # Unity 示例工程
test/
  *.test.js
scripts/
  start-background.js
```

## 部署建议

- 公网部署时请放在 HTTPS 后面
- 首次启动前设置强密码
- 设置稳定的 `EASYLOG_AUTH_SECRET`
- 使用反向代理限制请求体大小和请求频率
- 不要公开真实接入 Token
- 定期备份 `data/`
- 日志量较大时，把 `EASYLOG_DATA_DIR` 放到可靠磁盘

Nginx 反向代理示例：

```nginx
server {
  listen 443 ssl;
  server_name logs.example.com;

  client_max_body_size 5m;

  location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 已知限制

- 默认文件存储适合个人和小团队，不适合高吞吐生产日志平台
- 当前没有内置速率限制
- 当前没有错误聚合、告警规则或 Webhook
- 当前没有分页游标，列表查询会扫描近期日志
- 当前没有数据库迁移工具

## 路线图

- 错误聚合和堆栈指纹
- Session 时间线视图
- 保存过滤条件和分享链接
- Token 级别速率限制
- 自定义脱敏规则
- 大文件异步导出
- PostgreSQL / ClickHouse 存储适配器
- 错误峰值告警和 Webhook
- Docker 镜像和 Compose 示例

## 贡献

欢迎提交 Issue 和 Pull Request。建议贡献前先说明要解决的问题、使用场景和预期行为，这样更容易保持 EasyLog 的小而清晰。

## License

正式开源前请添加 `LICENSE` 文件。个人项目和工具类项目通常可以选择 MIT 或 Apache-2.0。
