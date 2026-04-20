# AI Agent 协作开发平台

基于 Claude Code + MCP 架构的多 Agent 协作平台。

## 本次版本更新

- 发布为精简后的公开版本，移除了内部任务记录、Wiki 沉淀、修复过程文档和本地运行产物。
- 保留可运行的核心代码：调度器 CLI、MCP 服务、云端 `cloud-server`、Web UI、测试与示例配置。
- 补齐发布边界：新增 `.gitignore`，避免把工作区数据、自动沉淀内容、私有过程文档一并提交。
- 当前版本聚焦白板式多 Agent 协作与任务调度能力，便于直接部署、二次开发和对外展示。

## 项目状态

### ✅ 已完成

- [x] 项目目录结构
- [x] 调度器核心模块 (TypeScript)
  - [x] 状态管理 (`src/scheduler/state.ts`)
  - [x] 看板逻辑 (`src/scheduler/kanban.ts`)
  - [x] MCP 工具定义 (`src/scheduler/mcpTools.ts`)
  - [x] 任务路由 (`src/scheduler/taskRouter.ts`)
  - [x] 循环保护 (`src/scheduler/loopProtection.ts`)
  - [x] 心跳检测 (`src/scheduler/heartbeat.ts`)
- [x] 云端 API 服务器
  - [x] Koa 服务器 (`cloud-server/src/index.js`)
  - [x] 数据持久化 (JSON 文件)
  - [x] Agent 管理 API
  - [x] 任务管理 API
  - [x] 看板视图 API
- [x] CLI 工具 (`src/cli.js`)
  - [x] `board` - 查看看板
  - [x] `tasks` - 查看任务列表
  - [x] `create` - 创建任务
  - [x] `claim` - 认领任务
  - [x] `status` - 更新状态
  - [x] `bug` - 报告 Bug
  - [x] `agents` - 查看 Agent
  - [x] `register` - 注册 Agent
  - [x] `stats` - 统计信息
- [x] MCP Server (`src/mcp/server.js`)
  - [x] kanban_register_task
  - [x] kanban_get_board
  - [x] kanban_get_tasks
  - [x] kanban_claim_task
  - [x] kanban_update_status
  - [x] kanban_report_bug
  - [x] kanban_register_agent
  - [x] kanban_heartbeat
  - [x] kanban_get_agents
  - [x] kanban_get_stats
- [x] Claude Code Agent 配置 (`.claude/agents/`)
  - [x] pm-agent.json
  - [x] dev-agent.json
  - [x] qa-agent.json
  - [x] deploy-agent.json
- [x] API 客户端 (`src/scheduler/client.ts`)
- [x] 调度器运行器 (`src/scheduler/runner.ts`)
- [x] 自动 Agent Runner (`src/auto-runner.js`)
  - [x] DevRunner - 自动认领并处理开发任务
  - [x] QARunner - 自动测试并报告 Bug
  - [x] DeployRunner - 自动部署完成任务

### ✅ 已完成

- [x] 钉钉集成 - 消息推送 (Webhook)
- [x] 钉钉集成 - Stream 连接与命令处理
- [x] Web UI 看板界面

### 🔄 进行中

- [ ] Docker 部署配置

### 📋 待完成

- [ ] Web UI 看板界面
- [ ] Docker 部署配置
- [ ] 云端同步机制
- [ ] 单元测试

## 快速开始

### 1. 启动云端服务器

```bash
cd cloud-server
npm install  # 已完成
npm start
```

### 2. 启动 MCP Server (可选)

```bash
node src/mcp/server.js
```

### 3. 访问 Web UI（可选）

打开浏览器访问 http://localhost:6666 即可看到可视化的看板界面。

### 5. 启动钉钉集成（可选）

```bash
# 配置钉钉机器人（群机器人 -> 高级设置 -> 启用加签）
export DINGTALK_WEBHOOK_URL="https://oapi.dingtalk.com/robot/send?access_token=xxx"
export DINGTALK_SECRET="SECxxx"

# 如果使用 Stream 模式（需要企业内部应用）
export DINGTALK_APP_KEY="dingxxx"
export DINGTALK_APP_SECRET="xxx"

# 测试钉钉连接
curl -X POST http://localhost:6666/api/dingtalk/test
```

### 6. 使用钉钉命令

