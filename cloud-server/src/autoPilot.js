/**
 * 自动驾驶模式 (Autopilot)
 *
 * 自动执行任务直到完成
 */

import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import db from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, '..', 'data')
const DATA_FILE = path.join(DATA_DIR, 'autopilot.json')

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

function loadAutoPilotData() {
  if (!existsSync(DATA_FILE)) {
    return { tasks: [] }
  }

  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
  } catch (error) {
    console.error('[AutoPilot] Failed to load persisted state:', error.message)
    return { tasks: [] }
  }
}

function saveAutoPilotData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function buildAutoPilotTitle(description, mode, explicitTitle = '') {
  const preferred = String(explicitTitle || '').trim()
  if (preferred) return preferred

  const firstLine = String(description || '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || '未命名任务'

  const prefix = mode === 'ralph' ? '[Ralph]' : '[Autopilot]'
  return `${prefix} ${firstLine}`.slice(0, 80)
}

/**
 * 自动驾驶模式状态
 */
export const AutoPilotState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
}

/**
 * 自动驾驶任务
 */
export class AutoPilotTask extends EventEmitter {
  constructor(taskId, description, options = {}) {
    super()
    this.taskId = taskId
    this.description = description
    this.mode = options.mode || 'autopilot'
    this.linkedTaskId = options.linkedTaskId || null
    this.maxIterations = options.maxIterations || 50
    this.verifyEachStep = options.verifyEachStep || false
    this.pauseOnError = options.pauseOnError || false
    this.iteration = 0
    this.state = options.state || AutoPilotState.IDLE
    this.steps = Array.isArray(options.steps) ? options.steps : []
    this.result = null
    this.error = null
    this.createdAt = options.createdAt || new Date().toISOString()
    this.updatedAt = options.updatedAt || this.createdAt
  }

  /**
   * 开始执行
   */
  async start(agent) {
    this.state = AutoPilotState.RUNNING
    this.emit('start', this)

    try {
      while (this.iteration < this.maxIterations && this.state === AutoPilotState.RUNNING) {
        this.iteration++
        this.emit('iteration', { iteration: this.iteration, max: this.maxIterations })

        // 执行一步
        const stepResult = await this.executeStep(agent)

        if (stepResult.done) {
          this.result = stepResult.result
          this.state = AutoPilotState.COMPLETED
          this.emit('complete', this.result)
          break
        }

        if (stepResult.error) {
          this.error = stepResult.error
          if (this.pauseOnError) {
            this.state = AutoPilotState.PAUSED
            this.emit('error', this.error)
          } else {
            this.state = AutoPilotState.FAILED
            this.emit('failed', this.error)
          }
          break
        }

        // 保存步骤
        this.steps.push({
          iteration: this.iteration,
          action: stepResult.action,
          result: stepResult.result
        })
      }

      if (this.iteration >= this.maxIterations && this.state === AutoPilotState.RUNNING) {
        this.state = AutoPilotState.COMPLETED
        this.emit('max-iterations', { iterations: this.iteration })
      }
    } catch (error) {
      this.error = error
      this.state = AutoPilotState.FAILED
      this.emit('failed', error)
    }

    return this
  }

  /**
   * 执行一步
   */
  async executeStep(agent) {
    // 通知 agent 执行下一步
    this.emit('step-start', { iteration: this.iteration })

    try {
      const result = await agent.execute(this.description, {
        iteration: this.iteration,
        steps: this.steps
      })

      if (result.done) {
        return { done: true, result: result.output }
      }

      if (result.error) {
        return { done: false, error: result.error }
      }

      return { done: false, result: result.output, action: result.action }
    } catch (error) {
      return { done: false, error: error.message }
    }
  }

  /**
   * 暂停
   */
  pause() {
    if (this.state === AutoPilotState.RUNNING) {
      this.state = AutoPilotState.PAUSED
      this.emit('pause')
    }
  }

  /**
   * 恢复
   */
  resume() {
    if (this.state === AutoPilotState.PAUSED) {
      this.state = AutoPilotState.RUNNING
      this.emit('resume')
    }
  }

