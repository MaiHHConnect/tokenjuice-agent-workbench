import { schedulerState, Task, Agent, AgentRole } from './state'
import { sortTasks } from './kanban'

// 任务路由配置
export interface TaskRouterConfig {
  prioritizeInFix: boolean
  prioritizeBlocked: boolean
  matchSkills: boolean
}

// 默认配置
export const defaultTaskRouterConfig: TaskRouterConfig = {
  prioritizeInFix: true,
  prioritizeBlocked: true,
  matchSkills: true
}

// Agent 能力匹配
function matchesSkills(task: Task, agent: Agent): boolean {
  if (!config.matchSkills) return true
  if (task.skills.length === 0) return true
  if (agent.capabilities.length === 0) return true

  return task.skills.some(skill =>
    agent.capabilities.some(cap =>
      cap.toLowerCase().includes(skill.toLowerCase()) ||
      skill.toLowerCase().includes(cap.toLowerCase())
    )
  )
}

// 获取 Agent 的当前配置
let config = defaultTaskRouterConfig

export function setTaskRouterConfig(newConfig: Partial<TaskRouterConfig>) {
  config = { ...config, ...newConfig }
}

export function getTaskRouterConfig(): TaskRouterConfig {
  return { ...config }
}

// 为 Agent 获取下一个任务
export function getNextTaskForAgent(agent: Agent): Task | null {
  const allTasks = schedulerState.getAllTasks()

  // 过滤可被认领的任务
  let candidates = allTasks.filter(t =>
    !t.assignedAgentId &&
    (t.status === 'Backlog' || t.status === 'InFix' || t.status === 'Blocked')
  )

  // 技能匹配
  candidates = candidates.filter(t => matchesSkills(t, agent))

  if (candidates.length === 0) {
    return null
  }

  // 排序
  candidates = sortTasks(candidates)

  return candidates[0]
}

// 为 Agent 获取所有可用任务
export function getAvailableTasksForAgent(agent: Agent): Task[] {
  const allTasks = schedulerState.getAllTasks()

  return sortTasks(
    allTasks.filter(t =>
      !t.assignedAgentId &&
      (t.status === 'Backlog' || t.status === 'InFix' || t.status === 'Blocked') &&
      matchesSkills(t, agent)
    )
  )
}

// 根据角色获取任务
export function getTasksByRole(role: AgentRole): Task[] {
  const allTasks = schedulerState.getAllTasks()

  switch (role) {
    case 'pm':
      // PM 可以看到所有任务
      return sortTasks(allTasks)

    case 'developer':
      // Dev 优先看 InFix，然后 Backlog
      return sortTasks(
        allTasks.filter(t =>
          !t.assignedAgentId ||
          t.assignedAgentId === 'dev' ||
          t.status === 'InFix' ||
          t.status === 'Backlog'
        )
      )

    case 'tester':
      // QA 看 ReadyForTest 和 InFix
      return sortTasks(
        allTasks.filter(t =>
          t.status === 'ReadyForTest' ||
          t.status === 'InFix'
        )
      )

    case 'deployer':
      // Deployer 看 ReadyForDeploy
      return sortTasks(
        allTasks.filter(t => t.status === 'ReadyForDeploy')
      )

    default:
      return []
  }
}

// 广播任务（通知所有相关 Agent）
export function broadcastTaskAvailability(task: Task): Agent[] {
  const onlineAgents = schedulerState.getOnlineAgents()

  return onlineAgents.filter(agent =>
    agent.role !== 'pm' && matchesSkills(task, agent)
  )
}

// 自动分配任务（简单轮询）
let lastAssignedIndex = 0

export function autoAssignTask(taskId: string): Task | undefined {
  const task = schedulerState.getTask(taskId)
  if (!task || task.assignedAgentId) {
    return undefined
  }

  const onlineAgents = schedulerState.getOnlineAgents()
    .filter(a => a.role === 'developer' && a.status === 'idle')

  if (onlineAgents.length === 0) {
    return undefined
  }

  // 轮询分配
  const agent = onlineAgents[lastAssignedIndex % onlineAgents.length]
  lastAssignedIndex++

  task.assignedAgentId = agent.id
  agent.currentTaskId = taskId
  agent.status = 'busy'

  schedulerState.updateTask(taskId, { status: 'InDev' })
  schedulerState.updateAgent(agent.id, { currentTaskId: taskId, status: 'busy' })

  return task
}
