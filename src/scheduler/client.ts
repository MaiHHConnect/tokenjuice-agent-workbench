// 看板 API 客户端
export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  assignedAgentId: string | null
  skills: string[]
  loopCount: number
  bugReport: string | null
  attachments: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Agent {
  id: string
  name: string
  role: AgentRole
  capabilities: string[]
  status: AgentStatus
  currentTaskId: string | null
  lastHeartbeat: string
  createdAt: string
}

export type TaskStatus = 'Backlog' | 'InDev' | 'ReadyForTest' | 'InFix' | 'ReadyForDeploy' | 'Done' | 'Blocked'
export type AgentRole = 'pm' | 'developer' | 'tester' | 'deployer'
export type AgentStatus = 'idle' | 'busy' | 'offline'

export interface KanbanBoard {
  Backlog: Task[]
  InDev: Task[]
  ReadyForTest: Task[]
  InFix: Task[]
  ReadyForDeploy: Task[]
  Done: Task[]
  Blocked: Task[]
}

const API_BASE = 'http://localhost:6666'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  })

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

// ============ Agent API ============

export async function registerAgent(name: string, role: AgentRole, capabilities: string[] = []): Promise<Agent> {
  const result = await request<{ agent: Agent }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name, role, capabilities })
  })
  return result.agent
}

export async function getAgents(): Promise<Agent[]> {
  const result = await request<{ agents: Agent[] }>('/api/agents')
  return result.agents
}

export async function getOnlineAgents(): Promise<Agent[]> {
  const result = await request<{ agents: Agent[] }>('/api/agents/online')
  return result.agents
}

export async function heartbeat(agentId: string): Promise<void> {
  await request(`/api/agents/${agentId}/heartbeat`, { method: 'POST' })
}

export async function getAgent(agentId: string): Promise<Agent | null> {
  try {
    const result = await request<{ agent: Agent }>(`/api/agents/${agentId}`)
    return result.agent
  } catch {
    return null
  }
}

// ============ Task API ============

export async function createTask(title: string, description?: string, skills?: string[]): Promise<Task> {
  const result = await request<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, skills })
  })
  return result.task
}

export async function getTasks(status?: TaskStatus): Promise<Task[]> {
  const url = status ? `/api/tasks?status=${status}` : '/api/tasks'
  const result = await request<{ tasks: Task[] }>(url)
  return result.tasks
}

export async function getTask(taskId: string): Promise<Task | null> {
  try {
    const result = await request<{ task: Task }>(`/api/tasks/${taskId}`)
    return result.task
  } catch {
    return null
  }
}

export async function getBoard(): Promise<KanbanBoard> {
  const result = await request<{ board: KanbanBoard }>('/api/board')
  return result.board
}

export async function claimTask(taskId: string, agentId: string): Promise<Task> {
  const result = await request<{ task: Task }>(`/api/tasks/${taskId}/claim`, {
    method: 'POST',
    body: JSON.stringify({ agentId })
  })
  return result.task
}

export async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
  const result = await request<{ task: Task }>(`/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  })
  return result.task
}

export async function reportBug(taskId: string, bugReport: string): Promise<{ task: Task; blocked: boolean; loopCount: number }> {
  const result = await request<{ task: Task; blocked: boolean; loopCount: number }>(`/api/tasks/${taskId}/bug`, {
    method: 'POST',
    body: JSON.stringify({ bugReport })
  })
  return result
}

// ============ 日志 API ============

export async function appendLog(taskId: string, agentId: string, action: string, message?: string): Promise<void> {
  await request(`/api/tasks/${taskId}/logs`, {
    method: 'POST',
    body: JSON.stringify({ agentId, action, message })
  })
}

// ============ 统计 API ============

export async function getStats(): Promise<{
  totalTasks: number
  totalAgents: number
  onlineAgents: number
  byStatus: Record<string, number>
}> {
  return request('/api/stats')
}

// 便捷函数
export async function healthCheck(): Promise<boolean> {
  try {
    await request<{ status: string }>('/health')
    return true
  } catch {
    return false
  }
}