  /**
   * 取消
   */
  cancel() {
    this.state = AutoPilotState.CANCELLED
    this.emit('cancel')
  }

  /**
   * 获取状态
   */
  getStatus() {
    const linkedTask = this.linkedTaskId ? db.getTaskById(this.linkedTaskId) : null
    return {
      taskId: this.taskId,
      mode: this.mode,
      description: this.description,
      state: this.state,
      linkedTaskId: this.linkedTaskId,
      linkedTaskStatus: linkedTask?.status || null,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      stepsCount: this.steps.length,
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }
}

/**
 * Ralph 模式 - 带验证的循环执行
 */
export class RalphTask extends AutoPilotTask {
  constructor(taskId, description, options = {}) {
    super(taskId, description, {
      ...options,
      maxIterations: options.maxIterations || 100,
      verifyEachStep: true
    })
    this.verifier = options.verifier || null
    this.verificationCount = 0
  }

  async executeStep(agent) {
    const stepResult = await super.executeStep(agent)

    if (stepResult.done && this.verifier) {
      // 验证结果
      this.verificationCount++
      const verified = await this.verifier.verify(stepResult.result, this.description)

      if (!verified) {
        return {
          done: false,
          error: `验证失败 (第 ${this.verificationCount} 次验证)`
        }
      }

      this.emit('verified', { iteration: this.iteration, result: stepResult.result })
    }

    return stepResult
  }
}

/**
 * Autopilot 管理器
 */
export class AutoPilotManager {
  constructor() {
    this._data = loadAutoPilotData()
    this.tasks = new Map()
    this.activeTask = null
    this.hydrateTasks()
  }

  hydrateTasks() {
    const records = Array.isArray(this._data.tasks) ? this._data.tasks : []
    this.tasks = new Map(records.map(record => {
      const task = new AutoPilotTask(record.taskId, record.description, record)
      task.iteration = record.iteration || 0
      task.result = record.result || null
      task.error = record.error || null
      return [task.taskId, task]
    }))
    this.activeTask = Array.from(this.tasks.values()).find(task => task.state === AutoPilotState.RUNNING) || null
  }

  persist() {
    this._data.tasks = Array.from(this.tasks.values()).map(task => ({
      taskId: task.taskId,
      description: task.description,
      mode: task.mode,
      linkedTaskId: task.linkedTaskId,
      maxIterations: task.maxIterations,
      verifyEachStep: task.verifyEachStep,
      pauseOnError: task.pauseOnError,
      iteration: task.iteration,
      state: task.state,
      steps: task.steps,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }))
    saveAutoPilotData(this._data)
  }

  syncTaskState(task) {
    if (!task) return null

    const linkedTask = task.linkedTaskId ? db.getTaskById(task.linkedTaskId) : null
    if (!linkedTask) {
      if (![AutoPilotState.CANCELLED, AutoPilotState.COMPLETED, AutoPilotState.FAILED].includes(task.state)) {
        task.state = AutoPilotState.FAILED
        task.error = '关联任务不存在'
        task.updatedAt = new Date().toISOString()
        this.persist()
      }
      return task
    }

    if (task.state === AutoPilotState.RUNNING || task.state === AutoPilotState.PAUSED) {
      if (linkedTask.status === 'Done') {
        task.state = AutoPilotState.COMPLETED
        task.result = `关联任务 ${linkedTask.id} 已完成`
        task.updatedAt = new Date().toISOString()
        this.persist()
      } else if (linkedTask.status === 'Blocked' && task.state === AutoPilotState.RUNNING) {
        task.state = AutoPilotState.FAILED
        task.error = linkedTask.blockedReason || '关联任务进入 Blocked'
        task.updatedAt = new Date().toISOString()
        this.persist()
      }
    }

    return task
  }

