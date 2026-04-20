# AI Agent 协作开发平台

基于 Claude Code + MCP 架构的多 Agent 协作平台。

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
                              │ HTTP
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

## 快速开始

### 1. 启动云端服务器

```bash
cd cloud-server
npm install
npm start
```

服务器将在 http://localhost:6666 启动

### 2. 验证服务器运行

```bash
curl http://localhost:6666/health
```

### 3. 使用看板 API

```bash
# 创建任务
curl -X POST http://localhost:6666/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "实现登录功能", "skills": ["frontend", "backend"]}'

# 查看看板
curl http://localhost:6666/api/board

# 认领任务
curl -X POST http://localhost:6666/api/tasks/<task-id>/claim \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<agent-id>"}'

# 更新状态
curl -X PATCH http://localhost:6666/api/tasks/<task-id>/status \
  -H "Content-Type: application/json" \
  -d '{"status": "ReadyForTest"}'

# 报告 Bug
curl -X POST http://localhost:6666/api/tasks/<task-id>/bug \
  -H "Content-Type: application/json" \
  -d '{"bugReport": "登录按钮点击无反应"}'
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

## API 端点

### 健康检查
- `GET /health` - 服务器健康状态

### Agent 管理
- `GET /api/agents` - 获取所有 Agent
- `GET /api/agents/online` - 获取在线 Agent
- `POST /api/agents` - 注册新 Agent
- `POST /api/agents/:id/heartbeat` - Agent 心跳

### 任务管理
- `GET /api/tasks` - 获取所有任务
- `POST /api/tasks` - 创建任务
- `GET /api/tasks/:id` - 获取单个任务
- `PATCH /api/tasks/:id/status` - 更新任务状态
- `POST /api/tasks/:id/claim` - 认领任务
- `POST /api/tasks/:id/bug` - 报告 Bug

### 看板
- `GET /api/board` - 获取完整看板视图

### 统计
- `GET /api/stats` - 获取统计信息

## 循环保护机制

当 QA 报告同一个任务的 Bug 超过 3 次时，该任务会自动进入 `Blocked` 状态。

## Claude Code Agent 配置

Agents 配置位于 `.claude/agents/` 目录：

- `pm-agent.json` - 项目经理
- `dev-agent.json` - 开发者
- `qa-agent.json` - 测试工程师
- `deploy-agent.json` - 部署工程师

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
│   ├── scheduler/       # 调度器核心模块
│   │   ├── index.ts     # 调度器入口
│   │   ├── state.ts     # 状态管理
│   │   ├── kanban.ts    # 看板逻辑
│   │   ├── mcpTools.ts  # MCP 工具定义
│   │   ├── taskRouter.ts # 任务路由
│   │   ├── loopProtection.ts # 循环保护
│   │   └── heartbeat.ts # 心跳检测
│   │
│   ├── agents/          # Agent 提示词
│   │   ├── pm/
│   │   ├── dev/
│   │   ├── qa/
│   │   └── deploy/
│   │
│   └── cloud/           # 云端同步
│       ├── sync.ts
│       └── api.ts
│
├── cloud-server/        # 云端服务器
│   └── src/
│       └── index.js     # Koa 服务器入口
│
└── docs/
    └── SCHEDULER.md
```
