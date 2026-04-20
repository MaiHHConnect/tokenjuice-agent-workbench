import { schedulerState, Task } from './state'

// InFix 循环最大次数
export const MAX_FIX_LOOPS = 3

// 循环保护配置
export interface LoopProtectionConfig {
  maxFixLoops: number
  blockAfterMax: boolean
  notifyOnBlock: boolean
}

export const defaultLoopProtectionConfig: LoopProtectionConfig = {
  maxFixLoops: MAX_FIX_LOOPS,
  blockAfterMax: true,
  notifyOnBlock: true
}

// 任务循环记录
interface LoopRecord {
  taskId: string
  fixCount: number
  lastTransition: Date
  blocked: boolean
}

const loopRecords: Map<string, LoopRecord> = new Map()

// 记录循环次数
function recordLoop(taskId: string): LoopRecord {
  const existing = loopRecords.get(taskId)
  if (existing) {
    existing.fixCount++
    existing.lastTransition = new Date()
    return existing
  }
  const record: LoopRecord = {
    taskId,
    fixCount: 1,
    lastTransition: new Date(),
    blocked: false
  }
  loopRecords.set(taskId, record)
  return record
}

// 获取循环记录
export function getLoopRecord(taskId: string): LoopRecord | undefined {
  return loopRecords.get(taskId)
}

// 检查任务是否应该被阻止
export function shouldBlock(taskId: string, maxLoops: number = MAX_FIX_LOOPS): boolean {
  const record = loopRecords.get(taskId)
  if (!record) return false
  return record.fixCount > maxLoops
}

// 处理 Bug 报告
export function handleBugReport(
  taskId: string,
  bugReport: string,
  config: LoopProtectionConfig = defaultLoopProtectionConfig
): { task: Task | undefined; blocked: boolean; loopCount: number } {
  const task = schedulerState.getTask(taskId)
  if (!task) {
    throw new Error(`Task ${taskId} not found`)
  }

  // 如果是已Blocked的任务，不再处理
  if (task.status === 'Blocked') {
    return { task, blocked: true, loopCount: task.loopCount }
  }

  // 更新任务循环次数
  const newLoopCount = task.loopCount + 1
  const record = recordLoop(taskId)

  // 检查是否超过最大循环次数
  if (newLoopCount > config.maxFixLoops) {
    if (config.blockAfterMax) {
      const updated = schedulerState.updateTask(taskId, {
        status: 'Blocked',
        loopCount: newLoopCount,
        bugReport,
        attachments: {
          ...task.attachments,
          bug_report: bugReport,
          blockedAt: new Date(),
          blockReason: `循环超过 ${config.maxFixLoops} 次，需要人工介入`
        }
      })

      if (record) {
        record.blocked = true
      }

      schedulerState.emit('task:blocked', { task: updated, loopCount: newLoopCount })

      return { task: updated, blocked: true, loopCount: newLoopCount }
    }
  }

  // 正常进入 InFix
  const updated = schedulerState.updateTask(taskId, {
    status: 'InFix',
    loopCount: newLoopCount,
    bugReport,
    attachments: {
      ...task.attachments,
      bug_report: bugReport
    }
  })

  schedulerState.emit('task:infix', { task: updated, loopCount: newLoopCount })

  return { task: updated, blocked: false, loopCount: newLoopCount }
}

// 重置循环记录
export function resetLoopRecord(taskId: string): void {
  loopRecords.delete(taskId)
  const task = schedulerState.getTask(taskId)
  if (task && task.status === 'Blocked') {
    schedulerState.updateTask(taskId, {
      status: 'InFix',
      loopCount: 0,
      attachments: {
        ...task.attachments,
        unblockedAt: new Date()
      }
    })
  }
}

// 获取所有被阻止的任务
export function getBlockedTasks(): Task[] {
  return schedulerState.getTasksByStatus('Blocked')
}

// 获取循环次数超过阈值的任务
export function getHighLoopTasks(threshold: number = 1): Task[] {
  return schedulerState.getAllTasks().filter(t => t.loopCount > threshold)
}

// 循环保护统计
export function getLoopProtectionStats(): {
  totalRecords: number
  blockedCount: number
  highLoopCount: number
  avgLoopCount: number
} {
  const records = Array.from(loopRecords.values())
  const blockedCount = records.filter(r => r.blocked).length
  const highLoopCount = records.filter(r => r.fixCount > MAX_FIX_LOOPS).length
  const totalLoopCount = records.reduce((sum, r) => sum + r.fixCount, 0)
  const avgLoopCount = records.length > 0 ? totalLoopCount / records.length : 0

  return {
    totalRecords: records.length,
    blockedCount,
    highLoopCount,
    avgLoopCount: Math.round(avgLoopCount * 100) / 100
  }
}
