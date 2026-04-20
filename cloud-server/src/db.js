/**
 * 数据访问层
 *
 * 封装数据库操作，提供统一的数据访问接口
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import * as yaml from 'yaml'
import { broadcast } from './wsBroadcast.js'
import { fileURLToPath } from 'url'
import { buildClaudeAgentDirSources, resolvePreferredClaudeAgentsDir } from './claudePaths.js'

// 使用绝对路径，基于当前模块位置
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, '..', 'data')
const DATA_FILE = path.join(DATA_DIR, 'scheduler.json')

// Claude Code agents 配置目录
const CLAUDE_AGENTS_DIR = resolvePreferredClaudeAgentsDir()
const PROJECT_CLAUDE_AGENTS_DIR = path.resolve(__dirname, '..', '..', '.claude', 'agents')
const CLAUDE_AGENT_DIRS = buildClaudeAgentDirSources(PROJECT_CLAUDE_AGENTS_DIR)

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

// 生成 ID
export function genId() {
  return uuidv4()
}

function broadcastTaskUpdated(taskId, extra = {}) {
  if (!taskId) return
  broadcast({ type: 'task_updated', taskId, ...extra })
}

function broadcastAgentUpdated(agentId, extra = {}) {
  if (!agentId) return
  broadcast({ type: 'agent_updated', agentId, ...extra })
}

function normalizeTaskText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .trim()
}

function truncateTaskText(text, maxLength = 800) {
  const normalized = normalizeTaskText(text)
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
}

function joinNonEmptySections(sections = []) {
  return sections
    .map(section => normalizeTaskText(section))
    .filter(Boolean)
    .join('\n\n')
}

function extractTaskSection(text, sectionName) {
  const content = String(text || '')
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(new RegExp(`【${escapedName}】\\s*([\\s\\S]*?)(?=\\n【[^】]+】|$)`))
  return match ? normalizeTaskText(match[1]) : ''
}

export function extractOriginalTaskRequirement(task) {
  const explicitOriginal = normalizeTaskText(task?.originalDescription)
  if (explicitOriginal) return explicitOriginal

  const description = normalizeTaskText(task?.description)
  if (!description) return ''

  const sectionOriginal = extractTaskSection(description, '原始任务要求')
  if (sectionOriginal) return sectionOriginal

  const beforeParentContext = description.split('【父任务背景】')[0]
  const withoutQaContext = beforeParentContext.replace(/^【QA 验证失败】[\s\S]*$/, '').trim()

  return normalizeTaskText(withoutQaContext || beforeParentContext)
}

function buildArtifactSummary(task) {
  const lines = []

  const existingArtifacts = (Array.isArray(task?.artifactManifest) ? task.artifactManifest : [])
    .filter(item => item && item.exists)
    .slice(0, 8)
    .map((item, index) => `${index + 1}. ${item.absolutePath || item.path || item.relativeToWorkspace}`)
  if (existingArtifacts.length > 0) {
    lines.push('已存在工件:')
    lines.push(...existingArtifacts)
  }

  const declaredArtifacts = (Array.isArray(task?.handoffArtifacts) ? task.handoffArtifacts : [])
    .map(item => normalizeTaskText(item))
    .filter(Boolean)
    .slice(0, 8)
  if (declaredArtifacts.length > 0) {
    lines.push('约定交付工件:')
    lines.push(...declaredArtifacts.map((item, index) => `${index + 1}. ${item}`))
  }

  const mountedArtifacts = (Array.isArray(task?.mountedArtifacts) ? task.mountedArtifacts : [])
    .slice(0, 6)
    .map((item, index) => {
      const mountedPath = normalizeTaskText(item?.mountedPath || item?.relativeMountedPath)
      const source = normalizeTaskText(item?.sourceTaskTitle || item?.sourceTaskId)
      const sourcePath = normalizeTaskText(item?.sourcePath)
      if (!mountedPath && !sourcePath) return ''
      return `${index + 1}. ${mountedPath || sourcePath}${source ? ` <- ${source}` : ''}${sourcePath && sourcePath !== mountedPath ? ` (${sourcePath})` : ''}`
    })
    .filter(Boolean)
  if (mountedArtifacts.length > 0) {
    lines.push('已挂载依赖工件:')
    lines.push(...mountedArtifacts)
  }

  return lines.join('\n')
}

function buildContractSummary(task) {
  const sections = []
  const acceptanceCriteria = (Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])
    .map(item => normalizeTaskText(item))
    .filter(Boolean)
    .slice(0, 8)
  const verificationPlan = (Array.isArray(task?.verificationPlan) ? task.verificationPlan : [])
    .map(item => normalizeTaskText(item))
    .filter(Boolean)
    .slice(0, 8)

  if (acceptanceCriteria.length > 0) {
    sections.push(`验收标准:\n${acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)
  }

  if (verificationPlan.length > 0) {
    sections.push(`验证计划:\n${verificationPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)
  }

  return sections.join('\n')
}

function buildRecentMessageSummary(messages = []) {
  const lines = messages
    .slice(-6)
    .map((message, index) => {
      const role = message?.role === 'assistant'
        ? '助手'
        : (message?.role === 'user' ? '用户' : '系统')
      const content = truncateTaskText(message?.content, 180)
      if (!content) return ''
      return `${index + 1}. ${role}: ${content}`
    })
    .filter(Boolean)

  return lines.join('\n')
}

function buildWikiSummary(wiki) {
  if (!wiki) return ''

  const sections = []
  const content = truncateTaskText(wiki.content, 800)
  if (content) {
    sections.push(content)
  }

  const highlightGroups = [
    { title: '需求要点', values: wiki.requirementHighlights },
    { title: '决策记录', values: wiki.decisionHighlights },
    { title: '问题处理', values: wiki.issueHighlights },
    { title: '验证结论', values: wiki.verificationHighlights }
  ]

  for (const group of highlightGroups) {
    const values = (Array.isArray(group.values) ? group.values : [])
      .map(item => truncateTaskText(item, 160))
      .filter(Boolean)
      .slice(0, 5)
    if (values.length > 0) {
      sections.push(`${group.title}:\n${values.map((item, index) => `${index + 1}. ${item}`).join('\n')}`)
    }
  }

  return sections.join('\n')
}

function buildFollowUpTaskTitle(sourceTask, followUpRequirement) {
  const sourceTitle = normalizeTaskText(sourceTask?.title) || '已完成任务'
  const requirementSummary = truncateTaskText(followUpRequirement, 36)
  if (!requirementSummary) {
    return `补充：${sourceTitle}`
  }
  return `补充：${sourceTitle} · ${requirementSummary}`
}

function buildFollowUpTaskDescription(sourceTask, followUpRequirement, options = {}) {
  const sourceRequirement = extractOriginalTaskRequirement(sourceTask)
  const sourceDescription = normalizeTaskText(sourceTask?.description)
  const parentTask = options.parentTask || null
  const parentRequirement = extractOriginalTaskRequirement(parentTask)
  const sections = [
    `【本次补充目标】\n${normalizeTaskText(followUpRequirement)}`,
    joinNonEmptySections([
      '【来源任务】',
      `标题：${normalizeTaskText(sourceTask?.title) || '未命名任务'}`,
      sourceTask?.id ? `任务 ID：${sourceTask.id}` : '',
      sourceTask?.taskTag ? `任务标签：#${sourceTask.taskTag}` : '',
      sourceTask?.status ? `来源状态：${sourceTask.status}` : ''
    ])
  ]

  if (sourceRequirement) {
    sections.push(`【原始任务要求】\n${truncateTaskText(sourceRequirement, 1400)}`)
  }

  if (sourceDescription && sourceDescription !== sourceRequirement) {
    sections.push(`【来源任务上下文】\n${truncateTaskText(sourceDescription, 1800)}`)
  }

  if (parentTask) {
    sections.push(joinNonEmptySections([
      '【父任务背景】',
      `标题：${normalizeTaskText(parentTask.title) || '未命名父任务'}`,
      parentTask.taskTag ? `任务标签：#${parentTask.taskTag}` : '',
      parentRequirement ? `原始要求：${truncateTaskText(parentRequirement, 600)}` : ''
    ]))
  }

  const artifactSummary = buildArtifactSummary(sourceTask)
  if (artifactSummary) {
    sections.push(`【可复用工件】\n${artifactSummary}`)
  }

  const contractSummary = buildContractSummary(sourceTask)
  if (contractSummary) {
    sections.push(`【原任务验收与验证信息】\n${contractSummary}`)
  }

  const wikiSummary = buildWikiSummary(options.wiki)
  if (wikiSummary) {
    sections.push(`【历史资料沉淀】\n${wikiSummary}`)
  }

  const recentMessages = buildRecentMessageSummary(options.messages)
  if (recentMessages) {
    sections.push(`【最近对话摘录】\n${recentMessages}`)
  }

  return sections
    .map(section => normalizeTaskText(section))
    .filter(Boolean)
    .join('\n\n')
}

function ensureTaskShape(task) {
  if (!task || typeof task !== 'object') return task

  if (!Array.isArray(task.skills)) task.skills = []
  if (!Array.isArray(task.acceptanceCriteria)) task.acceptanceCriteria = []
  if (!Array.isArray(task.verificationPlan)) task.verificationPlan = []
  if (!Array.isArray(task.handoffArtifacts)) task.handoffArtifacts = []
  if (!Array.isArray(task.artifactManifest)) task.artifactManifest = []
  if (!Array.isArray(task.mountedArtifacts)) task.mountedArtifacts = []
  if (!Array.isArray(task.subTaskIds)) task.subTaskIds = []
  if (!Array.isArray(task.dependsOnSubTaskIds)) task.dependsOnSubTaskIds = []
  if (!Array.isArray(task.dependencyRefs)) task.dependencyRefs = []
  if (!Array.isArray(task.blockedBySubTasks)) task.blockedBySubTasks = []
  if (!Array.isArray(task.outputLines)) task.outputLines = []
  if (!Array.isArray(task.messages)) task.messages = []
  if (!Array.isArray(task.riskSignals)) task.riskSignals = []

  if (typeof task.currentOutput !== 'string') {
    task.currentOutput = task.currentOutput ? String(task.currentOutput) : ''
  }
  if (typeof task.operationFolder !== 'string') {
    task.operationFolder = task.operationFolder ? String(task.operationFolder) : ''
  }
  if (typeof task.linkedTaskId !== 'string' && task.linkedTaskId !== null) {
    task.linkedTaskId = task.linkedTaskId ? String(task.linkedTaskId) : null
  }
  if (typeof task.followUpSourceTaskId !== 'string' && task.followUpSourceTaskId !== null) {
    task.followUpSourceTaskId = task.followUpSourceTaskId ? String(task.followUpSourceTaskId) : null
  }
  if (typeof task.followUpReason !== 'string' && task.followUpReason !== null) {
    task.followUpReason = task.followUpReason ? String(task.followUpReason) : null
  }
  const parsedSourceTaskTag = Number.parseInt(task.sourceTaskTag, 10)
  task.sourceTaskTag = Number.isInteger(parsedSourceTaskTag) && parsedSourceTaskTag > 0
    ? parsedSourceTaskTag
    : null
  if (typeof task.dependencyBlockedSummary !== 'string' && task.dependencyBlockedSummary !== null) {
    task.dependencyBlockedSummary = task.dependencyBlockedSummary ? String(task.dependencyBlockedSummary) : null
  }
  if (typeof task.skipReason !== 'string' && task.skipReason !== null) {
    task.skipReason = task.skipReason ? String(task.skipReason) : null
  }
  if (typeof task.decompositionReason !== 'string') {
    task.decompositionReason = task.decompositionReason ? String(task.decompositionReason) : ''
  }
  const parsedDepth = Number.parseInt(task.depth, 10)
  const normalizedDepth = Number.isInteger(parsedDepth) && parsedDepth > 0 ? parsedDepth : 1
  const parsedMaxDepth = Number.parseInt(task.maxDecompositionDepth, 10)
  task.skipAsDependency = Boolean(task.skipAsDependency)
  task.skippedAt = task.skippedAt || null
  task.depth = normalizedDepth
  task.maxDecompositionDepth = Number.isInteger(parsedMaxDepth) && parsedMaxDepth > 0
    ? Math.max(parsedMaxDepth, task.depth)
    : Math.max(3, task.depth)
  task.canExecuteDirectly = task.canExecuteDirectly !== false
  task.shouldDecomposeFurther = Boolean(task.shouldDecomposeFurther) && task.depth < task.maxDecompositionDepth

  const workspace = task.workspace && typeof task.workspace === 'object' ? task.workspace : {}
  task.workspace = {
    path: typeof workspace.path === 'string' ? workspace.path : '',
    status: typeof workspace.status === 'string' ? workspace.status : 'none',
    retainedForQa: Boolean(workspace.retainedForQa),
    lastExecutionAt: workspace.lastExecutionAt || null,
    lastVerifiedAt: workspace.lastVerifiedAt || null,
    cleanedAt: workspace.cleanedAt || null,
    updatedAt: workspace.updatedAt || task.updatedAt || new Date().toISOString()
  }

  return task
}

function agentIdFromPath(filePath) {
  return `claude-agent:${Buffer.from(path.resolve(filePath)).toString('base64url')}`
}

function normalizeAgentName(name) {
  return String(name || '').trim()
}

function inferAgentRole(config = {}, fallbackName = '') {
  const explicitRole = normalizeAgentName(config.role)
  if (explicitRole) {
    return explicitRole
  }

  const haystack = `${config.name || ''} ${fallbackName} ${config.description || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')

  const mappings = [
    { match: ['pm', 'product manager', '项目经理', '需求'], role: 'planner' },
    { match: ['qa', 'tester', 'test engineer', '测试'], role: 'qa-tester' },
    { match: ['dev', 'developer', 'executor', '开发'], role: 'executor' },
    { match: ['deploy', 'release', '部署'], role: 'deployer' },
    { match: ['architect', '架构'], role: 'architect' },
    { match: ['review', '审查', '评审'], role: 'code-reviewer' },
    { match: ['analysis', 'analyst', '分析'], role: 'analyst' },
    { match: ['scientist', 'research', '调研'], role: 'scientist' },
    { match: ['debug', 'bug', '调试', '修复'], role: 'debugger' }
  ]

  for (const entry of mappings) {
    if (entry.match.some(item => haystack.includes(item))) {
      return entry.role
    }
  }

  return normalizeAgentName(config.name) || fallbackName
}

function toAgentFileName(name) {
  const safeName = normalizeAgentName(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safeName || `agent-${Date.now()}`
}

function normalizeSkillList(value) {
  if (!value) return []
  const items = Array.isArray(value) ? value : String(value).split(',')
  return Array.from(new Set(items.map(item => String(item || '').trim()).filter(Boolean)))
}

function normalizeToolList(value) {
  if (!value) return []
  const items = Array.isArray(value) ? value : String(value).split(',')
  return Array.from(new Set(items.map(item => String(item || '').trim()).filter(Boolean)))
}

function normalizeAgentSkillConfig(config = {}) {
  const rawSkills = config.skills ?? config.allowedSkills ?? config.omcSkills

  if (
    rawSkills === undefined ||
    rawSkills === null ||
    rawSkills === true ||
    rawSkills === 'all' ||
    rawSkills === '*'
  ) {
    return { skillMode: 'all', allowedSkills: [] }
  }

  if (rawSkills && typeof rawSkills === 'object' && !Array.isArray(rawSkills)) {
    const mode = rawSkills.mode || rawSkills.scope
    if (mode === 'all') {
      return { skillMode: 'all', allowedSkills: [] }
    }
    return { skillMode: 'custom', allowedSkills: normalizeSkillList(rawSkills.allowed || rawSkills.names || rawSkills.skills) }
  }

  const allowedSkills = normalizeSkillList(rawSkills)
  return allowedSkills.length > 0
    ? { skillMode: 'custom', allowedSkills }
    : { skillMode: 'all', allowedSkills: [] }
}

function parseMarkdownAgent(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, instructions: String(content || '').trim() }
  }

  try {
    return {
      frontmatter: yaml.parse(match[1]) || {},
      instructions: String(match[2] || '').trim()
    }
  } catch (e) {
    console.error('[DB] Failed to parse agent frontmatter:', e.message)
    return { frontmatter: {}, instructions: String(match[2] || '').trim() }
  }
}

function createAgentFromFile(filePath, source) {
  const ext = path.extname(filePath).toLowerCase()
  const stat = statSync(filePath)
  const content = readFileSync(filePath, 'utf-8')
  const baseName = path.basename(filePath, ext)
  let config = {}
  let instructions = ''
  let format = ext.replace('.', '')

  if (ext === '.json') {
    config = JSON.parse(content)
    instructions = String(config.instructions || '').trim()
  } else {
    const parsed = parseMarkdownAgent(content)
    config = parsed.frontmatter
    instructions = parsed.instructions
    format = 'md'
  }

  const skillConfig = normalizeAgentSkillConfig(config)
  const name = normalizeAgentName(config.name) || baseName
  const role = inferAgentRole(config, name)

  return {
    id: agentIdFromPath(filePath),
    name,
    role,
    claudeAgentName: name,
    description: String(config.description || name).trim(),
    model: config.model || '',
    level: Number.isFinite(Number(config.level)) ? Number(config.level) : 2,
    capabilities: normalizeSkillList(config.capabilities),
    skillMode: skillConfig.skillMode,
    allowedSkills: skillConfig.allowedSkills,
    status: 'idle',
    currentTaskId: null,
    lastHeartbeat: new Date().toISOString(),
    createdAt: stat.birthtime?.toISOString?.() || stat.mtime?.toISOString?.() || new Date().toISOString(),
    updatedAt: stat.mtime?.toISOString?.() || new Date().toISOString(),
    instructions,
    sourcePath: path.resolve(filePath),
    sourceType: source.scope,
    sourceLabel: source.label,
    configFormat: format,
    disallowedTools: normalizeToolList(config.disallowedTools),
    writable: Boolean(source.writable)
  }
}

function applyAgentRuntimeState(agent, previousAgents = []) {
  const previous = previousAgents.find(item => item.id === agent.id)
  if (!previous) return agent

  return {
    ...agent,
    status: previous.status || agent.status,
    currentTaskId: previous.currentTaskId || null,
    lastHeartbeat: previous.lastHeartbeat || agent.lastHeartbeat
  }
}

function buildDefaultAgentInstructions(agent) {
  return `<Agent_Prompt>
  <Role>
    You are ${agent.name}. ${agent.description || 'Follow the task instructions carefully and complete work end-to-end.'}
  </Role>

  <Working_Rules>
    - Use the selected Claude Code skills when they are relevant.
    - Keep outputs concise and include verification results when work changes files or behavior.
    - Ask for clarification only when the task cannot move forward safely without it.
  </Working_Rules>
</Agent_Prompt>`
}

function buildAgentFrontmatter(agent) {
  const frontmatter = {
    name: normalizeAgentName(agent.name),
    description: String(agent.description || '').trim()
  }

  if (agent.role && agent.role !== agent.name) {
    frontmatter.role = normalizeAgentName(agent.role)
  }
  if (agent.model) {
    frontmatter.model = String(agent.model).trim()
  }
  if (agent.level !== undefined && agent.level !== null && agent.level !== '') {
    frontmatter.level = Number(agent.level) || 2
  }

  frontmatter.skills = agent.skillMode === 'custom'
    ? normalizeSkillList(agent.allowedSkills)
    : 'all'

  return frontmatter
}

function writeMarkdownAgent(filePath, agent, existingFrontmatter = {}) {
  const frontmatter = {
    ...existingFrontmatter,
    ...buildAgentFrontmatter(agent)
  }
  const instructions = String(agent.instructions || '').trim() || buildDefaultAgentInstructions(agent)
  const content = `---\n${yaml.stringify(frontmatter).trim()}\n---\n\n${instructions}\n`
  writeFileSync(filePath, content, 'utf-8')
}

function writeJsonAgent(filePath, agent, existingConfig = {}) {
  const nextConfig = {
    ...existingConfig,
    name: normalizeAgentName(agent.name),
    description: String(agent.description || '').trim(),
    instructions: String(agent.instructions || '').trim() || buildDefaultAgentInstructions(agent)
  }

  if (agent.role && agent.role !== agent.name) {
    nextConfig.role = normalizeAgentName(agent.role)
  } else {
    delete nextConfig.role
  }
  if (agent.model) {
    nextConfig.model = String(agent.model).trim()
  } else {
    delete nextConfig.model
  }
  if (agent.level !== undefined && agent.level !== null && agent.level !== '') {
    nextConfig.level = Number(agent.level) || 2
  }

  nextConfig.skills = agent.skillMode === 'custom'
    ? normalizeSkillList(agent.allowedSkills)
    : 'all'

  writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8')
}

function buildRetryDescription(task, parent, bugReport) {
  const originalRequirement = extractOriginalTaskRequirement(task) || normalizeTaskText(task?.title)
  const sections = [
    '【QA 验证失败】',
    normalizeTaskText(bugReport) || '请根据验证反馈修复后重试。'
  ]

  if (parent) {
    sections.push(
      '',
      '【父任务背景】',
      `标题: ${parent.title}`
    )

    if (parent.decompositionNote) {
      sections.push(`分解说明: ${parent.decompositionNote}`)
    }
  }

  sections.push(
    '',
    '【原始任务要求】',
    originalRequirement
  )

  return sections.join('\n')
}

/**
 * 从 Claude Code agents 目录读取 agents
 */
