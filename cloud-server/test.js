/**
 * 端到端测试
 *
 * 验证 cloud-server 健康运行
 */

import http from 'http'

const BASE_URL = 'http://localhost:8085'

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    return true
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    return false
  }
}

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
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
        try {
          const json = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(json)}`))
          } else {
            resolve(json)
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`))
        }
      })
    })

    req.on('error', reject)

    if (options.body) {
      const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      req.write(body)
    }
    req.end()
  })
}

async function runTests() {
  console.log('🧪 Cloud Server 端到端测试\n')

  let passed = 0
  let failed = 0

  // 1. 健康检查
  if (await test('健康检查', async () => {
    const res = await api('/health')
    if (res.status !== 'ok') throw new Error('Status: ' + res.status)
  })) passed++; else failed++

  // 2. Agent CRUD
  if (await test('创建 Agent', async () => {
    const res = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Agent', role: 'developer' })
    })
    if (!res.agent?.id) throw new Error('No agent ID')
    global.testAgentId = res.agent.id
  })) passed++; else failed++

  if (await test('获取 Agents', async () => {
    const res = await api('/api/agents')
    if (!Array.isArray(res.agents)) throw new Error('Not an array')
  })) passed++; else failed++

  // 3. Task CRUD
  if (await test('创建 Task', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test Task' })
    })
    if (!res.task?.id) throw new Error('No task ID')
    global.testTaskId = res.task.id
  })) passed++; else failed++

  if (await test('获取 Tasks', async () => {
    const res = await api('/api/tasks')
    if (!Array.isArray(res.tasks)) throw new Error('Not an array')
  })) passed++; else failed++

  if (await test('获取看板', async () => {
    const res = await api('/api/board')
    if (!res.board) throw new Error('No board')
  })) passed++; else failed++

  // 4. 状态更新
  if (await test('更新 Task 状态', async () => {
    await api(`/api/tasks/${global.testTaskId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'InDev' })
    })
  })) passed++; else failed++

  // 5. Skills
  if (await test('获取 Skills', async () => {
    const res = await api('/api/skills')
    if (!Array.isArray(res.skills)) throw new Error('Not skills array')
  })) passed++; else failed++

  if (await test('触发 Skill', async () => {
    const res = await api('/api/skills/trigger', {
      method: 'POST',
      body: JSON.stringify({ userMessage: '你好' })
    })
    if (typeof res.matched !== 'boolean') throw new Error('No matched field')
  })) passed++; else failed++

  // 6. Memory
  if (await test('获取 Memory 工具', async () => {
    const res = await api('/api/memory/tools')
    if (!Array.isArray(res.tools)) throw new Error('No tools array')
  })) passed++; else failed++

  if (await test('预取记忆', async () => {
    const res = await api('/api/memory/prefetch?q=test')
    if (typeof res.result !== 'string') throw new Error('No result')
  })) passed++; else failed++

  // 7. Roles
  if (await test('获取 Roles', async () => {
    const res = await api('/api/roles')
    if (!Array.isArray(res.roles)) throw new Error('No roles array')
  })) passed++; else failed++

  // 8. Team
  if (await test('创建 Team', async () => {
    const res = await api('/api/team', {
      method: 'POST',
      body: JSON.stringify({ specs: '2:claude', description: 'Test team' })
    })
    if (!res.task?.taskId) throw new Error('No task ID')
    global.testTeamId = res.task.taskId
  })) passed++; else failed++

  // 9. Autopilot
  if (await test('创建 Autopilot', async () => {
    const res = await api('/api/autopilot', {
      method: 'POST',
      body: JSON.stringify({ description: 'Test autopilot' })
    })
    if (!res.task?.taskId) throw new Error('No task ID')
    global.testAutopilotId = res.task.taskId
  })) passed++; else failed++

  // 10. TaskRunner
  if (await test('TaskRunner 状态', async () => {
    const res = await api('/api/taskrunner/status')
    if (!res.runners) throw new Error('No runners')
  })) passed++; else failed++

  if (await test('启动 TaskRunner', async () => {
    const res = await api(`/api/taskrunner/${global.testTaskId}/start`, {
      method: 'POST',
      body: JSON.stringify({})
    })
    if (!res.runner) throw new Error('No runner')
  })) passed++; else failed++

  // 11. Stats
  if (await test('获取统计', async () => {
    const res = await api('/api/stats')
    if (typeof res.totalTasks !== 'number') throw new Error('No stats')
  })) passed++; else failed++

  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`)

  if (failed > 0) {
    process.exit(1)
  }

  console.log('\n✅ 所有测试通过!')
}

runTests().catch(e => {
  console.error('测试失败:', e)
  process.exit(1)
})
