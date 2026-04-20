/**
 * 工具定义 (Claude 风格)
 *
 * 每个工具都有安全属性:
 * - isConcurrencySafe: 并发安全
 * - isReadOnly: 只读操作
 * - isDestructive: 破坏性操作
 */

/**
 * 基础工具类
 */
export class BaseTool {
  constructor(name, description) {
    this.name = name
    this.description = description
  }

  // 安全属性 (默认不安全)
  isConcurrencySafe(input) {
    return false
  }

  isReadOnly(input) {
    return false
  }

  isDestructive(input) {
    return false
  }

  // 执行
  async call(args, context) {
    throw new Error('Not implemented')
  }
}

/**
 * 任务工具
 */
export class TaskTool extends BaseTool {
  constructor() {
    super('task', '创建和管理任务')
  }

  isConcurrencySafe(input) {
    return true // 读操作并发安全
  }

  isReadOnly(input) {
    return input.action === 'read' || input.action === 'list'
  }

  isDestructive(input) {
    return input.action === 'delete'
  }

  async call(args, context) {
    const { action, taskId, data } = args

    switch (action) {
      case 'create':
        return { type: 'success', task: context.db.createTask(data) }
      case 'update':
        return { type: 'success', task: context.db.updateTask(taskId, data) }
      case 'delete':
        return { type: 'success' }
      case 'list':
      default:
        return { type: 'success', tasks: context.db.getTasks() }
    }
  }
}

/**
 * Agent 工具
 */
export class AgentTool extends BaseTool {
  constructor() {
    super('agent', 'Agent 管理')
  }

  isConcurrencySafe(input) {
    return input.action === 'list' || input.action === 'get'
  }

  isReadOnly(input) {
    return input.action === 'list' || input.action === 'get' || input.action === 'heartbeat'
  }

  async call(args, context) {
    const { action, agentId, data } = args

    switch (action) {
      case 'register':
        return { type: 'success', agent: context.db.createAgent(data) }
      case 'heartbeat':
        return { type: 'success', agent: context.db.updateAgentHeartbeat(agentId) }
      case 'list':
      default:
        return { type: 'success', agents: context.db.getAgents() }
    }
  }
}

/**
 * 看板工具
 */
export class BoardTool extends BaseTool {
  constructor() {
    super('board', '看板视图')
  }

  isConcurrencySafe() {
    return true
  }

  isReadOnly() {
    return true
  }

  async call(args, context) {
    return { type: 'success', board: context.db.getBoard() }
  }
}

/**
 * 调度器工具
 */
export class SchedulerTool extends BaseTool {
  constructor() {
    super('scheduler', '调度器控制')
  }

  isConcurrencySafe(input) {
    return input.action === 'status'
  }

  isReadOnly(input) {
    return input.action === 'status'
  }

  async call(args, context) {
    const { action } = args

    switch (action) {
      case 'start':
        context.scheduler.start()
        return { type: 'success' }
      case 'stop':
        context.scheduler.stop()
        return { type: 'success' }
      case 'status':
      default:
        return { type: 'success', status: context.scheduler.getStatus() }
    }
  }
}

/**
 * 记忆工具
 */
export class MemoryTool extends BaseTool {
  constructor() {
    super('memory', '记忆系统')
  }

  isConcurrencySafe(input) {
    return input.action === 'search' || input.action === 'prefetch'
  }

  isReadOnly(input) {
    return input.action === 'search' || input.action === 'prefetch' || input.action === 'get'
  }

  async call(args, context) {
    const { action, query, content, userId, sessionId } = args

    switch (action) {
      case 'save':
        context.memory.syncTurn(content, '', sessionId)
        return { type: 'success' }
      case 'search':
        const result = context.memory.prefetch(query)
        return { type: 'success', result }
      case 'prefetch':
        const prefetch = context.memory.prefetch(query)
        return { type: 'success', result: prefetch }
      default:
        return { type: 'success' }
    }
  }
}

/**
 * Skill 工具
 */
export class SkillTool extends BaseTool {
  constructor() {
    super('skill', 'Skill 管理')
  }

  isConcurrencySafe(input) {
    return true
  }

  isReadOnly(input) {
    return input.action === 'list' || input.action === 'get' || input.action === 'search'
  }

  async call(args, context) {
    const { action, skillName, query, userMessage } = args

    switch (action) {
      case 'list':
        return { type: 'success', skills: context.skills.getAllSkills() }
      case 'get':
        return { type: 'success', skill: context.skills.getSkill(skillName) }
      case 'search':
        return { type: 'success', skills: context.skills.searchSkills(query) }
      case 'trigger':
        const result = await context.skills.triggerSkill({ userMessage, skillName })
        return { type: 'success', ...result }
      case 'improve':
        await context.skills.createImprovementNote(skillName, args.note)
        return { type: 'success' }
      default:
        return { type: 'success' }
    }
  }
}

/**
 * 获取所有工具
 */
export function getAllTools() {
  return [
    new TaskTool(),
    new AgentTool(),
    new BoardTool(),
    new SchedulerTool(),
    new MemoryTool(),
    new SkillTool()
  ]
}

/**
 * 工具注册表
 */
export const toolRegistry = new Map()

// 注册所有工具
for (const tool of getAllTools()) {
  toolRegistry.set(tool.name, tool)
}

/**
 * 获取工具
 */
export function getTool(name) {
  return toolRegistry.get(name)
}

/**
 * 按类型筛选工具
 */
export function getTools(options = {}) {
  const tools = []

  for (const tool of toolRegistry.values()) {
    if (options.readOnly && !tool.isReadOnly()) continue
    if (options.concurrentSafe && !tool.isConcurrencySafe()) continue
    if (options.nonDestructive && tool.isDestructive()) continue

    tools.push(tool)
  }

  return tools
}

export default {
  BaseTool,
  TaskTool,
  AgentTool,
  BoardTool,
  SchedulerTool,
  MemoryTool,
  SkillTool,
  getAllTools,
  getTool,
  getTools,
  toolRegistry
}