export function loadClaudeCodeAgents() {
  const agents = []

  try {
    for (const source of CLAUDE_AGENT_DIRS) {
      if (!existsSync(source.dir)) {
        console.log('[DB] Claude Code agents directory not found:', source.dir)
        continue
      }

      const files = readdirSync(source.dir).filter(f => f.endsWith('.md') || f.endsWith('.json'))

      for (const file of files) {
        try {
          const filePath = path.join(source.dir, file)
          const agent = createAgentFromFile(filePath, source)
          agents.push(agent)
          console.log(`[DB] Loaded Claude Code agent: ${agent.name}`)
        } catch (e) {
          console.error(`[DB] Failed to load Claude Code agent ${file}:`, e.message)
        }
      }
    }

    console.log(`[DB] Total Claude Code agents loaded: ${agents.length}`)
  } catch (e) {
    console.error('[DB] Error loading Claude Code agents:', e.message)
  }

  return agents
}

// 加载或初始化数据
function loadData() {
  if (existsSync(DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
    } catch (e) {
      console.error('[DB] Failed to load data, starting fresh')
    }
  }
  return {
    agents: [],
    tasks: [],
    taskHistory: [],
    taskLogs: [],
    taskTagCounter: 0,  // 主任务标签计数器
    wikis: [],           // Wiki 文档存储
    schedulerConfig: {    // 调度器配置
      maxConcurrentAgents: 5
    }
  }
}