在钉钉群中 @机器人 发送以下命令：

```bash
# 查看看板
/board

# 查看任务列表
/tasks

# 创建任务
/task 实现登录功能

# 认领任务
/claim <任务ID>

# 更新状态
/status <任务ID> ReadyForTest

# 报告 Bug
/bug <任务ID> 按钮点击无反应

# 查看统计
/stats

# 查看在线 Agent
/agents

# 获取帮助
/help
```

### 5. 使用 CLI 工具

```bash
# 查看看板
node src/cli.js board

# 创建任务
node src/cli.js create "实现登录功能" --skills=frontend,backend

# 注册 Agent
node src/cli.js register "Dev-1" developer --skills=frontend,backend

# 认领任务
node src/cli.js claim <taskId> <agentId>

# 更新状态
node src/cli.js status <taskId> ReadyForTest

# 报告 Bug
node src/cli.js bug <taskId> "按钮点击无反应"
```

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     Claude Code CLI                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    看板调度中心 (Scheduler)                    │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │ │
│  │  │ Backlog │ │  InDev  │ │ReadyTest│ │  InFix  │ ... │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │ │
│  └────────────────────────────────────────────────────────────┘ │
│  │ PM Agent │ Dev Agent │ QA Agent │ Deploy Agent │           │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTP / MCP
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     云服务器 (端口 6666)                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     Koa API Server                         │  │
│  │  - 看板数据持久化 (JSON 文件存储)                            │  │
│  │  - Agent 注册与心跳                                         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 看板状态

| 状态 | 描述 | 可流转到 |
|------|------|---------|
| Backlog | 待处理 | InDev |
| InDev | 开发中 | ReadyForTest, InFix |
| ReadyForTest | 待测试 | ReadyForDeploy, InFix |
| InFix | 待修复 | InDev, ReadyForTest |
| ReadyForDeploy | 待部署 | Done |
| Done | 已完成 | - |
| Blocked | 被阻塞 | InDev, Backlog |

## 循环保护机制

当 QA 报告同一个任务的 Bug 超过 3 次时，该任务会自动进入 `Blocked` 状态。

## 项目结构

```
claude-code/
├── .claude/
│   └── agents/          # Claude Code Agent 配置
│       ├── pm-agent.json
│       ├── dev-agent.json
│       ├── qa-agent.json
│       └── deploy-agent.json
│
├── src/
│   ├── cli.js          # CLI 工具
│   ├── mcp/
│   │   └── server.js   # MCP Server
│   └── scheduler/
│       ├── client.ts    # API 客户端
│       ├── runner.ts    # Agent 运行器
│       ├── heartbeat.ts
│       ├── index.ts
│       ├── kanban.ts
│       ├── loopProtection.ts
│       ├── mcpTools.ts
│       ├── state.ts
│       └── taskRouter.ts
│
├── cloud-server/        # 云端服务器
│   ├── src/
│   │   └── index.js     # Koa 服务器入口
│   ├── package.json
│   └── data/            # 数据存储
│       └── scheduler.json
│
└── docs/
    └── SCHEDULER.md     # 详细文档
```

## 更新日志

### 2026-04-13

- 完成云端服务器 (端口 6666)
- 完成 CLI 工具
- 完成 MCP Server (端口 6667)
- 完成 Claude Code Agent 配置
- 完成 API 客户端和运行器

## 钉钉集成配置

### Webhook 模式（消息推送）

1. 在钉钉群中添加"群机器人"
2. 选择"自定义机器人"
3. 复制 Webhook URL 和加签密钥

```bash
export DINGTALK_WEBHOOK_URL="https://oapi.dingtalk.com/robot/send?access_token=xxx"
export DINGTALK_SECRET="SECxxx"
```

### Stream 模式（双向通信）

1. 在钉钉开放平台创建企业内部应用
2. 配置机器人能力
3. 获取 AppKey 和 AppSecret

```bash
export DINGTALK_APP_KEY="dingxxx"
export DINGTALK_APP_SECRET="xxx"
```

## 技术栈

- **后端**: Koa, Node.js
- **CLI**: Node.js 原生 HTTP
- **MCP**: 自定义 MCP 协议实现
- **数据存储**: JSON 文件
- **Agent 配置**: Claude Code 原生 agents
- **钉钉集成**: Webhook + Stream 双重模式
