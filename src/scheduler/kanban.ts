import {
  Task,
  TaskStatus,
  KANBAN_COLUMNS,
  TASK_TRANSITIONS,
  schedulerState
} from './state'

// 看板列信息
export interface KanbanColumn {
  id: TaskStatus
  tasks: Task[]
}

// 获取完整看板视图
export function getKanbanView(): KanbanColumn[] {
  return KANBAN_COLUMNS.map(status => ({
    id: status,
    tasks: schedulerState.getTasksByStatus(status)
  }))
}

// 验证任务状态流转是否合法
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}

// 移动任务到新状态
export function moveTask(taskId: string, newStatus: TaskStatus, operatorId?: string): Task | undefined {
  const task = schedulerState.getTask(taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  if (!canTransition(task.status, newStatus)) {
    throw new Error(`Invalid transition from ${task.status} to ${newStatus}`)
  }

  const updated = schedulerState.updateTask(taskId, {
    status: newStatus,
    assignedAgentId: newStatus === 'Backlog' ? undefined : task.assignedAgentId
  })

  if (updated) {
    schedulerState.emit('task:moved', {
      task: updated,
      from: task.status,
      to: newStatus,
      operatorId
    })
  }

  return updated
}

// 认领任务
export function claimTask(taskId: string, agentId: string): Task | undefined {
  const task = schedulerState.getTask(taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  if (task.assignedAgentId) {
    throw new Error(`Task ${taskId} is already assigned to ${task.assignedAgentId}`)
  }

  return schedulerState.updateTask(taskId, {
    assignedAgentId: agentId,
    status: task.status === 'Backlog' ? 'InDev' : task.status
  })
}

// 释放任务（重新放回队列）
export function releaseTask(taskId: string): Task | undefined {
  return schedulerState.updateTask(taskId, {
    assignedAgentId: undefined,
    status: 'Backlog'
  })
}

// 获取任务优先级
export function getTaskPriority(task: Task): number {
  // InFix 最高优先级 (0)
  if (task.status === 'InFix') return 0

  // Blocked 次高优先级 (1)
  if (task.status === 'Blocked') return 1

  // 然后按更新时间排序（早的先处理）
  return 2 + task.updatedAt.getTime()
}

// 排序任务列表
export function sortTasks(tasks: Task[]): Task[] {
  return tasks.sort((a, b) => getTaskPriority(a) - getTaskPriority(b))
}

// 获取看板统计信息
export function getKanbanStats(): {
  total: number
  byStatus: Record<TaskStatus, number>
  inFixLoops: number
  blockedTasks: number
} {
  const tasks = schedulerState.getAllTasks()
  const byStatus: Record<TaskStatus, number> = {} as Record<TaskStatus, number>

  for (const status of KANBAN_COLUMNS) {
    byStatus[status] = 0
  }

  let inFixLoops = 0
  let blockedTasks = 0

  for (const task of tasks) {
    byStatus[task.status]++
    if (task.loopCount > 0) inFixLoops++
    if (task.status === 'Blocked') blockedTasks++
  }

  return {
    total: tasks.length,
    byStatus,
    inFixLoops,
    blockedTasks
  }
}
