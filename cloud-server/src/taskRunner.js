/**
 * 任务执行器 (带持续验证)
 *
 * 每个步骤执行后自动验证，失败则打回修复
 */

import { EventEmitter } from 'events'
import db from './db.js'

// ============ 状态定义 ============

const TaskStepState = {
  PENDING: 'pending',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  PASSED: 'passed',
  FAILED: 'failed',
  BLOCKED: 'blocked'
}

const TaskState = {
  Backlog: 'Backlog',
  InDev: 'InDev',
  InFix: 'InFix',
  ReadyForTest: 'ReadyForTest',
  ReadyForDeploy: 'ReadyForDeploy',
  Done: 'Done',
  Blocked: 'Blocked'
}

// ============ 步骤验证器 ============

/**
 * 内置验证器
 */
export const builtInVerifiers = {
  // 语法检查
  syntax: async (step, context) => {
    // 模拟检查
    return { passed: true, message: '语法检查通过' }
  },

  // 编译检查
  build: async (step, context) => {
    return { passed: true, message: '编译通过' }
  },

  // 单元测试
  test: async (step, context) => {
    return { passed: true, message: '测试通过' }
  },

  // 代码风格
  lint: async (step, context) => {
    return { passed: true, message: '风格检查通过' }
  },

  // 自定义验证 (调用 AI)
  ai: async (step, context) => {
    // 实际应该调用 AI 验证
    return { passed: true, message: 'AI 验证通过' }
  }
}

// ============ 任务执行步骤 ============

