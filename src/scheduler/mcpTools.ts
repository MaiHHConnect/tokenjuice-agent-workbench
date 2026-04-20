import { z } from 'zod'
import { schedulerState, Task, Agent, generateId, TaskStatus, AgentRole } from './state'
import {
  getKanbanView,
  moveTask,
  claimTask,
  releaseTask,
  getKanbanStats,
  sortTasks
} from './kanban'
import { MAX_FIX_LOOPS, handleBugReport } from './loopProtection'

// 工具输入Schema
export const registerTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  skills: z.array(z.string()).optional()
})

export const updateTaskStatusSchema = z.object({
  taskId: z.string(),
  newStatus: z.enum(['Backlog', 'InDev', 'ReadyForTest', 'InFix', 'ReadyForDeploy', 'Done', 'Blocked'])
})

export const claimTaskSchema = z.object({
  taskId: z.string()
})

export const reportBugSchema = z.object({
  taskId: z.string(),
  bugReport: z.string()
})

export const registerAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['pm', 'developer', 'tester', 'deployer']),
  capabilities: z.array(z.string()).optional()
})

export const heartbeatSchema = z.object({
  agentId: z.string()
})

// 工具定义
export const schedulerTools = {
  // 注册新任务
  kanban_register_task: {
    name: 'kanban_register_task',
    description: '注册新任务到看板，用于 PM 拆解需求后创建任务',
    inputSchema: registerTaskSchema,
    async call(args: z.infer<typeof registerTaskSchema>) {
      const task: Task = {
        id: generateId(),
        title: args.title,
        description: args.description,
        status: 'Backlog',
        skills: args.skills ?? [],
        loopCount: 0,
        attachments: {},
        createdAt: new Date(),
        updatedAt: new Date()
      }
      schedulerState.addTask(task)
      return { taskId: task.id, task }
    }
  },

  // 获取任务列表
  kanban_get_tasks: {
    name: 'kanban_get_tasks',
    description: '获取任务列表，支持按状态过滤',
    inputSchema: z.object({
      status: z.enum(['Backlog', 'InDev', 'ReadyForTest', 'InFix', 'ReadyForDeploy', 'Done', 'Blocked']).optional(),
      agentId: z.string().optional()
    }),
    async call(args: { status?: TaskStatus; agentId?: string }) {
      let tasks = schedulerState.getAllTasks()
      if (args.status) {
        tasks = tasks.filter(t => t.status === args.status)
      }
      if (args.agentId) {
        tasks = tasks.filter(t => t.assignedAgentId === args.agentId)
      }
      return { tasks: sortTasks(tasks) }
    }
  },

  // 获取看板视图
  kanban_get_board: {
    name: 'kanban_get_board',
    description: '获取完整看板视图，展示所有列及其任务',
    inputSchema: z.object({}),
    async call() {
      return { board: getKanbanView() }
    }
  },

  // 认领任务
  kanban_claim_task: {
    name: 'kanban_claim_task',
    description: 'Agent 认领一个任务，开始处理',
    inputSchema: claimTaskSchema,
    async call(args: z.infer<typeof claimTaskSchema>, context: { agentId: string }) {
      const task = claimTask(args.taskId, context.agentId)
      return { task }
    }
  },

  // 更新任务状态
  kanban_update_status: {
    name: 'kanban_update_status',
    description: '更新任务状态',
    inputSchema: updateTaskStatusSchema,
    async call(args: z.infer<typeof updateTaskStatusSchema>, context: { agentId: string }) {
      const task = moveTask(args.taskId, args.newStatus, context.agentId)
      return { task }
    }
  },

  // 报告 Bug
  kanban_report_bug: {
    name: 'kanban_report_bug',
    description: 'QA 报告 Bug，导致任务进入 InFix 状态',
    inputSchema: reportBugSchema,
    async call(args: z.infer<typeof reportBugSchema>) {
      const result = handleBugReport(args.taskId, args.bugReport)
      return result
    }
  },

  // 注册 Agent
  kanban_register_agent: {
    name: 'kanban_register_agent',
    description: '注册新 Agent 到调度器',
    inputSchema: registerAgentSchema,
    async call(args: z.infer<typeof registerAgentSchema>) {
      const agent: Agent = {
        id: generateId(),
        name: args.name,
        role: args.role,
        capabilities: args.capabilities ?? [],
        status: 'idle',
        lastHeartbeat: new Date(),
        createdAt: new Date()
      }
      schedulerState.addAgent(agent)
      return { agentId: agent.id, agent }
    }
  },

  // 心跳
  kanban_heartbeat: {
    name: 'kanban_heartbeat',
    description: 'Agent 发送心跳，证明仍然存活',
    inputSchema: heartbeatSchema,
    async call(args: z.infer<typeof heartbeatSchema>) {
      const agent = schedulerState.updateAgent(args.agentId, {
        lastHeartbeat: new Date(),
        status: 'idle'
      })
      return { agent, timestamp: new Date().toISOString() }
    }
  },

  // 获取在线 Agent
  kanban_get_agents: {
    name: 'kanban_get_agents',
    description: '获取所有在线 Agent',
    inputSchema: z.object({}),
    async call() {
      return { agents: schedulerState.getOnlineAgents() }
    }
  },

  // 获取看板统计
  kanban_get_stats: {
    name: 'kanban_get_stats',
    description: '获取看板统计信息',
    inputSchema: z.object({}),
    async call() {
      return getKanbanStats()
    }
  },

  // 完成开发任务
  kanban_complete_dev: {
    name: 'kanban_complete_dev',
    description: 'Dev Agent 完成开发，标记为待测试',
    inputSchema: z.object({
      taskId: z.string(),
      commitHash: z.string().optional()
    }),
    async call(args: { taskId: z.infer<typeof claimTaskSchema>; commitHash?: string }, context: { agentId: string }) {
      const task = schedulerState.updateTask(args.taskId, {
        attachments: {
          ...schedulerState.getTask(args.taskId)?.attachments,
          commitHash: args.commitHash,
          completedAt: new Date()
        }
      })
      if (task) {
        moveTask(args.taskId, 'ReadyForTest', context.agentId)
      }
      return { task }
    }
  },

  // 测试通过
  kanban_test_pass: {
    name: 'kanban_test_pass',
    description: 'QA 测试通过，任务可以部署',
    inputSchema: z.object({
      taskId: z.string()
    }),
    async call(args: { taskId: string }, context: { agentId: string }) {
      const task = moveTask(args.taskId, 'ReadyForDeploy', context.agentId)
      return { task }
    }
  },

  // 部署完成
  kanban_deploy: {
    name: 'kanban_deploy',
    description: '部署完成，任务标记为 Done',
    inputSchema: z.object({
      taskId: z.string()
    }),
    async call(args: { taskId: string }, context: { agentId: string }) {
      const task = moveTask(args.taskId, 'Done', context.agentId)
      schedulerState.updateAgent(context.agentId, { currentTaskId: undefined })
      return { task }
    }
  },

  // 追加日志
  kanban_append_log: {
    name: 'kanban_append_log',
    description: '追加任务日志',
    inputSchema: z.object({
      taskId: z.string(),
      message: z.string()
    }),
    async call(args: { taskId: string; message: string }, context: { agentId: string }) {
      const task = schedulerState.getTask(args.taskId)
      if (!task) {
        throw new Error(`Task ${args.taskId} not found`)
      }
      const logs = (task.attachments.logs as string[]) ?? []
      logs.push({
        timestamp: new Date().toISOString(),
        agentId: context.agentId,
        message: args.message
      })
      schedulerState.updateTask(args.taskId, {
        attachments: { ...task.attachments, logs }
      })
      return { success: true }
    }
  }
}

// 导出所有工具
export type SchedulerToolName = keyof typeof schedulerTools

export function getAllTools() {
  return Object.values(schedulerTools)
}

export function getTool(name: SchedulerToolName) {
  return schedulerTools[name]
}
