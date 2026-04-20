import {
  getBoard,
  getOnlineAgents,
  claimTask,
  updateTaskStatus,
  createTask,
  reportBug,
  appendLog,
  getStats,
  Agent,
  Task,
  TaskStatus
} from './client'

// 调度器运行器
export class SchedulerRunner {
  private agentId: string
  private agentName: string
  private agentRole: string
  private running: boolean = false
  private heartbeatTimer?: NodeJS.Timeout
  private pollTimer?: NodeJS.Timeout

  constructor(agentId: string, agentName: string, agentRole: string) {
    this.agentId = agentId
    this.agentName = agentName
    this.agentRole = agentRole
  }

  // 启动调度器
  start(heartbeatInterval: number = 10_000, pollInterval: number = 5_000): void {
    if (this.running) return
    this.running = true

    // 启动心跳
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, heartbeatInterval)

    // 启动轮询
    this.pollTimer = setInterval(() => {
      this.pollTasks()
    }, pollInterval)

    // 立即执行一次
    this.sendHeartbeat()
    this.pollTasks()

    console.log(`[SchedulerRunner] Started for ${this.agentName} (${this.agentRole})`)
  }

  // 停止调度器
  stop(): void {
    this.running = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }

    console.log(`[SchedulerRunner] Stopped`)
  }

  // 发送心跳
  private async sendHeartbeat(): Promise<void> {
    try {
      const { heartbeat } = await import('./client')
      await heartbeat(this.agentId)
      console.log(`[Heartbeat] Sent for ${this.agentName}`)
    } catch (e) {
      console.error(`[Heartbeat] Failed:`, e)
    }
  }

  // 轮询任务
  private async pollTasks(): Promise<void> {
    try {
      const board = await getBoard()
      const devs = await getOnlineAgents()

      console.log(`[Poll] Board status:`, {
        backlog: board.Backlog.length,
        inDev: board.InDev.length,
        readyForTest: board.ReadyForTest.length,
        inFix: board.InFix.length,
        readyForDeploy: board.ReadyForDeploy.length
      })

      // 根据角色处理任务
      switch (this.agentRole) {
        case 'developer':
          await this.handleDevTasks(board)
          break
        case 'tester':
          await this.handleQATasks(board)
          break
        case 'deployer':
          await this.handleDeployTasks(board)
          break
      }
    } catch (e) {
      console.error(`[Poll] Error:`, e)
    }
  }

  // Dev Agent 处理任务
  private async handleDevTasks(board: Awaited<ReturnType<typeof getBoard>>): Promise<void> {
    // 优先处理 InFix
    if (board.InFix.length > 0) {
      const task = board.InFix[0]
      console.log(`[Dev] Processing InFix task: ${task.title}`)

      try {
        await claimTask(task.id, this.agentId)
        console.log(`[Dev] Claimed task: ${task.id}`)

        // 记录开发开始
        await appendLog(task.id, this.agentId, 'dev_start', `开始修复 Bug: ${task.bugReport || '无'}`)
      } catch (e) {
        // 可能已被其他 Agent 认领
        console.log(`[Dev] Could not claim task: ${task.id}`)
      }
      return
    }

    // 处理 Backlog
    if (board.Backlog.length > 0) {
      const task = board.Backlog[0]
      console.log(`[Dev] Processing Backlog task: ${task.title}`)

      try {
        await claimTask(task.id, this.agentId)
        console.log(`[Dev] Claimed task: ${task.id}`)
        await appendLog(task.id, this.agentId, 'dev_start', '开始开发')
      } catch (e) {
        console.log(`[Dev] Could not claim task: ${task.id}`)
      }
    }
  }

  // QA Agent 处理任务
  private async handleQATasks(board: Awaited<ReturnType<typeof getBoard>>): Promise<void> {
    if (board.ReadyForTest.length > 0) {
      const task = board.ReadyForTest[0]
      console.log(`[QA] Testing task: ${task.title}`)

      // 模拟测试
      // 实际应该执行真实测试
      await appendLog(task.id, this.agentId, 'test_start', '开始测试')

      // 模拟测试结果（60% 通过，40% 失败）
      const passed = Math.random() > 0.4

      if (passed) {
        await updateTaskStatus(task.id, 'ReadyForDeploy')
        console.log(`[QA] Test passed: ${task.id}`)
      } else {
        await reportBug(task.id, '测试发现功能异常')
        console.log(`[QA] Test failed: ${task.id}`)
      }
    }
  }

  // Deploy Agent 处理任务
  private async handleDeployTasks(board: Awaited<ReturnType<typeof getBoard>>): Promise<void> {
    if (board.ReadyForDeploy.length > 0) {
      const task = board.ReadyForDeploy[0]
      console.log(`[Deploy] Deploying task: ${task.title}`)

      await appendLog(task.id, this.agentId, 'deploy_start', '开始部署')

      // 模拟部署
      await updateTaskStatus(task.id, 'Done')
      console.log(`[Deploy] Deployed: ${task.id}`)
    }
  }

  // 获取状态
  getStatus() {
    return {
      running: this.running,
      agentId: this.agentId,
      agentName: this.agentName,
      agentRole: this.agentRole
    }
  }
}

// 创建 Dev Agent 运行器
export async function createDevRunner(): Promise<SchedulerRunner> {
  const { registerAgent } = await import('./client')

  // 注册 Dev Agent
  const agent = await registerAgent('Dev-Runner', 'developer', ['frontend', 'backend', 'bug-fix'])

  return new SchedulerRunner(agent.id, agent.name, 'developer')
}

// 创建 QA Runner
export async function createQARunner(): Promise<SchedulerRunner> {
  const { registerAgent } = await import('./client')

  const agent = await registerAgent('QA-Runner', 'tester', ['testing', 'quality-assurance'])

  return new SchedulerRunner(agent.id, agent.name, 'tester')
}

// 创建 Deploy Runner
export async function createDeployRunner(): Promise<SchedulerRunner> {
  const { registerAgent } = await import('./client')

  const agent = await registerAgent('Deploy-Runner', 'deployer', ['devops', 'deployment'])

  return new SchedulerRunner(agent.id, agent.name, 'deployer')
}
