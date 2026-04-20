# Cloud Server - AI Agent 看板

基于 Claude 源码架构的多 Agent 任务调度系统。

## 本次版本更新

- 同步为新的公开发布版本，移除了内部修复记录、运行期数据、工作区缓存和自动沉淀产物。
- 保留任务调度、Autopilot、Wiki/Skill 能力、钉钉集成、Web UI 与测试代码，方便直接启动和继续开发。
- 目录结构已按发布用途整理，仓库提交内容更适合共享、部署与后续协作。

## 当前问题与修复 (2026-04)

### 已解决的问题

1. **子任务调度** ✅
   - 问题：父任务跳过时，子任务没有被加入执行队列
   - 修复：`findClaimableTasks()` 现在会检查父任务的 pending 子任务并调度

2. **CLAUDECODE 环境变量冲突** ✅
   - 问题：spawn 子进程时报 "nested session" 错误
   - 修复：`spawnEnv` 中清除 `CLAUDECODE` 变量

3. **容量配置持久化** ✅
   - 问题：`maxConcurrentAgents` 重启后重置
   - 修复：存储到数据库，优先级：数据库 > options > 默认值

4. **QA 验证详细反馈** ✅
   - 问题：QA 验证失败只显示简单信息
   - 修复：`passCount`/`failCount` 模式匹配，显示详细错误

5. **showTaskDetail 未定义** ✅
   - 问题：发送消息时报 "Can't find variable: showTaskDetail"
   - 修复：改用 `openTaskDetail()` 函数

6. **快速消息按钮** ✅
   - 问题：无法直接向运行中的 Agent 发消息
   - 修复：任务卡片添加快速发送按钮

## 核心功能

### 1. 多 Agent 任务调度
- 增强调度器 (`enhancedScheduler.js`)
- Workspace 隔离 (`workspace.js`)
- WORKFLOW.md 配置 (`workflow.js`)

**任务状态流程**：
```
Backlog → Analyzing → Collecting(待补充) → InDev → ReadyForTest → InFix → Blocked → ReadyForDeploy → Done
```

- **Collecting (待补充)**：任务分析时信息不全，需要人类一次性补充完整
- **Blocked (阻塞)**：任务无法执行（如缺少关键信息）

### 2. Skills 自改进系统
- Skill 管理器 (`skillManager.js`)
- 关键词 + 正则触发
- 自改进机制 (selfImproving)
- 19 种 Agent 角色 (`agentRoles.js`)

### 3. Memory 记忆系统
- 多 Provider 协调 (`memoryManager.js`)
- 用户/Session 记忆分离
- 记忆预取和同步

### 4. 自动驾驶模式
- `autoPilot.js` - 自动执行循环
- `ralph.js` - 带验证的循环
- `ultraqa.js` - QA 测试循环

### 5. 持续验证 (TaskRunner)
- 每个步骤执行后自动验证
- 失败则打回 `InFix` 状态
- 修复后继续执行

### 5.1 补充任务流程 (Collecting)
- 任务分析时如信息不全，移动到「待补充」状态
- 使用 superpowers 风格提问，一次性收集完整信息
- 人类在任务详情页补充后，任务继续分析
- 子任务如遇信息不全，反馈给父任务，父任务进入 Collecting

### 6. Wiki 知识沉淀
- 父任务完成时自动生成 Wiki 文档
- Wiki 包含任务概述、方法总结、关键步骤
- 反链子任务，形成知识网络
- LLM 语义搜索 Wiki

### 7. Skill 自动沉淀
- 任务完成时自动提取可复用模式
- 保存为 `.skill.md` 文件到 `skills/沉淀/`
- 格式兼容现有 SkillManager
- 系统越用越强

### 8. 工具安全属性 (Claude 风格)
```javascript
isConcurrencySafe(input)  // 并发安全
isReadOnly(input)        // 只读操作
isDestructive(input)     // 破坏性操作
```

## API 路由

| 分类 | 端点 | 说明 |
|------|------|------|
| Agent | `GET/POST /api/agents` | Agent 管理 |
| Task | `GET/POST /api/tasks` | 任务管理 |
| Board | `GET /api/board` | 看板视图 |
| Skills | `GET /api/skills` | Skills 列表 |
| Wiki | `GET /api/wiki` | Wiki 列表 |
| Wiki | `GET /api/wiki/search?query=` | Wiki 语义搜索 |
| Stats | `GET /api/stats` | 统计（含 Wiki/Skill 数量） |
| Roles | `GET /api/roles` | Agent 角色 |
| Team | `POST /api/team` | 创建团队 |
| Autopilot | `POST /api/autopilot` | 自动驾驶 |
| Ultraqa | `POST /api/ultraqa` | QA 循环 |
| TaskRunner | `POST /api/taskrunner/:id/start` | 持续验证 |

## 运行

```bash
cd cloud-server
npm install
npm start
# 访问 http://localhost:8085
```

## 测试

```bash
node test.js
```

## 项目结构

```
cloud-server/
├── src/
│   ├── index.js           # 主入口
│   ├── db.js              # 数据层（含 Wiki CRUD）
│   ├── skillManager.js    # Skill 管理
│   ├── memoryManager.js   # Memory 管理
│   ├── agentRoles.js     # Agent 角色
│   ├── autoPilot.js      # 自动驾驶
│   ├── ultraqa.js         # QA 循环
│   ├── teamManager.js    # 团队管理
│   ├── taskRunner.js      # 持续验证
│   ├── wikiSkillHooks.js  # Wiki/Skill 沉淀 Hook
│   ├── tools.js           # 工具定义
│   └── dingtalk/          # 钉钉集成
├── skills/                # Skill 文件（含沉淀）
├── skills/沉淀/            # 自动沉淀的 Skill
├── public/                 # Web UI
└── test.js               # 端到端测试
```

## 参考

- [Claude Code 源码分析](./参考/)
- oh-my-claudecode 多 Agent 编排
