/**
 * Ultraqa 模式 - QA 循环测试
 *
 * 测试 -> 验证 -> 修复 -> 重复 直到目标达成
 */

import { EventEmitter } from 'events'

/**
 * QA 循环状态
 */
export const QAState = {
  IDLE: 'idle',
  TESTING: 'testing',
  VERIFYING: 'verifying',
  FIXING: 'fixing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  MAX_LOOPS: 'max_loops'
}

/**
 * QA 测试结果
 */
export class QAResult {
  constructor() {
    this.tests = []
    this.passed = 0
    this.failed = 0
    this.fixes = 0
    this.loops = 0
  }

  addTest(test) {
    this.tests.push(test)
    if (test.passed) {
      this.passed++
    } else {
      this.failed++
    }
  }

  addFix(fix) {
    this.fixes++
  }

  getSummary() {
    return {
      total: this.tests.length,
      passed: this.passed,
      failed: this.failed,
      fixes: this.fixes,
      loops: this.loops,
      passRate: this.tests.length > 0 ? (this.passed / this.tests.length * 100).toFixed(1) + '%' : '0%'
    }
  }
}

/**
 * Ultraqa 任务
 */
export class UltraqaTask extends EventEmitter {
  constructor(taskId, goal, options = {}) {
    super()
    this.taskId = taskId
    this.goal = goal
    this.maxLoops = options.maxLoops || 10
    this.state = QAState.IDLE
    this.result = new QAResult()
    this.currentPhase = null
  }

  /**
   * 开始 QA 循环
   */
  async start(tester, fixer, verifier) {
    this.state = QAState.TESTING
    this.emit('start', { goal: this.goal })

    try {
      while (this.result.loops < this.maxLoops) {
        this.result.loops++

        // Phase 1: 测试
        this.currentPhase = 'testing'
        this.emit('phase', { phase: 'testing', loop: this.result.loops })

        const testResults = await tester.test(this.goal, this.result)

        for (const test of testResults) {
          this.result.addTest(test)
        }

        this.emit('test-results', { tests: testResults, summary: this.result.getSummary() })

        // 检查是否全部通过
        if (this.result.failed === 0) {
          this.state = QAState.COMPLETED
          this.emit('complete', { result: this.result })
          break
        }

        // Phase 2: 修复
        this.currentPhase = 'fixing'
        this.emit('phase', { phase: 'fixing', loop: this.result.loops })

        const failedTests = this.result.tests.filter(t => !t.passed)

        for (const test of failedTests) {
          const fixResult = await fixer.fix(test, this.result)

          if (fixResult.fixed) {
            this.result.addFix(fixResult)
          }
        }

        this.emit('fix-results', { fixes: this.result.fixes })

        // Phase 3: 验证
        this.currentPhase = 'verifying'
        this.emit('phase', { phase: 'verifying', loop: this.result.loops })

        if (verifier) {
          const verified = await verifier.verify(this.goal, this.result)

          if (!verified) {
            this.state = QAState.FAILED
            this.emit('failed', { reason: '验证未通过', result: this.result })
            break
          }
        }
      }

      if (this.result.loops >= this.maxLoops && this.state !== QAState.COMPLETED) {
        this.state = QAState.MAX_LOOPS
        this.emit('max-loops', { loops: this.result.loops, result: this.result })
      }
    } catch (error) {
      this.state = QAState.FAILED
      this.emit('error', { error: error.message, result: this.result })
    }

    return this
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      taskId: this.taskId,
      goal: this.goal,
      state: this.state,
      currentPhase: this.currentPhase,
      result: this.result.getSummary()
    }
  }
}

/**
 * Ultraqa 管理器
 */
export class UltraqaManager {
  constructor() {
    this.tasks = new Map()
    this.activeTask = null
  }

  /**
   * 创建 QA 任务
   */
  createTask(goal, options = {}) {
    const taskId = `qa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const task = new UltraqaTask(taskId, goal, options)
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
   * 取消任务
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId)
    if (task) {
      task.state = QAState.FAILED
      task.emit('cancelled')
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
      active: tasks.filter(t => t.state !== QAState.COMPLETED && t.state !== QAState.FAILED).length,
      completed: tasks.filter(t => t.state === QAState.COMPLETED).length,
      failed: tasks.filter(t => t.state === QAState.FAILED).length,
      activeTask: this.activeTask?.getStatus() || null
    }
  }
}

// 导出单例
export const ultraqaManager = new UltraqaManager()

export default ultraqaManager
