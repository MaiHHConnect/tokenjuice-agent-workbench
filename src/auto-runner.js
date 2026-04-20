/**
 * 自动 Agent Runner
 *
 * 自动启动 Dev/QA/Deploy Agent 并自动处理任务
 */

import http from 'http'

const API_BASE = 'localhost'
const API_PORT = 6666

// ============ HTTP 客户端 ============

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://${API_BASE}:${API_PORT}`)

    const reqOptions = {
      hostname: API_BASE,
      port: API_PORT,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }

    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API Error: ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(data)
        }
      })
    })

    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

// ============ Agent Runner ============

class AgentRunner {
  constructor(name, role, capabilities = []) {
    this.name = name
    this.role = role
    this.capabilities = capabilities
    this.agentId = null
    this.running = false
    this.heartbeatTimer = null
    this.pollTimer = null
  }

  async register() {
    const result = await request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: this.name,
        role: this.role,
        capabilities: this.capabilities
      })
    })
    this.agentId = result.agent.id
    console.log(`[${this.name}] Registered with ID: ${this.agentId}`)
    return this.agentId
  }

  async heartbeat() {
    if (!this.agentId) return
    try {
      await request(`/api/agents/${this.agentId}/heartbeat`, { method: 'POST' })
    } catch (e) {
      console.error(`[${this.name}] Heartbeat failed:`, e.message)
    }
  }

  async getBoard() {
    const result = await request('/api/board')
    return result.board
  }

  async claimTask(taskId) {
    const result = await request(`/api/tasks/${taskId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId })
    })
    return result.task
  }

  async updateStatus(taskId, status) {
    const result = await request(`/api/tasks/${taskId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    })
    return result.task
  }

  async appendLog(taskId, action, message) {
    await request(`/api/tasks/${taskId}/logs`, {
      method: 'POST',
      body: JSON.stringify({ agentId: this.agentId, action, message })
    })
  }

  async findAndClaimTask() {
    const board = await this.getBoard()

    // 根据角色决定优先级
    const priorityOrder = this.getPriorityOrder()

    for (const status of priorityOrder) {
      const tasks = board[status]
      for (const task of tasks) {
        if (!task.assignedAgentId) {
          try {
            const claimed = await this.claimTask(task.id)
            console.log(`[${this.name}] Claimed task: ${task.title} (${status})`)
            return claimed
          } catch (e) {
            // 可能已被其他 Agent 认领
          }
        }
      }
    }
    return null
  }

  getPriorityOrder() {
    switch (this.role) {
      case 'developer':
        return ['InFix', 'Blocked', 'Backlog']
      case 'tester':
        return ['ReadyForTest']
      case 'deployer':
        return ['ReadyForDeploy']
      default:
        return ['Backlog']
    }
  }

  async processTask(task) {
    // 子类实现具体处理逻辑
    throw new Error('processTask must be implemented')
  }

  async tick() {
    if (!this.agentId) return

    const task = await this.findAndClaimTask()
    if (task) {
      await this.processTask(task)
    }
  }

  start(heartbeatInterval = 10_000, pollInterval = 5_000) {
    if (this.running) return
    this.running = true

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat()
    }, heartbeatInterval)

    this.pollTimer = setInterval(() => {
      this.tick()
    }, pollInterval)

    // 立即执行一次
    this.heartbeat()
    this.tick()

    console.log(`[${this.name}] Started (role: ${this.role})`)
  }

  stop() {
    this.running = false

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    console.log(`[${this.name}] Stopped`)
  }
}

// ============ Dev Agent Runner ============

class DevRunner extends AgentRunner {
  async processTask(task) {
    console.log(`[${this.name}] Processing: ${task.title}`)

    // 记录开始
    await this.appendLog(task.id, 'dev_start', `开始处理任务`)

    // 模拟开发过程
    await new Promise(r => setTimeout(r, 2000))

    // 完成开发
    await this.updateStatus(task.id, 'ReadyForTest')
    console.log(`[${this.name}] Completed: ${task.title} -> ReadyForTest`)

    await this.appendLog(task.id, 'dev_complete', `开发完成，提交测试`)
  }
}

// ============ QA Agent Runner ============

class QARunner extends AgentRunner {
  async processTask(task) {
    console.log(`[${this.name}] Testing: ${task.title}`)

    await this.appendLog(task.id, 'test_start', `开始测试`)

    // 模拟测试过程
    await new Promise(r => setTimeout(r, 1000))

    // 模拟测试结果 (70% 通过, 30% 失败)
    const passed = Math.random() > 0.3

    if (passed) {
      await this.updateStatus(task.id, 'ReadyForDeploy')
      console.log(`[${this.name}] Test passed: ${task.title} -> ReadyForDeploy`)
      await this.appendLog(task.id, 'test_pass', `测试通过`)
    } else {
      // 报告 Bug
      const bugReport = '测试发现功能异常'
      await request(`/api/tasks/${task.id}/bug`, {
        method: 'POST',
        body: JSON.stringify({ bugReport })
      })
      console.log(`[${this.name}] Test failed: ${task.title} -> InFix`)
      await this.appendLog(task.id, 'test_fail', bugReport)
    }
  }
}

// ============ Deploy Agent Runner ============

class DeployRunner extends AgentRunner {
  async processTask(task) {
    console.log(`[${this.name}] Deploying: ${task.title}`)

    await this.appendLog(task.id, 'deploy_start', `开始部署`)

    // 模拟部署过程
    await new Promise(r => setTimeout(r, 1500))

    // 完成部署
    await this.updateStatus(task.id, 'Done')
    console.log(`[${this.name}] Deployed: ${task.title} -> Done`)

    await this.appendLog(task.id, 'deploy_complete', `部署完成`)
  }
}

// ============ 主程序 ============

async function main() {
  console.log('='.repeat(50))
  console.log('自动 Agent Runner 启动')
  console.log('='.repeat(50))

  // 创建并启动 Dev Agent
  const devRunner = new DevRunner('Dev-Auto-1', 'developer', ['frontend', 'backend'])
  await devRunner.register()
  devRunner.start()

  // 创建并启动 QA Agent
  const qaRunner = new QARunner('QA-Auto-1', 'tester', ['testing'])
  await qaRunner.register()
  qaRunner.start()

  // 创建并启动 Deploy Agent
  const deployRunner = new DeployRunner('Deploy-Auto-1', 'deployer', ['devops'])
  await deployRunner.register()
  deployRunner.start()

  console.log('='.repeat(50))
  console.log('所有 Agent 已启动，按 Ctrl+C 停止')
  console.log('='.repeat(50))

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n正在停止所有 Agent...')
    devRunner.stop()
    qaRunner.stop()
    deployRunner.stop()
    process.exit(0)
  })
}

main().catch(console.error)
