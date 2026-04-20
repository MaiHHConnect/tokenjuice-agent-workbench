import { EventEmitter } from 'events'

// 任务状态
export type TaskStatus =
  | 'Backlog'
  | 'InDev'
  | 'ReadyForTest'
  | 'InFix'
  | 'ReadyForDeploy'
  | 'Done'
  | 'Blocked'

// Agent 角色
export type AgentRole = 'pm' | 'developer' | 'tester' | 'deployer'

// Agent 状态
export type AgentStatus = 'idle' | 'busy' | 'offline'

// 任务接口
export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  assignedAgentId?: string
  skills: string[]
  loopCount: number
  bugReport?: string
  attachments: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

// Agent 接口
export interface Agent {
  id: string
  name: string
  role: AgentRole
  capabilities: string[]
  status: AgentStatus
  currentTaskId?: string
  lastHeartbeat: Date
  createdAt: Date
}

// 看板列定义
export const KANBAN_COLUMNS = [
  'Backlog',
  'InDev',
  'ReadyForTest',
  'InFix',
  'ReadyForDeploy',
  'Done',
  'Blocked'
] as const

// 任务流转规则
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  Backlog: ['InDev'],
  InDev: ['ReadyForTest', 'InFix'],
  ReadyForTest: ['ReadyForDeploy', 'InFix'],
  InFix: ['InDev', 'ReadyForTest'],
  ReadyForDeploy: ['Done'],
  Done: [],
  Blocked: ['InDev', 'Backlog']
}

// 生成唯一 ID
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// 调度器状态
export class SchedulerState extends EventEmitter {
  tasks: Map<string, Task> = new Map()
  agents: Map<string, Agent> = new Map()

  constructor() {
    super()
  }

  // 任务操作
  addTask(task: Task): Task {
    this.tasks.set(task.id, task)
    this.emit('task:added', task)
    return task
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status)
  }

  updateTask(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined

    const updated = { ...task, ...updates, updatedAt: new Date() }
    this.tasks.set(id, updated)
    this.emit('task:updated', updated)
    return updated
  }

  deleteTask(id: string): boolean {
    const deleted = this.tasks.delete(id)
    if (deleted) {
      this.emit('task:deleted', id)
    }
    return deleted
  }

  // Agent 操作
  addAgent(agent: Agent): Agent {
    this.agents.set(agent.id, agent)
    this.emit('agent:added', agent)
    return agent
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  getOnlineAgents(): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.status !== 'offline')
  }

  updateAgent(id: string, updates: Partial<Agent>): Agent | undefined {
    const agent = this.agents.get(id)
    if (!agent) return undefined

    const updated = { ...agent, ...updates }
    this.agents.set(id, updated)
    this.emit('agent:updated', updated)
    return updated
  }

  // 获取所有任务
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values())
  }

  // 获取所有 Agent
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values())
  }
}

// 全局状态单例
export const schedulerState = new SchedulerState()
