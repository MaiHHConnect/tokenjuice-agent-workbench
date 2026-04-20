---
name: multi-agent
description: 多代理团队协作，支持同时启动多个 Agent 协同处理复杂任务
version: 1.0.0
triggers:
  - /team
  - 多代理
  - 团队协作
  - team
  - 多个代理
patterns:
  - "^启动.*代理"
  - "^创建团队"
  - "^用.*个代理"
enabled: true
priority: 30
category: productivity
platforms:
  - darwin
  - linux
  - win32
configVars:
  - key: defaultType
    description: 默认 Agent 类型
    default: "claude"
    required: false
  - key: maxAgents
    description: 最大 Agent 数量
    default: "5"
    required: false
metadata:
  author: newai
  tags:
    - multi-agent
    - team
    - collaboration
---

# Multi-Agent 团队协作 Skill

基于 oh-my-claudecode 的多代理团队功能。

## 使用方法

### 命令格式
```
/team N:claude "任务描述"
/team N:codex:role "任务描述"
```

### 示例
```
/team 3:claude "帮我重构登录模块"
/team 2:claude:architect "设计支付系统"
/team 1:claude,1:codex "对比两种实现方案"
```

### 角色
- `architect` - 架构师
- `executor` - 执行者
- `planner` - 规划师
- `analyst` - 分析师
- `critic` - 评论员
- `debugger` - 调试员
- `code-reviewer` - 代码审查
- `test-engineer` - 测试工程师

## API 端点

- `POST /api/team` - 创建团队
- `POST /api/team/:id/start` - 启动团队
- `POST /api/team/:id/shutdown` - 关闭团队
- `GET /api/team/status` - 获取状态