// 保存数据
function saveData(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

const HOT_PATH_SAVE_DEBOUNCE_MS = 150
const HOT_PATH_SAVE_MAX_WAIT_MS = 1000

// 内存中的数据
const db = {
  _data: loadData(),
  _pendingSaveTimer: null,
  _pendingSaveStartedAt: null,

  // 保存数据
  save() {
    if (this._pendingSaveTimer) {
      clearTimeout(this._pendingSaveTimer)
      this._pendingSaveTimer = null
      this._pendingSaveStartedAt = null
    }
    saveData(this._data)
  },

  queueSave(delay = HOT_PATH_SAVE_DEBOUNCE_MS) {
    const normalizedDelay = Number.isFinite(delay) ? Math.max(0, delay) : HOT_PATH_SAVE_DEBOUNCE_MS
    const now = Date.now()

    if (!this._pendingSaveStartedAt) {
      this._pendingSaveStartedAt = now
    }

    const elapsed = now - this._pendingSaveStartedAt
    const remainingWindow = Math.max(0, HOT_PATH_SAVE_MAX_WAIT_MS - elapsed)
    const nextDelay = Math.min(normalizedDelay, remainingWindow)

    if (this._pendingSaveTimer) {
      clearTimeout(this._pendingSaveTimer)
    }

    this._pendingSaveTimer = setTimeout(() => {
      this._pendingSaveTimer = null
      this._pendingSaveStartedAt = null
      saveData(this._data)
    }, nextDelay)
  },

  // 迁移旧任务数据（分配 taskTag）
  migrateTaskTags() {
    if (!this._data.tasks || this._data.tasks.length === 0) return

    let maxTag = this._data.taskTagCounter || 0
    let migrated = 0

    for (const task of this._data.tasks) {
      if (task.taskTag === undefined || task.taskTag === null) {
        // 顶级任务分配新标签
        if (!task.parentTaskId) {
          maxTag++
          task.taskTag = maxTag
          migrated++
        } else {
          // 子任务需要找父任务获取标签
          const parent = this._data.tasks.find(t => t.id === task.parentTaskId)
          if (parent && parent.taskTag) {
            task.taskTag = parent.taskTag
          } else {
            // 父任务也没有标签，先分配一个
            maxTag++
            parent.taskTag = maxTag
            task.taskTag = maxTag
            migrated++
          }
        }
      }
    }

    if (migrated > 0) {
      this._data.taskTagCounter = maxTag
      this.save()
      console.log(`[DB] Migrated ${migrated} tasks with new tags (max tag: ${maxTag})`)
    }
  },

  migrateTaskMetadata() {
    if (!this._data.tasks || this._data.tasks.length === 0) return

    let migrated = 0

    for (const task of this._data.tasks) {
      const needsMigration =
        !Array.isArray(task.artifactManifest) ||
        !Array.isArray(task.mountedArtifacts) ||
        !Array.isArray(task.blockedBySubTasks) ||
        !task.workspace ||
        !Array.isArray(task.dependsOnSubTaskIds) ||
        !Array.isArray(task.messages)

      ensureTaskShape(task)

      if (needsMigration) {
        migrated++
      }
    }

    if (migrated > 0) {
      this.save()
      console.log(`[DB] Migrated ${migrated} tasks with workspace/artifact metadata`)
    }
  },

  // ============ Agents ============

  // Claude Code agents 缓存（只加载一次）
  _claudeCodeAgents: null,

  refreshClaudeCodeAgents() {
    const previousAgents = this._claudeCodeAgents || []
    this._claudeCodeAgents = loadClaudeCodeAgents().map(agent => applyAgentRuntimeState(agent, previousAgents))
    return this._claudeCodeAgents
  },

  getAgents(options = {}) {
    if (!this._claudeCodeAgents || options.reload) {
      this.refreshClaudeCodeAgents()
    }
    return this._claudeCodeAgents
  },

  getAgentById(id) {
    // 先从 Claude Code agents 缓存中查找
    const found = this.getAgents().find(a => a.id === id)
    if (found) return found
    // 再从 data.agents 中查找（兼容旧数据）
    return this._data.agents.find(a => a.id === id)
  },

  getOnlineAgents() {
    return this.getAgents().filter(a => a.status !== 'offline')
  },

  createAgent(agent) {
    const name = normalizeAgentName(agent.name)
    if (!name) {
      throw new Error('Agent name is required')
    }

    mkdirSync(CLAUDE_AGENTS_DIR, { recursive: true })

    const fileName = `${toAgentFileName(name)}.md`
    const filePath = path.join(CLAUDE_AGENTS_DIR, fileName)
    if (existsSync(filePath)) {
      throw new Error(`Agent config already exists: ${fileName}`)
    }

    const newAgentInput = {
      ...agent,
      name,
      role: normalizeAgentName(agent.role) || name,
      skillMode: agent.skillMode === 'custom' ? 'custom' : 'all',
      allowedSkills: normalizeSkillList(agent.allowedSkills)
    }

    writeMarkdownAgent(filePath, newAgentInput)

    const source = CLAUDE_AGENT_DIRS.find(entry => entry.dir === CLAUDE_AGENTS_DIR) || CLAUDE_AGENT_DIRS[0]
    const newAgent = createAgentFromFile(filePath, source)
    this._claudeCodeAgents = [...(this._claudeCodeAgents || []), newAgent]
    broadcastAgentUpdated(newAgent.id, { created: true })
    return newAgent
  },

  updateAgent(id, updates = {}) {
    const agent = this.getAgentById(id)
    if (!agent || !agent.sourcePath) {
      return null
    }
    if (!agent.writable) {
      throw new Error('Agent config is read-only')
    }

    const filePath = agent.sourcePath
    const ext = path.extname(filePath).toLowerCase()
    const content = readFileSync(filePath, 'utf-8')
    const nextAgent = {
      ...agent,
      ...updates,
      name: normalizeAgentName(updates.name) || agent.name,
      role: normalizeAgentName(updates.role) || normalizeAgentName(updates.name) || agent.role,
      description: updates.description !== undefined ? String(updates.description || '').trim() : agent.description,
      instructions: updates.instructions !== undefined ? String(updates.instructions || '').trim() : agent.instructions,
      skillMode: updates.skillMode !== undefined
        ? (updates.skillMode === 'custom' ? 'custom' : 'all')
        : agent.skillMode,
      allowedSkills: updates.allowedSkills !== undefined
        ? normalizeSkillList(updates.allowedSkills)
        : agent.allowedSkills
    }

    if (ext === '.json') {
      const existingConfig = JSON.parse(content)
      writeJsonAgent(filePath, nextAgent, existingConfig)
    } else {
      const parsed = parseMarkdownAgent(content)
      writeMarkdownAgent(filePath, nextAgent, parsed.frontmatter)
    }

    this.refreshClaudeCodeAgents()
    const updatedAgent = this.getAgentById(id)
    broadcastAgentUpdated(id, { updated: true })
    return updatedAgent
  },

  updateAgentHeartbeat(id) {
    const agent = this.getAgentById(id)
    if (agent) {
      agent.lastHeartbeat = new Date().toISOString()
      agent.status = 'idle'
      this.save()
    }
    return agent
  },

  // 释放 Agent（任务完成后调用）
  releaseAgent(agentId, taskId = null) {
    const agent = this.getAgentById(agentId)
    if (agent) {
      agent.currentTaskId = null
      agent.status = 'idle'
      this.save()
      console.log(`[DB] Released agent ${agent.name}`)
      broadcastAgentUpdated(agentId)
    }
    // 清除任务的 assignedAgentId（如果有）
    if (taskId) {
      const task = this.getTaskById(taskId)
      if (task) {
        task.assignedAgentId = null
        this.save()
        console.log(`[DB] Cleared assignedAgentId for task ${taskId}`)
        broadcastTaskUpdated(taskId)
      }
    }
    return !!agent
  },

  // ============ Tasks ============

  getTasks(filters = {}) {
    let tasks = [...this._data.tasks]

    if (filters.status) {
      tasks = tasks.filter(t => t.status === filters.status)
    }

    if (filters.agentId) {
      tasks = tasks.filter(t => t.assignedAgentId === filters.agentId)
    }

    return tasks
  },

  getTaskById(id) {
    const task = this._data.tasks.find(t => t.id === id)
    if (task) {
      ensureTaskShape(task)
    }
    return task
  },

  deleteTask(id) {
    const index = this._data.tasks.findIndex(t => t.id === id)
    if (index === -1) return false
    this._data.tasks.splice(index, 1)
    this.save()
    broadcastTaskUpdated(id, { deleted: true })
    return true
  },

  getBoard() {
    const statuses = ['Backlog', 'Analyzing', 'Collecting', 'InDev', 'ReadyForTest', 'InFix', 'Blocked', 'ReadyForDeploy', 'Done']
    const board = {}

    for (const status of statuses) {
      board[status] = this._data.tasks
        .filter(t => t.status === status)
        .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))
    }

    return board
  },

  createTask(task) {
    const parsedDepth = Number.parseInt(task.depth, 10)
    const taskDepth = Number.isInteger(parsedDepth) && parsedDepth > 0 ? parsedDepth : 1
    const parsedMaxDepth = Number.parseInt(task.maxDecompositionDepth, 10)
    const taskMaxDecompositionDepth = Number.isInteger(parsedMaxDepth) && parsedMaxDepth > 0
      ? Math.max(parsedMaxDepth, taskDepth)
      : 3

    // 主任务分配新标签，子任务继承父任务标签
    let taskTag = null
    if (task.parentTaskId) {
      // 子任务继承父任务标签
      const parent = this.getTaskById(task.parentTaskId)
      if (parent) {
        taskTag = parent.taskTag
      }
    } else {
      // 主任务分配新标签
      this._data.taskTagCounter++
      taskTag = this._data.taskTagCounter
    }

    const newTask = {
      id: genId(),
      title: task.title,
      description: task.description || '',
      originalDescription: task.description || '',
      operationFolder: typeof task.operationFolder === 'string' ? task.operationFolder.trim() : '',
      status: task.status || 'Backlog',
      linkedTaskId: task.linkedTaskId || null,
      followUpSourceTaskId: task.followUpSourceTaskId || null,
      sourceTaskTag: Number.isInteger(Number(task.sourceTaskTag)) ? Number(task.sourceTaskTag) : null,
      followUpReason: typeof task.followUpReason === 'string' ? task.followUpReason.trim() : null,
      assignedAgentId: null,
      skills: task.skills || [],
      loopCount: 0,
      bugReport: null,
      attachments: {},
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
      verificationPlan: Array.isArray(task.verificationPlan) ? task.verificationPlan : [],
      qaRubric: task.qaRubric || null,
      handoffArtifacts: Array.isArray(task.handoffArtifacts) ? task.handoffArtifacts : [],
      artifactManifest: [],
      mountedArtifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 父子任务关联
      parentTaskId: task.parentTaskId || null,
      taskTag: taskTag,  // 任务标签序号
      subTaskIds: [],
      dependsOnSubTaskIds: [],
      dependencyRefs: [],
      blockedBySubTasks: [],
      dependencyBlockedSummary: null,
      skipAsDependency: false,
      skipReason: null,
      skippedAt: null,
      depth: taskDepth,
      maxDecompositionDepth: taskMaxDecompositionDepth,
      canExecuteDirectly: task.canExecuteDirectly !== false,
      shouldDecomposeFurther: Boolean(task.shouldDecomposeFurther),
      decompositionReason: typeof task.decompositionReason === 'string' ? task.decompositionReason : '',
      riskSignals: Array.isArray(task.riskSignals) ? task.riskSignals : [],
      workspace: {
        path: '',
        status: 'none',
        retainedForQa: false,
        lastExecutionAt: null,
        lastVerifiedAt: null,
        cleanedAt: null,
        updatedAt: new Date().toISOString()
      },
      decompositionNote: '',
      // 终端风格信息流
      currentOutput: '',      // 当前输出（卡片上显示的实时内容）
      outputLines: [],        // 输出行历史（完整信息流）
      messages: []            // 用户/系统消息（任务对话）
    }
    ensureTaskShape(newTask)
    this._data.tasks.push(newTask)
    this.save()
    broadcastTaskUpdated(newTask.id)
    return newTask
  },

  // 创建子任务
  createSubTask(parentTaskId, title, description, meta = {}) {
    const parent = this.getTaskById(parentTaskId)
    if (!parent) return null
    const parentDepth = Number.parseInt(parent.depth, 10)
    const normalizedParentDepth = Number.isInteger(parentDepth) && parentDepth > 0 ? parentDepth : 1
    const parentMaxDepth = Number.parseInt(parent.maxDecompositionDepth, 10)

    const subTask = this.createTask({
      title,
      description,
      status: 'Backlog',
      parentTaskId,
      operationFolder: parent.operationFolder || '',
      depth: normalizedParentDepth + 1,
      maxDecompositionDepth: Number.isInteger(parentMaxDepth) && parentMaxDepth > 0
        ? parentMaxDepth
        : 3
    })

    subTask.sequenceIndex = Number.isInteger(meta.sequenceIndex) ? meta.sequenceIndex : parent.subTaskIds.length
    subTask.dependsOnSubTaskIds = Array.isArray(meta.dependsOnSubTaskIds) ? meta.dependsOnSubTaskIds : []
    subTask.dependencyRefs = Array.isArray(meta.dependencyRefs) ? meta.dependencyRefs : []
    subTask.parallelGroup = meta.parallelGroup || null
    subTask.canRunInParallel = meta.canRunInParallel !== false
    subTask.acceptanceCriteria = Array.isArray(meta.acceptanceCriteria) ? meta.acceptanceCriteria : []
    subTask.verificationPlan = Array.isArray(meta.verificationPlan) ? meta.verificationPlan : []
    subTask.qaRubric = meta.qaRubric || null
    subTask.handoffArtifacts = Array.isArray(meta.handoffArtifacts) ? meta.handoffArtifacts : []
    subTask.decompositionReason = typeof meta.decompositionReason === 'string' ? meta.decompositionReason.trim() : ''
    subTask.riskSignals = Array.isArray(meta.riskSignals)
      ? meta.riskSignals.map(item => String(item || '').trim()).filter(Boolean)
      : []
    subTask.shouldDecomposeFurther = Boolean(meta.shouldDecomposeFurther) && subTask.depth < subTask.maxDecompositionDepth
    subTask.canExecuteDirectly = subTask.shouldDecomposeFurther ? false : meta.canExecuteDirectly !== false
    subTask.updatedAt = new Date().toISOString()

    // 更新父任务的 subTaskIds
    parent.subTaskIds.push(subTask.id)
    parent.updatedAt = new Date().toISOString()
    this.save()

    return subTask
  },

  createFollowUpTaskFromCompletedTask(sourceTaskId, requirement, options = {}) {
    const sourceTask = this.getTaskById(sourceTaskId)
    const normalizedRequirement = normalizeTaskText(requirement)
    if (!sourceTask || !normalizedRequirement) return null

    const parentTask = sourceTask.parentTaskId ? this.getTaskById(sourceTask.parentTaskId) : null
    const wiki = sourceTask.taskTag ? this.getWikiByTaskTag(sourceTask.taskTag) : null
    const sourceMessages = this.getTaskMessages(sourceTask.id)
    const title = buildFollowUpTaskTitle(sourceTask, normalizedRequirement)
    const description = buildFollowUpTaskDescription(sourceTask, normalizedRequirement, {
      parentTask,
      wiki,
      messages: sourceMessages
    })

    const followUpTask = this.createTask({
      title,
      description,
      status: options.status || 'Backlog',
      operationFolder: options.operationFolder ?? sourceTask.operationFolder ?? '',
      skills: Array.isArray(sourceTask.skills) ? [...sourceTask.skills] : [],
      linkedTaskId: sourceTask.id,
      followUpSourceTaskId: sourceTask.id,
      sourceTaskTag: sourceTask.taskTag ?? null,
      followUpReason: normalizedRequirement
    })

    followUpTask.originalDescription = normalizedRequirement
    followUpTask.linkedTaskId = sourceTask.id
    followUpTask.followUpSourceTaskId = sourceTask.id
    followUpTask.sourceTaskTag = sourceTask.taskTag ?? null
    followUpTask.followUpReason = normalizedRequirement
    followUpTask.updatedAt = new Date().toISOString()
    this.save()
    broadcastTaskUpdated(followUpTask.id)

    this.addTaskMessage(followUpTask.id, {
      role: 'system',
      kind: 'system',
      content: `该任务由已完成任务「${sourceTask.title}」的补充需求创建，来源任务保持已完成。`,
      meta: {
        sourceTaskId: sourceTask.id,
        sourceTaskTag: sourceTask.taskTag || null
      }
    })
    this.addTaskMessage(followUpTask.id, {
      role: 'user',
      kind: 'user',
      content: normalizedRequirement,
      meta: {
        importedFromTaskId: sourceTask.id,
        followUp: true
      }
    })
    this.addTaskLog(followUpTask.id, {
      action: '补充任务创建',
      message: `来源任务：${sourceTask.title}（${sourceTask.id}）`
    })
    this.appendTaskOutput(
      followUpTask.id,
      `[系统] 已基于已完成任务「${sourceTask.title}」创建补充任务，等待调度。`
    )

    return this.getTaskById(followUpTask.id)
  },

  // 获取子任务列表
  getSubTasks(parentTaskId) {
    const parent = this.getTaskById(parentTaskId)
    if (!parent || !parent.subTaskIds) return []
    return parent.subTaskIds
      .map(id => this.getTaskById(id))
      .filter(t => t !== undefined)
  },

  // 检查并更新父任务状态（当子任务完成时调用）
  checkAndUpdateParentCompletion(subTaskId) {
    const subTask = this.getTaskById(subTaskId)
    if (!subTask || !subTask.parentTaskId) return

    const parent = this.getTaskById(subTask.parentTaskId)
    if (!parent) return

    const subTasks = this.getSubTasks(parent.id)
    const activeSubTasks = subTasks.filter(t => !t.skipAsDependency)
    const blockedSubTasks = activeSubTasks.filter(t => t.status === 'Blocked')
    const allResolved = subTasks.length > 0 && subTasks.every(t => t.status === 'Done' || t.skipAsDependency)
    const hadDependencyBlock = Boolean(parent.dependencyBlockedSummary) || (parent.blockedBySubTasks || []).length > 0
    const nextBlockedBySubTasks = blockedSubTasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      blockedReason: task.blockedReason || task.bugReport || '',
      updatedAt: task.updatedAt
    }))
    const nextDependencyBlockedSummary = nextBlockedBySubTasks.length > 0
      ? nextBlockedBySubTasks
        .map(task => `${task.title}${task.blockedReason ? `：${task.blockedReason}` : ''}`)
        .join('；')
      : null

    parent.blockedBySubTasks = nextBlockedBySubTasks
    parent.dependencyBlockedSummary = nextDependencyBlockedSummary

    if (allResolved) {
      if (parent.status !== 'ReadyForTest' && parent.status !== 'Done') {
        // 汇总所有子任务的输出到父任务
        const allOutputs = []
        for (const st of activeSubTasks) {
          if (st.outputLines && st.outputLines.length > 0) {
            allOutputs.push(...st.outputLines.slice(-5)) // 只取最后5条
          }
        }
        if (allOutputs.length > 0) {
          parent.outputLines = [...(parent.outputLines || []), ...allOutputs]
          if (parent.outputLines.length > 50) {
            parent.outputLines = parent.outputLines.slice(-50)
          }
        }

        parent.blockedReason = null
        parent.updatedAt = new Date().toISOString()
        this.updateTaskStatus(parent.id, 'ReadyForTest')
        console.log(`[DB] Parent task ${parent.id} all subtasks done, moving to ReadyForTest`)
        return
      }
    }

    if (blockedSubTasks.length > 0) {
      parent.blockedReason = nextDependencyBlockedSummary
      parent.updatedAt = new Date().toISOString()

      if (parent.status !== 'Blocked') {
        this.updateTaskStatus(parent.id, 'Blocked')
        return
      }

      this.save()
      broadcastTaskUpdated(parent.id, { status: parent.status })
      return
    }

    if (hadDependencyBlock) {
      if (parent.blockedReason === nextDependencyBlockedSummary || !nextDependencyBlockedSummary) {
        parent.blockedReason = null
      }
      parent.updatedAt = new Date().toISOString()

      if (parent.status === 'Blocked') {
        this.updateTaskStatus(parent.id, 'InDev')
        return
      }
    }

    parent.updatedAt = new Date().toISOString()
    this.save()
    broadcastTaskUpdated(parent.id, { status: parent.status })
  },

  updateTaskStatus(id, status, operatorId) {
    const task = this.getTaskById(id)
    if (!task) return null

    const fromStatus = task.status
    task.status = status
    task.updatedAt = new Date().toISOString()
    if (status !== 'Backlog') {
      delete task.retryAfter
      delete task.transientError
    }

    const resolvedStatuses = new Set(['ReadyForTest', 'ReadyForDeploy', 'Done'])
    if (resolvedStatuses.has(status)) {
      task.bugReport = null
      task.blockedReason = null
      task.dependencyBlockedSummary = null
      task.blockedBySubTasks = []
    }

    const activeStatuses = new Set(['Analyzing', 'InDev'])
    if (!activeStatuses.has(status) && task.assignedAgentId) {
      const assignedAgent = this.getAgentById(task.assignedAgentId)
      if (assignedAgent && assignedAgent.currentTaskId === id) {
        assignedAgent.currentTaskId = null
        assignedAgent.status = 'idle'
        assignedAgent.lastHeartbeat = new Date().toISOString()
        broadcastAgentUpdated(assignedAgent.id)
      }
      task.assignedAgentId = null
    }

    // 记录历史
    this._data.taskHistory.push({
      id: genId(),
      taskId: id,
      fromStatus,
      toStatus: status,
      operatorId: operatorId || null,
      createdAt: new Date().toISOString()
    })

    this.save()
    broadcastTaskUpdated(id, { status })

    if (task.parentTaskId) {
      this.checkAndUpdateParentCompletion(id)
    }

    return { task, fromStatus }
  },

  claimTask(taskId, agentId) {
    const task = this.getTaskById(taskId)
    if (!task || task.assignedAgentId) return null

    const agent = this.getAgentById(agentId)
    if (!agent) return null

    task.assignedAgentId = agentId
    task.status = 'InDev'
    task.updatedAt = new Date().toISOString()
    delete task.retryAfter
    delete task.transientError

    agent.currentTaskId = taskId
    agent.status = 'busy'

    this.save()
    broadcastTaskUpdated(taskId, { status: task.status })
    broadcastAgentUpdated(agentId)
    return { task, agent }
  },

  reportBug(taskId, bugReport) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    const normalizedBugReport = normalizeTaskText(bugReport)
    if (!task.originalDescription) {
      task.originalDescription = extractOriginalTaskRequirement(task)
    }

    task.bugReport = normalizedBugReport
    task.updatedAt = new Date().toISOString()

    // 如果是子任务，在描述中追加父任务上下文，帮助后续 agent 理解完整背景
    if (task.parentTaskId) {
      const parent = this.getTaskById(task.parentTaskId)
      if (parent) {
        task.description = buildRetryDescription(task, parent, normalizedBugReport)
      }
    } else {
      task.description = buildRetryDescription(task, null, normalizedBugReport)
    }

    // 检测是否是不可解决的阻塞（如信息不全、无输出等）
    const blockingKeywords = ['无输出', '无实质性输出', '信息不全', '缺少关键信息', '无法执行', '缺少必要参数']
    const isBlocked = blockingKeywords.some(k => normalizedBugReport.includes(k))

    // 任务状态：阻塞任务进入 Blocked 状态，正常验证失败进入 InFix
    task.status = isBlocked ? 'Blocked' : 'InFix'
    const assignedAgent = task.assignedAgentId ? this.getAgentById(task.assignedAgentId) : null
    if (assignedAgent && assignedAgent.currentTaskId === taskId) {
      assignedAgent.currentTaskId = null
      assignedAgent.status = 'idle'
      assignedAgent.lastHeartbeat = new Date().toISOString()
      broadcastAgentUpdated(assignedAgent.id)
    }
    // 清除 assignedAgentId，让任务可以被重新认领
    task.assignedAgentId = null
    // 阻塞任务不增加 loopCount（因为重试也没用）
    if (!isBlocked) {
      task.loopCount++
    }
    task.skipAsDependency = false
    task.skipReason = null
    task.skippedAt = null
    task.blockedReason = isBlocked ? normalizedBugReport : null
    task.workspace.status = isBlocked ? 'blocked' : 'retained_for_fix'
    task.workspace.retainedForQa = false
    task.workspace.updatedAt = new Date().toISOString()

    // 记录历史
    this._data.taskHistory.push({
      id: genId(),
      taskId,
      fromStatus: 'InDev',
      toStatus: task.status,
      operatorId: null,
      note: normalizedBugReport,
      createdAt: new Date().toISOString()
    })

    this.save()
    broadcastTaskUpdated(taskId, { status: task.status })
    if (task.parentTaskId) {
      this.checkAndUpdateParentCompletion(taskId)
    }
    return { task, blocked: isBlocked, loopCount: task.loopCount }
  },

  updateTaskWorkspace(taskId, updates = {}) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    task.workspace = {
      ...task.workspace,
      ...updates,
      retainedForQa: updates.retainedForQa !== undefined
        ? Boolean(updates.retainedForQa)
        : Boolean(task.workspace.retainedForQa),
      updatedAt: new Date().toISOString()
    }
    task.updatedAt = new Date().toISOString()
    this.save()
    broadcastTaskUpdated(taskId)
    return task.workspace
  },

  updateTaskArtifacts(taskId, artifactManifest = [], meta = {}) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    task.artifactManifest = Array.isArray(artifactManifest) ? artifactManifest : []
    if (meta.workspacePath !== undefined) {
      task.workspace.path = meta.workspacePath || ''
    }
    if (meta.workspaceStatus !== undefined) {
      task.workspace.status = meta.workspaceStatus || task.workspace.status
    }
    if (meta.retainedForQa !== undefined) {
      task.workspace.retainedForQa = Boolean(meta.retainedForQa)
    }
    if (meta.lastExecutionAt) {
      task.workspace.lastExecutionAt = meta.lastExecutionAt
    }
    if (meta.lastVerifiedAt) {
      task.workspace.lastVerifiedAt = meta.lastVerifiedAt
    }
    task.workspace.updatedAt = new Date().toISOString()
    task.updatedAt = new Date().toISOString()
    this.save()
    broadcastTaskUpdated(taskId)
    return task.artifactManifest
  },

  updateTaskMountedArtifacts(taskId, mountedArtifacts = []) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    task.mountedArtifacts = Array.isArray(mountedArtifacts) ? mountedArtifacts : []
    task.updatedAt = new Date().toISOString()
    this.save()
    broadcastTaskUpdated(taskId)
    return task.mountedArtifacts
  },

  reopenTask(taskId, options = {}) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    const nextStatus = options.status || 'Backlog'
    const note = normalizeTaskText(options.note)

    task.skipAsDependency = false
    task.skipReason = null
    task.skippedAt = null
    task.blockedReason = null
    task.bugReport = null
    task.maxRetryBlockedAt = null
    task.updatedAt = new Date().toISOString()
    task.workspace.status = task.workspace.path ? 'retained_for_fix' : 'none'
    task.workspace.retainedForQa = false
    task.workspace.updatedAt = new Date().toISOString()

    const result = this.updateTaskStatus(taskId, nextStatus, options.operatorId || null)
    if (!result) return null

    this.addTaskLog(taskId, {
      agentId: options.operatorId || null,
      action: '重新打开',
      message: note || `任务已重新打开，状态恢复为 ${nextStatus}`
    })

    return this.getTaskById(taskId)
  },

  skipTaskAsDependency(taskId, options = {}) {
    const task = this.getTaskById(taskId)
    if (!task || !task.parentTaskId) return null

    const reason = normalizeTaskText(options.reason) || '人工决定跳过该子任务依赖'
    const operatorId = options.operatorId || null

    task.skipAsDependency = true
    task.skipReason = reason
    task.skippedAt = new Date().toISOString()
    task.blockedReason = null
    task.bugReport = null
    task.workspace.retainedForQa = false
    task.workspace.status = task.workspace.path ? 'skipped' : 'none'
    task.workspace.updatedAt = new Date().toISOString()

    const fromStatus = task.status
    task.status = 'Done'
    task.updatedAt = new Date().toISOString()

    this._data.taskHistory.push({
      id: genId(),
      taskId,
      fromStatus,
      toStatus: 'Done',
      operatorId,
      note: `跳过依赖: ${reason}`,
      createdAt: new Date().toISOString()
    })

    this.save()
    this.addTaskLog(taskId, {
      agentId: operatorId,
      action: '跳过依赖',
      message: reason
    })
    broadcastTaskUpdated(taskId, { status: task.status })
    this.checkAndUpdateParentCompletion(taskId)
    return this.getTaskById(taskId)
  },

  // ============ Task Logs ============

  getTaskHistory(taskId) {
    return this._data.taskHistory
      .filter(h => h.taskId === taskId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  },

  getTaskLogs(taskId) {
    return this._data.taskLogs
      .filter(l => l.taskId === taskId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  },

  addTaskLog(taskId, log) {
    const newLog = {
      id: genId(),
      taskId,
      agentId: log.agentId || null,
      action: log.action,
      message: log.message || null,
      createdAt: new Date().toISOString()
    }
    this._data.taskLogs.push(newLog)
    this.queueSave()
    broadcastTaskUpdated(taskId)
    return newLog
  },

  getTaskMessages(taskId) {
    const task = this.getTaskById(taskId)
    if (!task) return []
    if (!Array.isArray(task.messages)) {
      task.messages = []
    }
    return [...task.messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  },

  addTaskMessage(taskId, message) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    const content = String(message.content || '').trim()
    if (!content) return null

    if (!Array.isArray(task.messages)) {
      task.messages = []
    }

    const newMessage = {
      id: genId(),
      role: message.role || 'system',
      kind: message.kind || message.role || 'system',
      content,
      createdAt: new Date().toISOString(),
      meta: message.meta || {}
    }

    task.messages.push(newMessage)
    if (task.messages.length > 50) {
      task.messages = task.messages.slice(-50)
    }
    task.updatedAt = new Date().toISOString()
    this.queueSave()

    broadcast({
      type: 'task_message',
      taskId,
      message: newMessage
    })
    broadcastTaskUpdated(taskId)

    return newMessage
  },

  emitTaskRefresh(taskId, extra = {}) {
    const task = this.getTaskById(taskId)
    if (!task) return false
    task.updatedAt = new Date().toISOString()
    this.queueSave()
    broadcastTaskUpdated(taskId, extra)
    return true
  },

  // 追加任务输出行（跳过空行）
  appendTaskOutput(taskId, line) {
    const task = this.getTaskById(taskId)
    if (!task) return null

    // 跳过空行（不存储、不广播）
    if (line === undefined || line === null || line.trim() === '') {
      return null
    }

    const outputLine = {
      id: genId(),
      content: line,
      timestamp: new Date().toISOString()
    }

    task.outputLines.push(outputLine)
    // 保留最近50行
    if (task.outputLines.length > 50) {
      task.outputLines = task.outputLines.slice(-50)
    }
    task.currentOutput = line // 最新一行作为卡片显示
    task.updatedAt = new Date().toISOString()
    this.queueSave()

    // 广播到所有 WebSocket 客户端（实时推送终端输出）
    broadcast({
      type: 'task_output',
      taskId,
      line: line,
      outputLine,
      currentOutput: task.currentOutput
    })

    return outputLine
  },

  // 清除任务输出
  clearTaskOutput(taskId) {
    const task = this.getTaskById(taskId)
    if (!task) return false
    task.outputLines = []
    task.currentOutput = ''
    this.queueSave()

    // 广播清除事件到所有 WebSocket 客户端
    broadcast({ type: 'task_output_cleared', taskId })
    return true
  },

  // ============ Stats ============

  getStats() {
    const totalTasks = this._data.tasks.length
    // 调用 getAgents() 确保 Claude Code agents 已加载
    const allAgents = this.getAgents()
    const totalAgents = allAgents.length
    const onlineAgents = allAgents.filter(a => a.status !== 'offline').length

    const byStatus = {}
    for (const task of this._data.tasks) {
      byStatus[task.status] = (byStatus[task.status] || 0) + 1
    }

    return { totalTasks, totalAgents, onlineAgents, byStatus }
  },

  // ============ Wiki ============

  // 创建 Wiki
  createWiki(wiki) {
    if (!this._data.wikis) {
      this._data.wikis = []
    }
    const newWiki = {
      id: genId(),
      title: wiki.title || '',
      content: wiki.content || '',
      keywords: wiki.keywords || [],
      taskTag: wiki.taskTag || null,
      parentTaskId: wiki.parentTaskId || null,
      subTaskIds: wiki.subTaskIds || [],
      sourceSummary: wiki.sourceSummary || null,
      artifactPaths: wiki.artifactPaths || [],
      generatedFromTaskIds: wiki.generatedFromTaskIds || [],
      requirementHighlights: wiki.requirementHighlights || [],
      decisionHighlights: wiki.decisionHighlights || [],
      issueHighlights: wiki.issueHighlights || [],
      verificationHighlights: wiki.verificationHighlights || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    this._data.wikis.push(newWiki)
    this.save()
    console.log(`[DB] Created wiki: ${newWiki.title} (id: ${newWiki.id})`)
    return newWiki
  },

  // 获取所有 Wiki
  getWikis() {
    if (!this._data.wikis) {
      this._data.wikis = []
    }
    return this._data.wikis
  },

  // 根据 ID 获取 Wiki
  getWikiById(id) {
    return this._data.wikis.find(w => w.id === id)
  },

  // 根据 taskTag 获取 Wiki
  getWikiByTaskTag(taskTag) {
    return this._data.wikis.find(w => w.taskTag === taskTag)
  },

  // 获取 Wiki 数量
  getWikiCount() {
    return (this._data.wikis || []).length
  },

  // ============ Skill 沉淀统计 ============

  // 获取沉淀的 Skill 数量（通过统计 skills/沉淀/ 目录下的文件）
  getSkillPrecipitatedCount() {
    try {
      const skillsDir = path.join(process.cwd(), 'skills', '沉淀')
      if (!existsSync(skillsDir)) {
        return 0
      }
      const files = readdirSync(skillsDir).filter(f => f.endsWith('.skill.md'))
      return files.length
    } catch (e) {
      console.error('[DB] Error counting precipitated skills:', e.message)
      return 0
    }
  },

  // ============ 调度器配置 ============

  // 获取调度器配置
  getSchedulerConfig() {
    return this._data.schedulerConfig || { maxConcurrentAgents: 5 }
  },

  // 更新调度器配置
  updateSchedulerConfig(config) {
    if (!this._data.schedulerConfig) {
      this._data.schedulerConfig = {}
    }
    if (config.maxConcurrentAgents !== undefined) {
      this._data.schedulerConfig.maxConcurrentAgents = config.maxConcurrentAgents
    }
    this.save()
    return this._data.schedulerConfig
  }
}

process.on('exit', () => {
  if (db._pendingSaveTimer) {
    clearTimeout(db._pendingSaveTimer)
    db._pendingSaveTimer = null
    db._pendingSaveStartedAt = null
    saveData(db._data)
  }
})

// 首次加载时迁移旧任务数据
db.migrateTaskTags()
db.migrateTaskMetadata()

export default db