  /**
   * 创建并启动任务
   */
  createTask(description, options = {}) {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const linkedTask = db.createTask({
      title: buildAutoPilotTitle(description, 'autopilot', options.title),
      description,
      skills: Array.isArray(options.skills) ? options.skills : []
    })
    db.addTaskLog(linkedTask.id, {
      action: '自动驾驶',
      message: 'Autopilot 已创建并进入调度队列'
    })

    const task = new AutoPilotTask(taskId, description, {
      ...options,
      mode: 'autopilot',
      linkedTaskId: linkedTask.id,
      state: AutoPilotState.RUNNING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    this.tasks.set(taskId, task)
    this.activeTask = task
    this.persist()
    return task
  }

  /**
   * 创建 Ralph 任务
   */
  createRalphTask(description, options = {}) {
    const taskId = `ralph_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const linkedTask = db.createTask({
      title: buildAutoPilotTitle(description, 'ralph', options.title),
      description,
      skills: Array.isArray(options.skills) ? options.skills : []
    })
    db.addTaskLog(linkedTask.id, {
      action: '自动驾驶',
      message: 'Ralph 模式已创建并进入调度队列'
    })

    const task = new RalphTask(taskId, description, {
      ...options,
      mode: 'ralph',
      linkedTaskId: linkedTask.id,
      state: AutoPilotState.RUNNING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    this.tasks.set(taskId, task)
    this.activeTask = task
    this.persist()
    return task
  }

  /**
   * 获取任务
   */
  getTask(taskId) {
    return this.syncTaskState(this.tasks.get(taskId))
  }

  /**
   * 获取当前活动任务
   */
  getActiveTask() {
    return this.syncTaskState(this.activeTask)
  }

  /**
   * 暂停任务
   */
  pauseTask(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return false

    const linkedTask = task.linkedTaskId ? db.getTaskById(task.linkedTaskId) : null
    if (linkedTask && !['Done', 'Blocked'].includes(linkedTask.status)) {
      db.updateTaskStatus(linkedTask.id, 'Collecting')
      db.addTaskLog(linkedTask.id, {
        action: '自动驾驶',
        message: 'Autopilot 已暂停'
      })
    }

    task.state = AutoPilotState.PAUSED
    task.updatedAt = new Date().toISOString()
    this.persist()
    return true
  }

  resumeTask(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return false

    const linkedTask = task.linkedTaskId ? db.getTaskById(task.linkedTaskId) : null
    if (linkedTask && linkedTask.status === 'Collecting') {
      db.updateTaskStatus(linkedTask.id, 'Backlog')
      db.addTaskLog(linkedTask.id, {
        action: '自动驾驶',
        message: 'Autopilot 已恢复'
      })
    }

    task.state = AutoPilotState.RUNNING
    task.updatedAt = new Date().toISOString()
    this.activeTask = task
    this.persist()
    return true
  }

  /**
   * 取消任务
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return false

    const linkedTask = task.linkedTaskId ? db.getTaskById(task.linkedTaskId) : null
    if (linkedTask && !['Done', 'Blocked'].includes(linkedTask.status)) {
      db.updateTaskStatus(linkedTask.id, 'Blocked')
      const refreshedTask = db.getTaskById(linkedTask.id)
      if (refreshedTask) {
        refreshedTask.blockedReason = 'Autopilot 已取消'
        refreshedTask.updatedAt = new Date().toISOString()
        db.save()
      }
      db.addTaskLog(linkedTask.id, {
        action: '自动驾驶',
        message: 'Autopilot 已取消'
      })
    }

    task.cancel()
    task.updatedAt = new Date().toISOString()
    this.persist()
    return true
  }

  /**
   * 获取所有任务
   */
  getAllTasks() {
    return Array.from(this.tasks.values())
      .map(task => this.syncTaskState(task))
      .filter(Boolean)
      .map(t => t.getStatus())
  }

  /**
   * 获取状态摘要
   */
  getStatus() {
    const tasks = this.getAllTasks()
    return {
      total: tasks.length,
      active: tasks.filter(t => t.state === AutoPilotState.RUNNING).length,
      completed: tasks.filter(t => t.state === AutoPilotState.COMPLETED).length,
      failed: tasks.filter(t => t.state === AutoPilotState.FAILED).length,
      activeTask: this.activeTask?.getStatus() || null
    }
  }
}

// 导出单例
export const autoPilotManager = new AutoPilotManager()

export default autoPilotManager
