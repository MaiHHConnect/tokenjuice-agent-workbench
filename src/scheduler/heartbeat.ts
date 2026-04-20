import { schedulerState, Agent } from './state'
import { releaseTask } from './kanban'

// 心跳检测间隔（毫秒）
const DEFAULT_OFFLINE_THRESHOLD = 30_000

// 检查 Agent 是否离线
export function isAgentOffline(agent: Agent, threshold: number = DEFAULT_OFFLINE_THRESHOLD): boolean {
  return Date.now() - agent.lastHeartbeat.getTime() > threshold
}

// 处理离线 Agent 的任务
function handleOfflineAgent(agent: Agent): void {
  if (agent.currentTaskId) {
    const taskId = agent.currentTaskId
    console.log(`[Heartbeat] Agent ${agent.name} went offline, releasing task ${taskId}`)
    releaseTask(taskId)
  }

  schedulerState.updateAgent(agent.id, {
    status: 'offline',
    currentTaskId: undefined
  })
}

// 心跳检测
export function heartbeatCheck(threshold: number = DEFAULT_OFFLINE_THRESHOLD): void {
  const now = Date.now()

  for (const agent of schedulerState.getOnlineAgents()) {
    if (agent.status === 'offline') continue

    if (now - agent.lastHeartbeat.getTime() > threshold) {
      console.log(`[Heartbeat] Marking agent ${agent.name} as offline`)
      handleOfflineAgent(agent)
    }
  }
}

// 启动心跳检测定时器
let heartbeatTimer?: NodeJS.Timeout

export function startHeartbeatMonitor(interval: number = 10_000, threshold: number = DEFAULT_OFFLINE_THRESHOLD): void {
  stopHeartbeatMonitor()

  heartbeatTimer = setInterval(() => {
    heartbeatCheck(threshold)
  }, interval)

  console.log(`[Heartbeat] Monitor started (interval: ${interval}ms, threshold: ${threshold}ms)`)
}

export function stopHeartbeatMonitor(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
    console.log('[Heartbeat] Monitor stopped')
  }
}

// 获取 Agent 心跳状态
export function getAgentHeartbeatStatus(agentId: string): {
  agent?: Agent
  lastHeartbeat?: Date
  secondsSinceHeartbeat?: number
  isOffline: boolean
} {
  const agent = schedulerState.getAgent(agentId)

  if (!agent) {
    return { isOffline: true }
  }

  const secondsSinceHeartbeat = Math.floor(
    (Date.now() - agent.lastHeartbeat.getTime()) / 1000
  )

  return {
    agent,
    lastHeartbeat: agent.lastHeartbeat,
    secondsSinceHeartbeat,
    isOffline: isAgentOffline(agent)
  }
}

// 获取所有 Agent 心跳状态
export function getAllHeartbeatStatus(): Array<{
  agentId: string
  name: string
  status: string
  lastHeartbeat: Date
  secondsSinceHeartbeat: number
  isOffline: boolean
}> {
  return schedulerState.getAllAgents().map(agent => ({
    agentId: agent.id,
    name: agent.name,
    status: agent.status,
    lastHeartbeat: agent.lastHeartbeat,
    secondsSinceHeartbeat: Math.floor(
      (Date.now() - agent.lastHeartbeat.getTime()) / 1000
    ),
    isOffline: isAgentOffline(agent)
  }))
}
