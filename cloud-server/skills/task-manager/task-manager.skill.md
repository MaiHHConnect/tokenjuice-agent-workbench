---
name: task-manager
description: 任务管理 Skill，支持创建、查询、更新和完成任务
version: 1.0.0
triggers:
  - /task
  - 任务
  - task
patterns:
  - "^创建任务 (.+)"
  - "^完成任务 (.+)"
  - "^查询任务$"
  - "^我的任务$"
enabled: true
priority: 20
category: productivity
selfImproving: true
platforms:
  - darwin
  - linux
  - win32
configVars:
  - key: defaultPriority
    description: 默认任务优先级
    default: "medium"
    required: false
  - key: autoAssign
    description: 是否自动分配任务
    default: "false"
    required: false
metadata:
  author: newai-team
  tags:
    - tasks
    - kanban
    - productivity
---

# Task Manager Skill

任务管理 Skill，提供完整的任务管理功能。

## 命令

- `/task` - 显示任务帮助
- `创建任务 <标题>` - 创建新任务
- `完成任务 <任务ID>` - 将任务标记为完成
- `查询任务` - 显示所有任务
- `我的任务` - 显示当前用户认领的任务

## 任务状态

- **Backlog** - 待处理
- **InDev** - 开发中
- **ReadyForTest** - 待测试
- **ReadyForDeploy** - 待部署
- **Done** - 已完成

## 自改进

系统会记录技能使用情况，自动优化触发词和模式匹配。
