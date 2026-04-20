import { schedulerState, schedulerTools } from './mcpTools'
import { getKanbanView, getKanbanStats } from './kanban'
import { heartbeatCheck } from './heartbeat'
import { getLoopProtectionStats } from './loopProtection'
import {
  getNextTaskForAgent,
  getAvailableTasksForAgent,
  getTasksByRole,
  autoAssignTask
} from './taskRouter'

// 调度器配置
export interface SchedulerConfig {
  heartbeatInterval: number
  offlineThreshold: number
  autoAssign: boolean
}

export const defaultSchedulerConfig: SchedulerConfig = {
  heartbeatInterval: 10_000, // 10 秒
  offlineThreshold: 30_000,  // 30 秒
  autoAssign: false
}

// 调度器类
export class Scheduler {
  private config: SchedulerConfig
  private heartbeatTimer?: NodeJS.Timeout
  private running: boolean = false

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...defaultSchedulerConfig, ...config }
  }

  // 启动调度器
  start(): void {
    if (this.running) return
    this.running = true

    // 启动心跳检测
    this.heartbeatTimer = setInterval(() => {
      heartbeatCheck(this.config.offlineThreshold)
    }, this.config.heartbeatInterval)

    console.log('[Scheduler] Started')
  }

  // 停止调度器
  stop(): void {
    if (!this.running) return
    this.running = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    console.log('[Scheduler] Stopped')
  }

  // 获取调度器状态
  getStatus(): {
    running: boolean
    tasks: number
    agents: number
    config: SchedulerConfig
  } {
    return {
      running: this.running,
      tasks: schedulerState.getAllTasks().length,
      agents: schedulerState.getAllAgents().length,
      config: this.config
    }
  }
}

// 调度器单例
export const scheduler = new Scheduler()

// 导出所有模块
export * from './state'
export * from './kanban'
export * from './mcpTools'
export * from './loopProtection'
export * from './taskRouter'

// CLI 命令处理
export function handleSchedulerCommand(args: string[]): void {
  const [command, ...rest] = args

  switch (command) {
    case 'start':
      scheduler.start()
      console.log('Scheduler started')
      break

    case 'stop':
      scheduler.stop()
      console.log('Scheduler stopped')
      break

    case 'status':
      console.log(JSON.stringify(scheduler.getStatus(), null, 2))
      break

    case 'board':
    case 'kanban':
      console.log(JSON.stringify(getKanbanView(), null, 2))
      break

    case 'stats':
      console.log(JSON.stringify({
        kanban: getKanbanStats(),
        loopProtection: getLoopProtectionStats()
      }, null, 2))
      break

    case 'agents':
      console.log(JSON.stringify(schedulerState.getOnlineAgents(), null, 2))
      break

    case 'tasks':
      console.log(JSON.stringify(schedulerState.getAllTasks(), null, 2))
      break

    case 'tick':
      // 手动触发一轮调度
      const devs = schedulerState.getOnlineAgents().filter(a => a.role === 'developer' && a.status === 'idle')
      for (const dev of devs) {
        const task = getNextTaskForAgent(dev)
        if (task) {
          console.log(`Assigning task ${task.id} to ${dev.name}`)
        }
      }
      break

    default:
      console.log(`Unknown command: ${command}`)
      console.log('Available commands: start, stop, status, board, stats, agents, tasks, tick')
  }
}