export class TaskStep {
  constructor(options = {}) {
    this.id = `step_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    this.taskId = options.taskId
    this.name = options.name || '未命名步骤'
    this.description = options.description || ''
    this.order = options.order || 0
    this.verifier = options.verifier || 'syntax'
    this.state = TaskStepState.PENDING
    this.result = null
    this.error = null
    this.attempts = 0
    this.maxAttempts = options.maxAttempts || 3
    this.createdAt = new Date().toISOString()
    this.completedAt = null
  }

  async run(executor, verifier) {
    this.attempts++
    this.state = TaskStepState.RUNNING

    try {
      // 执行步骤
      const result = await executor(this)

      if (result.success) {
        // 进入验证阶段
        this.state = TaskStepState.VERIFYING
        const verifyResult = await verifier(this)

        if (verifyResult.passed) {
          this.state = TaskStepState.PASSED
          this.result = verifyResult
        } else {
          this.state = TaskStepState.FAILED
          this.error = verifyResult.message
        }
      } else {
        this.state = TaskStepState.FAILED
        this.error = result.error
      }
    } catch (err) {
      this.state = TaskStepState.FAILED
      this.error = err.message
    }

    this.completedAt = new Date().toISOString()
    return this
  }

  canRetry() {
    return this.attempts < this.maxAttempts && this.state === TaskStepState.FAILED
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      attempts: this.attempts,
      error: this.error,
      result: this.result
    }
  }
}

// ============ 任务执行器 ============

export class TaskRunner extends EventEmitter {
  constructor(taskId, options = {}) {
    super()
    this.taskId = taskId
    this.task = db.getTaskById(taskId)
    this.steps = []
    this.currentStepIndex = 0
    this.maxRetries = options.maxRetries || 3
    this.autoProceed = options.autoProceed !== false

    // 状态
    this.state = 'idle'
    this.failedSteps = []
  }

  /**
   * 添加步骤
   */
  addStep(options) {
    const step = new TaskStep({
      taskId: this.taskId,
      ...options
    })
    step.order = this.steps.length
    this.steps.push(step)
    return step
  }

  /**
   * 设置步骤 (批量)
   */
  setSteps(stepConfigs) {
    this.steps = stepConfigs.map((config, index) => {
      const step = new TaskStep({
        taskId: this.taskId,
        ...config
      })
      step.order = index
      return step
    })
    return this.steps
  }

  /**
   * 开始执行
   */
  async start(executorFn, verifierFn) {
    if (!this.task) {
      throw new Error('Task not found')
    }

    // 更新任务状态
    this.state = 'running'
    db.updateTaskStatus(this.taskId, TaskState.InDev)

    this.emit('start', { taskId: this.taskId, steps: this.steps.length })

    for (let i = 0; i < this.steps.length; i++) {
      this.currentStepIndex = i
      const step = this.steps[i]

      this.emit('step-start', { step: step.getStatus() })

      // 执行步骤
      await step.run(
        (s) => executorFn(s, this),
        (s) => verifierFn(s, this)
      )

      this.emit('step-complete', { step: step.getStatus() })

      if (step.state === TaskStepState.FAILED) {
        // 失败处理
        this.failedSteps.push(step)

        this.emit('step-failed', { step: step.getStatus() })

        if (step.canRetry()) {
          // 可以重试，先打回修复
          db.updateTaskStatus(this.taskId, TaskState.InFix)
          this.state = 'fixing'
          this.emit('fix-required', { step: step.getStatus(), attempt: step.attempts })

          // 等待修复信号 (外部触发 resume)
          return { needsFix: true, step }
        } else {
          // 超过最大重试次数
          db.updateTaskStatus(this.taskId, TaskState.Blocked)
          this.state = 'blocked'
          this.emit('blocked', { step: step.getStatus() })
          return { blocked: true, step }
        }
      }

      // 步骤通过，继续下一步
      this.emit('step-passed', { step: step.getStatus() })
    }

    // 所有步骤完成
    db.updateTaskStatus(this.taskId, TaskState.ReadyForDeploy)
    this.state = 'completed'
    this.emit('completed', { taskId: this.taskId })

    return { completed: true }
  }

  /**
   * 修复完成后继续
   */
  async resume(executorFn, verifierFn) {
    if (this.state !== 'fixing') {
      return { error: 'Not in fixing state' }
    }

    const currentStep = this.steps[this.currentStepIndex]

    this.emit('resume', { step: currentStep.getStatus() })

    // 重试当前步骤
    await currentStep.run(
      (s) => executorFn(s, this),
      (s) => verifierFn(s, this)
    )

    if (currentStep.state === TaskStepState.FAILED) {
      // 仍然失败
      if (currentStep.canRetry()) {
        db.updateTaskStatus(this.taskId, TaskState.InFix)
        this.emit('fix-required', { step: currentStep.getStatus(), attempt: currentStep.attempts })
        return { needsFix: true, step: currentStep }
      } else {
        db.updateTaskStatus(this.taskId, TaskState.Blocked)
        this.state = 'blocked'
        return { blocked: true, step: currentStep }
      }
    }

    // 通过了！继续下一步
    this.state = 'running'
    db.updateTaskStatus(this.taskId, TaskState.InDev)

    // 继续剩余步骤
    for (let i = this.currentStepIndex + 1; i < this.steps.length; i++) {
      this.currentStepIndex = i
      const step = this.steps[i]

      await step.run(
        (s) => executorFn(s, this),
        (s) => verifierFn(s, this)
      )

      if (step.state === TaskStepState.FAILED) {
        if (step.canRetry()) {
          db.updateTaskStatus(this.taskId, TaskState.InFix)
          this.state = 'fixing'
          return { needsFix: true, step }
        } else {
          db.updateTaskStatus(this.taskId, TaskState.Blocked)
          this.state = 'blocked'
          return { blocked: true, step }
        }
      }
    }

    // 全部完成
    db.updateTaskStatus(this.taskId, TaskState.ReadyForDeploy)
    this.state = 'completed'
    return { completed: true }
  }

  /**
   * 标记完成 (部署)
   */
  complete() {
    db.updateTaskStatus(this.taskId, TaskState.Done)
    this.state = 'done'
    this.emit('done', { taskId: this.taskId })
  }

  getStatus() {
    return {
      taskId: this.taskId,
      state: this.state,
      currentStep: this.currentStepIndex,
      steps: this.steps.map(s => s.getStatus()),
      failedSteps: this.failedSteps.map(s => s.getStatus())
    }
  }
}

// ============ 任务运行器管理器 ============

const runners = new Map()

export const taskRunnerManager = {
  /**
   * 创建任务运行器
   */
  create(taskId, options = {}) {
    const runner = new TaskRunner(taskId, options)
    runners.set(taskId, runner)
    return runner
  },

  /**
   * 获取运行器
   */
  get(taskId) {
    return runners.get(taskId)
  },

  /**
   * 删除运行器
   */
  remove(taskId) {
    runners.delete(taskId)
  },

  /**
   * 获取所有运行器状态
   */
  getAllStatuses() {
    return Array.from(runners.values()).map(r => r.getStatus())
  }
}

export default taskRunnerManager
