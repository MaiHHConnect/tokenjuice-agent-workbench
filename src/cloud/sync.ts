// 云端同步模块
import { schedulerState, Task, Agent } from '../scheduler/state'
import { getKanbanView, getKanbanStats } from '../scheduler/kanban'
import { getLoopProtectionStats } from '../scheduler/loopProtection'

// 云端 API 客户端
export interface CloudApiClient {
  baseUrl: string
  apiKey?: string

  // Agent 操作
  registerAgent(agent: Omit<Agent, 'id' | 'createdAt' | 'lastHeartbeat'>): Promise<Agent>
  heartbeat(agentId: string): Promise<void>
  getOnlineAgents(): Promise<Agent[]>

  // 任务操作
  registerTask(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task>
  updateTaskStatus(taskId: string, status: string, operatorId?: string): Promise<Task>
  claimTask(taskId: string, agentId: string): Promise<Task>
  reportBug(taskId: string, bugReport: string): Promise<{ task: Task; blocked: boolean }>
  appendLog(taskId: string, agentId: string, action: string, message?: string): Promise<void>

  // 数据同步
  syncState(): Promise<void>
  pullState(): Promise<void>
}

export interface CloudSyncConfig {
  apiUrl: string
  agentId: string
  syncInterval: number
  autoSync: boolean
}

// 默认配置
export const defaultCloudSyncConfig: CloudSyncConfig = {
  apiUrl: 'http://localhost:6666',
  agentId: '',
  syncInterval: 30_000, // 30 秒
  autoSync: true
}

// 创建 API 客户端
export function createCloudApiClient(config: Partial<CloudSyncConfig> = {}): CloudApiClient {
  const apiUrl = config.apiUrl || defaultCloudSyncConfig.apiUrl

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${apiUrl}${path}`
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

  return {
    baseUrl: apiUrl,

    // Agent 操作
    async registerAgent(agentData) {
      const result = await request<{ agent: Agent }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(agentData)
      })
      return result.agent
    },

    async heartbeat(agentId) {
      await request(`/api/agents/${agentId}/heartbeat`, {
        method: 'POST'
      })
    },

    async getOnlineAgents() {
      const result = await request<{ agents: Agent[] }>('/api/agents/online')
      return result.agents
    },

    // 任务操作
    async registerTask(taskData) {
      const result = await request<{ task: Task }>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData)
      })
      return result.task
    },

    async updateTaskStatus(taskId, status, operatorId) {
      const result = await request<{ task: Task }>(`/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, operatorId })
      })
      return result.task
    },

    async claimTask(taskId, agentId) {
      const result = await request<{ task: Task }>(`/api/tasks/${taskId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ agentId })
      })
      return result.task
    },

    async reportBug(taskId, bugReport) {
      const result = await request<{ task: Task; blocked: boolean }>(`/api/tasks/${taskId}/bug`, {
        method: 'POST',
        body: JSON.stringify({ bugReport })
      })
      return result
    },

    async appendLog(taskId, agentId, action, message) {
      await request(`/api/tasks/${taskId}/logs`, {
        method: 'POST',
        body: JSON.stringify({ agentId, action, message })
      })
    },

    // 数据同步
    async syncState() {
      // 同步任务到云端
      const localTasks = schedulerState.getAllTasks()
      for (const task of localTasks) {
        try {
          await request(`/api/tasks/${task.id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({
              status: task.status,
              operatorId: task.assignedAgentId
            })
          })
        } catch (e) {
          // 忽略同步错误
        }
      }
    },

    async pullState() {
      // 从云端拉取状态
      const result = await request<{ board: Record<string, Task[]> }>('/api/board')
      // TODO: 合并云端状态到本地
    }
  }
}

// 云端同步器类
export class CloudSyncer {
  private config: CloudSyncConfig
  private api: CloudApiClient
  private timer?: NodeJS.Timeout
  private running: boolean = false

  constructor(config: Partial<CloudSyncConfig> = {}) {
    this.config = { ...defaultCloudSyncConfig, ...config }
    this.api = createCloudApiClient(this.config)
  }

  // 启动同步
  start(): void {
    if (this.running || !this.config.autoSync) return
    this.running = true

    this.timer = setInterval(() => {
      this.sync().catch(console.error)
    }, this.config.syncInterval)

    console.log(`[CloudSync] Started (interval: ${this.config.syncInterval}ms)`)
  }

  // 停止同步
  stop(): void {
    if (!this.running) return
    this.running = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }

    console.log('[CloudSync] Stopped')
  }

  // 执行同步
  async sync(): Promise<void> {
    try {
      await this.api.syncState()
      console.log('[CloudSync] Synced')
    } catch (e) {
      console.error('[CloudSync] Sync failed:', e)
    }
  }

  // 获取状态
  getStatus() {
    return {
      running: this.running,
      config: this.config,
      apiUrl: this.api.baseUrl
    }
  }
}

// 导出默认实例
export const cloudSyncer = new CloudSyncer()
