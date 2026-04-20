/**
 * 调度器 MCP Server
 *
 * 提供 MCP 协议接口供 Claude Code 调用调度器功能
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

// ============ MCP 工具定义 ============

const tools = [
  {
    name: 'kanban_register_task',
    description: '注册新任务到看板，用于 PM 拆解需求后创建任务',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题' },
        description: { type: 'string', description: '任务描述（可选）' },
        skills: { type: 'array', items: { type: 'string' }, description: '技能标签（可选）' }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_get_board',
    description: '获取完整看板视图，展示所有列及其任务',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'kanban_get_tasks',
    description: '获取任务列表，支持按状态过滤',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Backlog', 'InDev', 'ReadyForTest', 'InFix', 'ReadyForDeploy', 'Done', 'Blocked'],
          description: '按状态过滤（可选）'
        }
      }
    }
  },
  {
    name: 'kanban_claim_task',
    description: 'Agent 认领一个任务，开始处理',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        agentId: { type: 'string', description: 'Agent ID' }
      },
      required: ['taskId', 'agentId']
    }
  },
  {
    name: 'kanban_update_status',
    description: '更新任务状态',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        status: {
          type: 'string',
          enum: ['Backlog', 'InDev', 'ReadyForTest', 'InFix', 'ReadyForDeploy', 'Done', 'Blocked'],
          description: '新状态'
        }
      },
      required: ['taskId', 'status']
    }
  },
  {
    name: 'kanban_report_bug',
    description: 'QA 报告 Bug，导致任务进入 InFix 状态',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        bugReport: { type: 'string', description: 'Bug 描述' }
      },
      required: ['taskId', 'bugReport']
    }
  },
  {
    name: 'kanban_register_agent',
    description: '注册新 Agent 到调度器',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent 名称' },
        role: {
          type: 'string',
          enum: ['pm', 'developer', 'tester', 'deployer'],
          description: 'Agent 角色'
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: '能力标签（可选）'
        }
      },
      required: ['name', 'role']
    }
  },
  {
    name: 'kanban_heartbeat',
    description: 'Agent 发送心跳，证明仍然存活',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'kanban_get_agents',
    description: '获取所有在线 Agent',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'kanban_get_stats',
    description: '获取看板统计信息',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
]

// ============ 工具执行 ============

async function executeTool(name, args) {
  switch (name) {
    case 'kanban_register_task': {
      const { title, description, skills = [] } = args
      const result = await request('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, description, skills })
      })
      return { content: [{ type: 'text', text: `任务已创建: ${result.task.id}` }] }
    }

    case 'kanban_get_board': {
      const result = await request('/api/board')
      const board = result.board
      let text = '看板视图:\n'
      for (const [status, tasks] of Object.entries(board)) {
        if (tasks.length > 0) {
          text += `\n${status} (${tasks.length}):\n`
          for (const task of tasks) {
            text += `  - ${task.title} ${task.assignedAgentId ? '✓' : '○'}\n`
          }
        }
      }
      return { content: [{ type: 'text', text }] }
    }

    case 'kanban_get_tasks': {
      const { status } = args
      const path = status ? `/api/tasks?status=${status}` : '/api/tasks'
      const result = await request(path)
      return { content: [{ type: 'text', text: JSON.stringify(result.tasks, null, 2) }] }
    }

    case 'kanban_claim_task': {
      const { taskId, agentId } = args
      const result = await request(`/api/tasks/${taskId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ agentId })
      })
      return { content: [{ type: 'text', text: `已认领任务: ${result.task.title}` }] }
    }

    case 'kanban_update_status': {
      const { taskId, status } = args
      const result = await request(`/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      })
      return { content: [{ type: 'text', text: `状态已更新为: ${result.task.status}` }] }
    }

    case 'kanban_report_bug': {
      const { taskId, bugReport } = args
      const result = await request(`/api/tasks/${taskId}/bug`, {
        method: 'POST',
        body: JSON.stringify({ bugReport })
      })
      let text = `Bug 已报告，任务状态: ${result.task.status}`
      if (result.blocked) {
        text += '\n⚠️ 任务已被阻塞（超过3次循环）'
      }
      return { content: [{ type: 'text', text }] }
    }

    case 'kanban_register_agent': {
      const { name, role, capabilities = [] } = args
      const result = await request('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, role, capabilities })
      })
      return { content: [{ type: 'text', text: `Agent 已注册: ${result.agent.id}` }] }
    }

    case 'kanban_heartbeat': {
      const { agentId } = args
      await request(`/api/agents/${agentId}/heartbeat`, { method: 'POST' })
      return { content: [{ type: 'text', text: '心跳已发送' }] }
    }

    case 'kanban_get_agents': {
      const result = await request('/api/agents/online')
      return { content: [{ type: 'text', text: JSON.stringify(result.agents, null, 2) }] }
    }

    case 'kanban_get_stats': {
      const result = await request('/api/stats')
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ============ MCP 协议处理 ============

function parseMcpRequest(body) {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function mcpResponse(id, result) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  })
}

function mcpError(id, error) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: error }
  })
}

// ============ 启动 MCP 服务器 ============

const MCP_PORT = 6667

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  if (req.method === 'GET' && req.url === '/tools') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tools }))
    return
  }

  if (req.method === 'POST' && req.url === '/execute') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const request = parseMcpRequest(body)
        if (!request) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(mcpError(null, 'Invalid JSON'))
          return
        }

        const { id, method, params } = request

        if (method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(mcpResponse(id, { tools }))
          return
        }

        if (method === 'tools/execute') {
          const { name, arguments: args } = params
          const result = await executeTool(name, args)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(mcpResponse(id, result))
          return
        }

        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(mcpError(id, `Unknown method: ${method}`))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(mcpError(null, e.message))
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(MCP_PORT, () => {
  console.log(`[MCP Server] Running on port ${MCP_PORT}`)
  console.log(`[MCP Server] Health: http://localhost:${MCP_PORT}/health`)
  console.log(`[MCP Server] Tools: http://localhost:${MCP_PORT}/tools`)
  console.log(`[MCP Server] Execute: http://localhost:${MCP_PORT}/execute`)
})
