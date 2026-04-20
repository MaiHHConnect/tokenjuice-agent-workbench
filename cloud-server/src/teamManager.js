/**
 * Team 多代理团队管理
 *
 * 基于 oh-my-claudecode 的 team 功能
 */

import { EventEmitter } from 'events'
import { AGENT_ROLES } from './agentRoles.js'

/**
 * Team 状态
 */
export const TeamState = {
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
}

/**
 * Worker 状态
 */
export const WorkerState = {
  IDLE: 'idle',
  WORKING: 'working',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed'
}

/**
 * Team Worker (工作者)
 */
export class TeamWorker extends EventEmitter {
  constructor(workerId, type, role, config = {}) {
    super()
    this.workerId = workerId
    this.type = type || 'claude'
    this.role = role
    this.state = WorkerState.IDLE
    this.config = config
    this.currentTask = null
    this.history = []
    this.result = null

    // 获取角色定义
    this.roleDefinition = AGENT_ROLES[role] || null
  }

  /**
   * 开始执行任务
   */
  async start(task) {
    this.state = WorkerState.WORKING
    this.currentTask = task
    this.emit('start', { worker: this, task })

    try {
      // 模拟执行（实际会调用 Claude Code API）
      this.result = await this.execute(task)
      this.state = WorkerState.COMPLETED
      this.emit('complete', { worker: this, result: this.result })
    } catch (error) {
      this.state = WorkerState.FAILED
      this.error = error
      this.emit('failed', { worker: this, error })
    }

    return this
  }

  /**
   * 执行任务
   */
  async execute(task) {
    // 这里会调用实际的 Agent
    // 暂时模拟
    return {
      workerId: this.workerId,
      role: this.role,
      task: task,
      output: `[Worker ${this.workerId}] 执行中...`,
      success: true
    }
  }

  /**
   * 发送消息给 Worker
   */
  sendMessage(message) {
    this.emit('message', { worker: this, message })
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      workerId: this.workerId,
      type: this.type,
      role: this.role,
      state: this.state,
      currentTask: this.currentTask,
      result: this.result
    }
  }
}

/**
 * Team 任务
 */
export class TeamTask extends EventEmitter {
  constructor(taskId, description, workers, options = {}) {
    super()
    this.taskId = taskId
    this.description = description
    this.workers = workers
    this.options = options
    this.state = TeamState.INITIALIZING
    this.tasks = {
      total: workers.length,
      pending: workers.length,
      inProgress: 0,
      completed: 0,
      failed: 0
    }
    this.results = []
    this.teamName = `team-${taskId}`
  }

  /**
   * 开始执行
   */
  async start() {
    this.state = TeamState.RUNNING
    this.emit('start', this)

    // 启动所有 worker
    const promises = this.workers.map(worker => worker.start(this.description))

    try {
      const results = await Promise.allSettled(promises)

      // 处理结果
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this.results.push(result.value)
          this.tasks.completed++
        } else {
          this.tasks.failed++
        }
      }

      this.state = TeamState.COMPLETED
      this.emit('complete', { results: this.results })
    } catch (error) {
      this.state = TeamState.FAILED
      this.emit('failed', { error })
    }

    return this
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      taskId: this.taskId,
      teamName: this.teamName,
      description: this.description,
      state: this.state,
      workers: this.workers.map(w => w.getStatus()),
      tasks: this.tasks,
      results: this.results
    }
  }
}

/**
 * Team 管理器
 */
export class TeamManager {
  constructor() {
    this.tasks = new Map()
    this.activeTask = null
    this.nextWorkerId = 1
  }

  /**
   * 解析 team 规格字符串
   * 如: "3:claude" -> { count: 3, type: 'claude', role: null }
   * 如: "2:codex:architect" -> { count: 2, type: 'codex', role: 'architect' }
   */
  parseSpec(spec) {
    const parts = spec.split(':')
    const count = parseInt(parts[0]) || 1
    const type = parts[1] || 'claude'
    const role = parts[2] || null

    return { count, type, role }
  }

  /**
   * 创建团队任务
   */
  createTeam(teamSpecs, description, options = {}) {
    const taskId = `team_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const workers = []

    // 解析规格并创建 worker
    const specs = Array.isArray(teamSpecs) ? teamSpecs : [teamSpecs]

    for (const spec of specs) {
      const { count, type, role } = this.parseSpec(spec)

      for (let i = 0; i < count; i++) {
        const workerId = `worker-${this.nextWorkerId++}`
        const worker = new TeamWorker(workerId, type, role, options)
        workers.push(worker)
      }
    }

    const task = new TeamTask(taskId, description, workers, options)
    this.tasks.set(taskId, task)
    this.activeTask = task

    return task
  }

  /**
   * 获取任务
   */
  getTask(taskId) {
    return this.tasks.get(taskId)
  }

  /**
   * 获取当前活动任务
   */
  getActiveTask() {
    return this.activeTask
  }

  /**
   * 关闭团队
   */
  shutdownTask(taskId) {
    const task = this.tasks.get(taskId)
    if (task) {
      task.state = TeamState.CANCELLED
      task.emit('shutdown')
      return true
    }
    return false
  }

  /**
   * 获取所有任务
   */
  getAllTasks() {
    return Array.from(this.tasks.values()).map(t => t.getStatus())
  }

  /**
   * 获取状态摘要
   */
  getStatus() {
    const tasks = this.getAllTasks()
    return {
      total: tasks.length,
      active: tasks.filter(t => t.state === TeamState.RUNNING).length,
      completed: tasks.filter(t => t.state === TeamState.COMPLETED).length,
      failed: tasks.filter(t => t.state === TeamState.FAILED).length,
      activeTask: this.activeTask?.getStatus() || null
    }
  }
}

// 导出单例
export const teamManager = new TeamManager()

export default teamManager
