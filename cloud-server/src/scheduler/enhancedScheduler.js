/**
 * 增强的调度器
 *
 * 支持：
 * - 并发控制 (maxConcurrentAgents)
 * - 任务优先级
 * - Workspace 隔离
 * - 生命周期管理
 */

import fs from 'fs'
import path from 'path'
import db from '../db.js'
import workspaceManager from '../workspace.js'
import workflowManager from '../workflow.js'
import { collectVerificationEvidence } from '../verificationEvidence.js'
import { getClaudeCliLaunchSpec } from '../claudePaths.js'

const CLAUDE_LAUNCH_SPEC = getClaudeCliLaunchSpec()
const AGENT_NAME_MAP = {
  developer: 'executor',
  tester: 'qa-tester',
  deployer: 'executor',
  architect: 'architect',
  planner: 'planner',
  reviewer: 'code-reviewer'
}
const EXECUTION_PROCESS_FAILURE_RETRY_DELAY_MS = 60000
const EXECUTION_PROCESS_FAILURE_MAX_COUNT = 3
const FAILURE_LOG_DEDUPE_WINDOW_MS = 15000

export class EnhancedScheduler {
  constructor(options = {}) {
    // 从数据库加载配置（优先级：数据库 > options > 默认值）
    const savedConfig = db.getSchedulerConfig()
    const savedMax = savedConfig?.maxConcurrentAgents
    // 优先使用数据库中的值，只有当数据库没有时才用 options 或默认值
    this.maxConcurrentAgents = (savedMax !== undefined && savedMax !== null)
      ? savedMax
      : (options.maxConcurrentAgents || 5)
    this.activeTasks = new Map() // taskId -> { task, agent, startedAt, turns }
    this.taskQueue = []
    this.running = false
    this.isScheduling = false // 防止并发调度
    this.pollInterval = options.pollInterval || 5000
    this.pollTimer = null
    this.onTaskDone = null // Task 完成时的 hook callback
    this.onToolUse = null // Tool 执行完成时的 hook callback (PostToolUse)
    this.onStop = null // 会话结束时的 hook callback (Stop Hook)
    this.pendingImmediateSchedule = false
  }

  /**
   * 获取当前活跃任务数
   */
  getActiveCount() {
    return this.activeTasks.size
  }

  /**
   * 检查是否可以启动新任务
   */
  canAcceptTask() {
    return this.activeTasks.size < this.maxConcurrentAgents
  }

  getRecentUserMessages(task, limit = 6) {
    if (!Array.isArray(task?.messages)) return []
    return task.messages
      .filter(message => message && message.role === 'user' && message.content)
      .slice(-limit)
  }

  buildConversationContext(task, limit = 6) {
    const recentMessages = this.getRecentUserMessages(task, limit)
    if (recentMessages.length === 0) {
      return ''
    }

    const lines = recentMessages.map((message, index) => {
      const time = message.createdAt ? new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间'
      const content = String(message.content || '').trim().slice(0, 500)
      return `${index + 1}. [${time}] ${content}`
    })

    return `\n\n【最近用户补充/对话】\n${lines.join('\n')}`
  }

  normalizeStringArray(value) {
    if (!Array.isArray(value)) return []
    return value
      .map(item => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') return JSON.stringify(item)
        return ''
      })
      .filter(Boolean)
  }

  getRolePriorityList(taskType) {
    const rolePriority = {
      analysis: ['planner', 'analyst', 'architect'],
      verification: ['qa-tester', 'verifier', 'test-engineer', 'code-reviewer', 'critic'],
      execution: ['executor', 'debugger', 'code-simplifier', 'scientist', 'analyst', 'critic', 'architect']
    }

    return rolePriority[taskType] || []
  }

  getRolePriorityBonus(role, taskType) {
    const priorityList = this.getRolePriorityList(taskType)
    const index = priorityList.indexOf(role)
    return index === -1 ? 0 : Math.max(priorityList.length - index, 1)
  }

  agentDisallowsImplementation(agent) {
    const disallowedTools = this.normalizeStringArray(agent?.disallowedTools).map(item => item.toLowerCase())
    if (disallowedTools.includes('write') || disallowedTools.includes('edit')) {
      return true
    }

    const instructions = String(agent?.instructions || '').toLowerCase()
    return instructions.includes('read-only') ||
      instructions.includes('read only') ||
      instructions.includes('not responsible for implementing changes')
  }

  scoreExecutionAgentForTask(task, agent) {
    const role = String(agent?.role || '').trim()
    const title = String(task?.title || '').toLowerCase()
    const description = String(task?.description || '').toLowerCase()
    const combined = `${title} ${description}`
    const scoreBreakdown = []
    let score = this.getRolePriorityBonus(role, 'execution')

    if (score > 0) {
      scoreBreakdown.push({ reason: 'execution priority', score })
    }

    const signalGroups = [
      {
        name: 'implementation',
        keywords: ['代码', '开发', '实现', '功能', '模块', '页面', '前端', '后端', '接口', '组件', '导航', '集成', '落地'],
        roleWeights: {
          executor: 10,
          'code-simplifier': 7,
          debugger: 4,
          analyst: -1,
          architect: -6,
          critic: -2
        }
      },
      {
        name: 'fix',
        keywords: ['修复', '调试', 'bug', '问题', '错误', '异常', '失败', '卡住'],
        roleWeights: {
          debugger: 10,
          executor: 7,
          'code-simplifier': 5,
          architect: -3
        }
      },
      {
        name: 'research',
        keywords: ['分析', '研究', '调研', '数据', '市场', '行情'],
        roleWeights: {
          scientist: 9,
          analyst: 7,
          explorer: 6,
          executor: -2
        }
      },
      {
        name: 'architecture',
        keywords: ['架构', '技术选型', '系统设计', '架构设计'],
        roleWeights: {
          architect: 10,
          analyst: 3,
          executor: -2
        }
      },
      {
        name: 'verification',
        keywords: ['测试', '验证', '质检', 'qa'],
        roleWeights: {
          'qa-tester': 10,
          verifier: 9,
          'test-engineer': 9,
          'code-reviewer': 5,
          executor: 1
        }
      },
      {
        name: 'review',
        keywords: ['审查', '评审', '代码规范', '安全', '风险'],
        roleWeights: {
          'code-reviewer': 10,
          'security-reviewer': 9,
          critic: 7,
          architect: 3
        }
      },
      {
        name: 'documentation',
        keywords: ['文档', 'readme', '撰写', '写作'],
        roleWeights: {
          writer: 10,
          'document-specialist': 9,
          executor: 1
        }
      },
      {
        name: 'exploration',
        keywords: ['搜索', '查找', '探索', '发现'],
        roleWeights: {
          explorer: 10,
          scientist: 6,
          analyst: 5,
          executor: -1
        }
      }
    ]

    let implementationSignal = false
    let architectureSignal = false

    for (const group of signalGroups) {
      const matchedKeywords = group.keywords.filter(keyword => combined.includes(keyword))
      if (matchedKeywords.length === 0) continue

      if (group.name === 'implementation' || group.name === 'fix') {
        implementationSignal = true
      }
      if (group.name === 'architecture') {
        architectureSignal = true
      }

      const delta = group.roleWeights[role] || 0
      if (delta !== 0) {
        score += delta
        scoreBreakdown.push({
          reason: `${group.name}: ${matchedKeywords.join(', ')}`,
          score: delta
        })
      }
    }

    if (Array.isArray(task?.handoffArtifacts) && task.handoffArtifacts.length > 0) {
      const artifactDelta = ['executor', 'code-simplifier', 'debugger'].includes(role) ? 2 : 0
      if (artifactDelta !== 0) {
        score += artifactDelta
        scoreBreakdown.push({ reason: 'artifact handoff', score: artifactDelta })
      }
    }

    if (task?.status === 'InFix' && role === 'debugger') {
      score += 4
      scoreBreakdown.push({ reason: 'InFix status', score: 4 })
    }

    if (task?.status === 'InDev' && role === 'executor') {
      score += 3
      scoreBreakdown.push({ reason: 'InDev status', score: 3 })
    }

    if (implementationSignal && this.agentDisallowsImplementation(agent)) {
      score -= 16
      scoreBreakdown.push({ reason: 'read-only penalty', score: -16 })
    } else if (this.agentDisallowsImplementation(agent) && !architectureSignal) {
      score -= 4
      scoreBreakdown.push({ reason: 'limited execution penalty', score: -4 })
    }

    if (implementationSignal && ['architect', 'analyst', 'explorer', 'critic', 'code-reviewer'].includes(role)) {
      score -= 4
      scoreBreakdown.push({ reason: 'implementation mismatch', score: -4 })
    }

    if (architectureSignal && role === 'architect') {
      score += 4
      scoreBreakdown.push({ reason: 'architecture fit', score: 4 })
    }

    return {
      score,
      scoreBreakdown
    }
  }

  buildContractContext(task) {
    const acceptanceCriteria = this.normalizeStringArray(task?.acceptanceCriteria)
    const verificationPlan = this.normalizeStringArray(task?.verificationPlan)
    const handoffArtifacts = this.normalizeStringArray(task?.handoffArtifacts)
    const qaRubric = task?.qaRubric && typeof task.qaRubric === 'object'
      ? JSON.stringify(task.qaRubric, null, 2)
      : ''

    if (acceptanceCriteria.length === 0 && verificationPlan.length === 0 && handoffArtifacts.length === 0 && !qaRubric) {
      return ''
    }

    const sections = ['\n\n【冲刺契约】']
    if (acceptanceCriteria.length > 0) {
      sections.push('验收标准:')
      sections.push(...acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`))
    }
    if (verificationPlan.length > 0) {
      sections.push('验证计划:')
      sections.push(...verificationPlan.map((item, index) => `${index + 1}. ${item}`))
    }
    if (handoffArtifacts.length > 0) {
      sections.push('必须交付/交接的工件:')
      sections.push(...handoffArtifacts.map((item, index) => `${index + 1}. ${item}`))
    }
    if (qaRubric) {
      sections.push('QA 评分 Rubric:')
      sections.push(qaRubric)
    }

    return sections.join('\n')
  }

  buildDependencyArtifactContext(task) {
    const dependencyIds = Array.isArray(task?.dependsOnSubTaskIds) ? task.dependsOnSubTaskIds : []
    if (dependencyIds.length === 0) {
      return ''
    }

    const sections = ['\n\n【依赖子任务交接工件】']

    dependencyIds.forEach((dependencyId, index) => {
      const dependencyTask = db.getTaskById(dependencyId)
      if (!dependencyTask) return

      const resolvedArtifacts = (dependencyTask.artifactManifest || [])
        .filter(item => item && item.exists)
        .map(item => item.absolutePath || item.path)
        .filter(Boolean)

      sections.push(`${index + 1}. ${dependencyTask.title}（状态：${dependencyTask.status}）`)
      if (resolvedArtifacts.length > 0) {
        sections.push(`   - 已记录工件：${resolvedArtifacts.join('；')}`)
      } else if ((dependencyTask.handoffArtifacts || []).length > 0) {
        sections.push(`   - 契约工件：${dependencyTask.handoffArtifacts.join('；')}`)
      } else {
        sections.push('   - 暂无已记录工件')
      }
    })

    return sections.length > 1 ? sections.join('\n') : ''
  }

  buildMountedArtifactContext(task) {
    const mounts = Array.isArray(task?.mountedArtifacts) ? task.mountedArtifacts : []
    if (mounts.length === 0) {
      return ''
    }

    const lines = mounts.slice(0, 20).map((item, index) => {
      const source = item.sourceTaskTitle || item.sourceTaskId || '依赖任务'
      return `${index + 1}. ${item.mountedPath} <- ${source} (${item.sourcePath})`
    })

    return `\n\n【已挂载依赖工件】\n${lines.join('\n')}`
  }

  buildWorkspaceContext(task) {
    if (!task?.workspace?.path) {
      return ''
    }

    return `\n\n【任务工作区】\n路径: ${task.workspace.path}\n状态: ${task.workspace.status || 'unknown'}`
  }

  buildArtifactManifestContext(task) {
    const manifest = Array.isArray(task?.artifactManifest) ? task.artifactManifest : []
    if (manifest.length === 0) {
      return '\n\n【Artifact Manifest】\n系统尚未捕获到可校验的工件路径。'
    }

    const lines = manifest.slice(0, 20).map((item, index) => {
      const status = item.exists ? `存在${item.kind === 'directory' ? '（目录）' : ''}` : '缺失'
      const size = Number.isFinite(item.size) ? `, ${item.size} bytes` : ''
      const required = item.required ? ', 必需' : ''
      return `${index + 1}. ${item.absolutePath} [${status}${size}${required}]`
    })

    return `\n\n【Artifact Manifest】\n${lines.join('\n')}`
  }

  buildOperationFolderContext(task) {
    const operationFolder = String(task?.operationFolder || '').trim()
    if (!operationFolder) {
      return ''
    }

    const existsLabel = fs.existsSync(operationFolder) ? '已存在' : '当前未检测到'
    return `\n\n【指定操作目录】\n- 目标目录: ${operationFolder}\n- 目录状态: ${existsLabel}\n- 这里是用户明确指定的业务目录/资料目录。优先在这个目录及其子目录中查找资料、读取文件和完成修改。\n- 当前任务 workspace 主要用于隔离执行和沉淀工件，不代表真正的业务目录。`
  }

  truncateDisplayText(value, maxLength = 400) {
    if (value === undefined || value === null) {
      return ''
    }

    let text = ''
    if (typeof value === 'string') {
      text = value
    } else {
      try {
        text = JSON.stringify(value, null, 2)
      } catch (error) {
        text = String(value)
      }
    }

    const normalized = String(text).replace(/\r/g, '').trim()
    if (!normalized) {
      return ''
    }

    if (normalized.length <= maxLength) {
      return normalized
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
  }

  extractAssistantText(contentBlocks) {
    if (!Array.isArray(contentBlocks)) {
      return ''
    }

    return contentBlocks
      .filter(block => block?.type === 'text' && block.text)
      .map(block => block.text)
      .join('')
      .trim()
  }

  recordRuntimeToolEvent(taskId, activeTask, phase, event = {}) {
    const toolName = String(event.tool || event.name || '').trim()
    if (!toolName) {
      return null
    }

    const createdAt = new Date().toISOString()
    const rawDetail = phase === 'tool_use'
      ? (event.input ?? event.args ?? {})
      : (event.content ?? event.result ?? event.output ?? '')
    const detail = this.truncateDisplayText(rawDetail, phase === 'tool_use' ? 240 : 360)
    const entry = {
      id: `${createdAt}:${toolName}:${phase}`,
      phase,
      toolName,
      detail,
      createdAt
    }

    const recentToolEvents = Array.isArray(activeTask.recentToolEvents) ? activeTask.recentToolEvents : []
    activeTask.recentToolEvents = [...recentToolEvents, entry].slice(-12)
    activeTask.currentTool = phase === 'tool_use'
      ? {
          name: toolName,
          detail,
          updatedAt: createdAt
        }
      : null
    activeTask.lastActivity = createdAt

    const content = phase === 'tool_use'
      ? (detail ? `调用工具 ${toolName}\n参数: ${detail}` : `调用工具 ${toolName}`)
      : (detail ? `工具 ${toolName} 已返回\n结果: ${detail}` : `工具 ${toolName} 已返回`)

    db.addTaskMessage(taskId, {
      role: 'system',
      kind: phase,
      content,
      meta: {
        live: activeTask.sessionMode === 'live',
        runtimeMode: activeTask.sessionMode || 'batch',
        toolName,
        phase,
        sessionId: activeTask.liveSessionId || null,
        agentId: activeTask.agent?.id || null
      }
    })

    return entry
  }

  updateAssistantStreamingText(taskId, activeTask, text) {
    const nextText = String(text || '').trim()
    if (!nextText) {
      return ''
    }

    activeTask.pendingAssistantText = nextText
    activeTask.isResponding = true
    activeTask.lastActivity = new Date().toISOString()
    db.emitTaskRefresh(taskId, { runtimeSession: true })
    return nextText
  }

  commitAssistantText(taskId, activeTask, text, options = {}) {
    const finalText = String(text || '').trim()
    const persistMessage = options.persistMessage !== false
    const persistOutput = options.persistOutput !== false
    const kind = options.kind || 'assistant'
    const createdAt = new Date().toISOString()

    activeTask.pendingAssistantText = ''
    activeTask.isResponding = false
    activeTask.currentTool = null
    activeTask.lastActivity = createdAt

    let emitted = false

    if (finalText) {
      if (persistMessage) {
        db.addTaskMessage(taskId, {
          role: options.role || 'assistant',
          kind,
          content: finalText,
          meta: {
            live: activeTask.sessionMode === 'live',
            runtimeMode: activeTask.sessionMode || 'batch',
            sessionId: activeTask.liveSessionId || null,
            agentId: activeTask.agent?.id || null,
            ...(options.messageMeta || {})
          }
        })
        emitted = true
      }

      if (persistOutput) {
        const lines = finalText.split('\n').map(line => line.trim()).filter(Boolean)
        for (const line of lines) {
          db.appendTaskOutput(taskId, line)
          emitted = true
        }
      }
    }

    if (!emitted) {
      db.emitTaskRefresh(taskId, { runtimeSession: true })
    }

    return finalText
  }

  processStructuredStreamEvent(taskId, activeTask, rawLine) {
    let event
    try {
      event = JSON.parse(rawLine)
    } catch (error) {
      return { handled: false, rawText: rawLine }
    }

    if (event.type === 'tool_use') {
      this.recordRuntimeToolEvent(taskId, activeTask, 'tool_use', event)
      if (this.onToolUse) {
        Promise.resolve(this.onToolUse(taskId, activeTask, {
          type: 'tool_use',
          tool: event.tool,
          name: event.tool,
          input: event.input,
          args: event.input
        })).catch(error => {
          console.error('[Scheduler] PostToolUse hook failed:', error.message)
        })
      }
      return { handled: true, event }
    }

    if (event.type === 'tool_result') {
      this.recordRuntimeToolEvent(taskId, activeTask, 'tool_result', event)
      if (this.onToolUse) {
        Promise.resolve(this.onToolUse(taskId, activeTask, {
          type: 'tool_result',
          tool: event.tool,
          name: event.tool,
          input: event.input,
          args: event.input,
          result: event.content,
          output: event.content,
          content: event.content
        })).catch(error => {
          console.error('[Scheduler] PostToolUse hook failed:', error.message)
        })
      }
      return { handled: true, event }
    }

    if (event.type === 'system' && event.subtype === 'init') {
      activeTask.liveSessionId = event.session_id || activeTask.liveSessionId
      activeTask.lastActivity = new Date().toISOString()
      db.emitTaskRefresh(taskId, { runtimeSession: true })
      return { handled: true, event }
    }

    if (event.type === 'assistant' && event.message?.content) {
      const text = this.extractAssistantText(event.message.content)
      if (text) {
        this.updateAssistantStreamingText(taskId, activeTask, text)
      }
      return { handled: true, event, assistantText: text }
    }

    if (event.type === 'result') {
      return {
        handled: true,
        event,
        finalText: String(activeTask.pendingAssistantText || event.result || '').trim()
      }
    }

    if (event.type === 'error') {
      const errorText = this.truncateDisplayText(event.error || event.message || event.content || event, 800)
      activeTask.isResponding = false
      activeTask.lastActivity = new Date().toISOString()
      if (errorText) {
        db.appendTaskOutput(taskId, `[ERROR] ${errorText}`)
      } else {
        db.emitTaskRefresh(taskId, { runtimeSession: true })
      }
      return { handled: true, event, errorText }
    }

    return { handled: true, event }
  }

  handleStructuredStdoutChunk(taskId, activeTask, chunk, streamState, options = {}) {
    streamState.buffer += chunk.toString()
    let newlineIndex = streamState.buffer.indexOf('\n')

    while (newlineIndex >= 0) {
      const line = streamState.buffer.slice(0, newlineIndex).trim()
      streamState.buffer = streamState.buffer.slice(newlineIndex + 1)

      if (line) {
        const result = this.processStructuredStreamEvent(taskId, activeTask, line)
        if (!result.handled) {
          streamState.capturedText += `${line}\n`
          if (options.onPlainText) {
            options.onPlainText(line)
          }
        } else if (result.finalText !== undefined) {
          const committedText = this.commitAssistantText(taskId, activeTask, result.finalText, options.finalizeOptions || {})
          if (committedText) {
            streamState.capturedText += `${committedText}\n`
          }
        } else if (result.errorText) {
          streamState.capturedText += `${result.errorText}\n`
        }
      }

      newlineIndex = streamState.buffer.indexOf('\n')
    }
  }

  flushStructuredStdoutBuffer(taskId, activeTask, streamState, options = {}) {
    const remaining = String(streamState.buffer || '').trim()
    if (!remaining) {
      return
    }

    streamState.buffer = ''
    const result = this.processStructuredStreamEvent(taskId, activeTask, remaining)
    if (!result.handled) {
      streamState.capturedText += `${remaining}\n`
      if (options.onPlainText) {
        options.onPlainText(remaining)
      }
    } else if (result.finalText !== undefined) {
      const committedText = this.commitAssistantText(taskId, activeTask, result.finalText, options.finalizeOptions || {})
      if (committedText) {
        streamState.capturedText += `${committedText}\n`
      }
    } else if (result.errorText) {
      streamState.capturedText += `${result.errorText}\n`
    }
  }

  getArtifactSearchRoots(task, workspacePath) {
    const roots = []
    const operationFolder = String(task?.operationFolder || '').trim()
    if (operationFolder) {
      roots.push(path.resolve(operationFolder))
    }
    if (workspacePath) {
      roots.push(path.resolve(workspacePath))
    }
    return [...new Set(roots)]
  }

  normalizeArtifactCandidate(rawValue, rootPaths = []) {
    let cleanedValue = String(rawValue || '')
      .trim()
      .replace(/^[`"'([{<]+/, '')
      .replace(/[`"')\]}>:;,，。；]+$/, '')

    cleanedValue = cleanedValue.replace(/(\.[A-Za-z0-9]{1,8})(?:[（(][^/\\()（）]*[）)])$/, '$1')

    if (!cleanedValue || /^(https?:)?\/\//i.test(cleanedValue)) {
      return []
    }

    const hasFileLikeShape = /[\\/]/.test(cleanedValue) || /\.[a-z0-9]{1,8}$/i.test(cleanedValue)
    if (!hasFileLikeShape) {
      return []
    }

    const normalizedRoots = Array.isArray(rootPaths)
      ? [...new Set(rootPaths.map(item => String(item || '').trim()).filter(Boolean).map(item => path.resolve(item)))]
      : []

    if (path.isAbsolute(cleanedValue)) {
      const absolutePath = path.resolve(cleanedValue)
      const matchingRoot = normalizedRoots.find(root =>
        absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`)
      )
      return [{
        path: cleanedValue,
        logicalPath: cleanedValue,
        absolutePath,
        rootPath: matchingRoot || null,
        relativeToRoot: matchingRoot ? (path.relative(matchingRoot, absolutePath) || '.') : null
      }]
    }

    const candidateRoots = normalizedRoots.length > 0 ? normalizedRoots : [process.cwd()]
    return candidateRoots.map(rootPath => ({
      path: cleanedValue,
      logicalPath: cleanedValue,
      absolutePath: path.resolve(rootPath, cleanedValue),
      rootPath,
      relativeToRoot: cleanedValue === '.'
        ? '.'
        : (path.relative(rootPath, path.resolve(rootPath, cleanedValue)) || '.')
    }))
  }

  extractArtifactPathCandidates(text, rootPaths = []) {
    const content = String(text || '')
    if (!content.trim()) {
      return []
    }

    const candidates = new Map()
    const patterns = [
      /(?:^|[\s"'`:(\[])(\/[^\s"'`)\]}<>]+)/g,
      /(?:^|[\s"'`:(\[])((?:\.\.?\/|\.omc\/|src\/|public\/|docs\/|dist\/|build\/|workspaces\/)[^\s"'`)\]}<>]+)/g,
      /(?<![\\/])\b([A-Za-z0-9._-]+\.(?:md|txt|html|css|js|cjs|mjs|ts|tsx|jsx|json|ya?ml|png|jpe?g|webp|svg|gif|csv|mp4|mov))\b(?![\\/])/g
    ]

    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(content)) !== null) {
        const value = match[1] || match[0]
        const normalizedCandidates = this.normalizeArtifactCandidate(value, rootPaths)
        normalizedCandidates.forEach(candidate => {
          if (!candidate) return
          candidates.set(candidate.absolutePath, candidate)
        })
      }
    }

    return Array.from(candidates.values())
  }

  captureTaskArtifacts(taskId, workspacePath) {
    const task = db.getTaskById(taskId)
    if (!task || !workspacePath) {
      return { manifest: [], requiredArtifacts: [], missingRequired: [] }
    }

    const absoluteWorkspacePath = path.resolve(workspacePath)
    const artifactRoots = this.getArtifactSearchRoots(task, absoluteWorkspacePath)
    const manifestMap = new Map()
    const registerCandidates = (text, source, required = false) => {
      const candidates = this.extractArtifactPathCandidates(text, artifactRoots)
      candidates.forEach(candidate => {
        const existing = manifestMap.get(candidate.absolutePath)
        if (existing) {
          if (!existing.sources.includes(source)) {
            existing.sources.push(source)
          }
          existing.required = existing.required || required
          return
        }

        manifestMap.set(candidate.absolutePath, {
          path: candidate.path,
          logicalPath: candidate.logicalPath || candidate.path,
          absolutePath: candidate.absolutePath,
          relativeToWorkspace: candidate.rootPath === absoluteWorkspacePath
            ? candidate.relativeToRoot
            : null,
          relativeToOperationFolder: task.operationFolder && candidate.rootPath === path.resolve(task.operationFolder)
            ? candidate.relativeToRoot
            : null,
          required,
          rootPath: candidate.rootPath || null,
          sources: [source]
        })
      })
    }

    ;(task.handoffArtifacts || []).forEach(item => registerCandidates(item, 'handoffArtifacts', true))
    ;(task.verificationPlan || []).forEach(item => registerCandidates(item, 'verificationPlan', false))
    ;(task.acceptanceCriteria || []).forEach(item => registerCandidates(item, 'acceptanceCriteria', false))
    ;(task.outputLines || []).slice(-40).forEach(item => registerCandidates(item?.content || '', 'output', false))

    const manifest = Array.from(manifestMap.values())
      .map(item => {
        const exists = fs.existsSync(item.absolutePath)
        const stat = exists ? fs.statSync(item.absolutePath) : null
        return {
          ...item,
          exists,
          kind: stat ? (stat.isDirectory() ? 'directory' : 'file') : 'missing',
          size: stat && stat.isFile() ? stat.size : null,
          mtime: stat ? stat.mtime.toISOString() : null,
          inWorkspace: item.absolutePath === absoluteWorkspacePath || item.absolutePath.startsWith(`${absoluteWorkspacePath}${path.sep}`)
        }
      })
      .sort((a, b) => Number(b.required) - Number(a.required) || Number(b.exists) - Number(a.exists) || a.absolutePath.localeCompare(b.absolutePath))

    const requiredArtifacts = manifest.filter(item => item.required)
    const requiredGroups = new Map()
    requiredArtifacts.forEach(item => {
      const key = item.logicalPath || item.path || item.absolutePath
      const group = requiredGroups.get(key) || {
        logicalPath: key,
        exists: false,
        candidates: []
      }
      group.exists = group.exists || item.exists
      group.candidates.push(item)
      requiredGroups.set(key, group)
    })
    const missingRequired = Array.from(requiredGroups.values())
      .filter(group => !group.exists)
      .map(group => ({
        path: group.logicalPath,
        candidates: group.candidates
      }))

    db.updateTaskArtifacts(taskId, manifest, {
      workspacePath: absoluteWorkspacePath
    })

    return { manifest, requiredArtifacts, missingRequired }
  }

  materializeDependencyArtifacts(taskId, workspacePath) {
    const task = db.getTaskById(taskId)
    if (!task || !workspacePath) {
      return []
    }

    const dependencyIds = Array.isArray(task.dependsOnSubTaskIds) ? task.dependsOnSubTaskIds : []
    if (dependencyIds.length === 0) {
      db.updateTaskMountedArtifacts(taskId, [])
      return []
    }

    const workspaceRoot = path.resolve(workspacePath)
    const mounts = []

    const sanitizeName = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'dependency'

    for (const dependencyId of dependencyIds) {
      const dependencyTask = db.getTaskById(dependencyId)
      if (!dependencyTask) continue

      const manifest = (dependencyTask.artifactManifest || []).filter(item => item && item.exists && item.absolutePath)
      for (const artifact of manifest) {
        if (!fs.existsSync(artifact.absolutePath)) continue

        const dependencyFolder = `${dependencyTask.id.substring(0, 8)}-${sanitizeName(dependencyTask.title)}`
        const fallbackName = path.basename(artifact.absolutePath)
        const relativeTarget = artifact.relativeToWorkspace && artifact.relativeToWorkspace !== '.'
          ? artifact.relativeToWorkspace
          : fallbackName
        const mountedRelativePath = path.join('.omc', 'dependencies', dependencyFolder, relativeTarget)
        const mountedAbsolutePath = path.resolve(workspaceRoot, mountedRelativePath)

        if (!(mountedAbsolutePath === workspaceRoot || mountedAbsolutePath.startsWith(`${workspaceRoot}${path.sep}`))) {
          continue
        }

        try {
          fs.mkdirSync(path.dirname(mountedAbsolutePath), { recursive: true })
          fs.cpSync(artifact.absolutePath, mountedAbsolutePath, {
            recursive: artifact.kind === 'directory',
            force: true
          })

          mounts.push({
            sourceTaskId: dependencyTask.id,
            sourceTaskTitle: dependencyTask.title,
            sourcePath: artifact.absolutePath,
            mountedPath: mountedAbsolutePath,
            relativeMountedPath: mountedRelativePath,
            copiedAt: new Date().toISOString()
          })
        } catch (error) {
          console.error(`[Scheduler] Failed to mount dependency artifact ${artifact.absolutePath} for task ${taskId}:`, error.message)
        }
      }
    }

    db.updateTaskMountedArtifacts(taskId, mounts)
    return mounts
  }

  async cleanupTaskWorkspace(taskId) {
    const workspaceConfig = workflowManager.getWorkspaceConfig()
    await workspaceManager.cleanupWorkspace(taskId, {
      beforeCleanup: workspaceConfig.hooks?.beforeCleanup
    })
    db.updateTaskWorkspace(taskId, {
      status: 'cleaned',
      retainedForQa: false,
      cleanedAt: new Date().toISOString()
    })
  }

  buildAgentSkillContext(agent) {
    if (!agent) return ''

    if (agent.skillMode === 'custom') {
      const allowedSkills = this.normalizeStringArray(agent.allowedSkills)
      return `\n\n【Agent 专属 Skill】\n当前 Agent 只配置了以下专属 Skill：${allowedSkills.length > 0 ? allowedSkills.join('、') : '未选择任何 Skill'}。\n执行时优先使用这些 Skill；如果任务确实不需要 Skill，可以直接完成。`
    }

    return '\n\n【Agent 专属 Skill】\n当前 Agent 的 Skill 范围为全部 Claude 可用 Skill。'
  }

  buildAgentInstructionFallback(agent, options = {}) {
    const instructions = String(agent?.instructions || '').trim()
    if (!instructions) {
      return ''
    }

    const heading = options.heading || '【Agent 职责兜底】'
    return `\n\n${heading}\n以下内容是当前 Agent 在 Claude 配置文件中的 instructions 回放。即使这次运行环境没有正确加载对应的 agent 文件，也必须把这段内容视为当前 Agent 的职责说明并严格遵守。\n<Agent_Config_Fallback>\n${instructions}\n</Agent_Config_Fallback>`
  }

  buildExecutionPrompt(task, agent = null) {
    return `任务: ${task.title}
${task.description || '请完成这个任务'}${this.buildContractContext(task)}${this.buildOperationFolderContext(task)}${this.buildDependencyArtifactContext(task)}${this.buildMountedArtifactContext(task)}${this.buildConversationContext(task)}${this.buildAgentSkillContext(agent)}${this.buildAgentInstructionFallback(agent)}

【执行要求】
1. 优先按“冲刺契约”的验收标准完成真实产物，不要只输出计划或要求用户补充素材。
2. 如果需要生成文件、页面、代码、视频或配置，必须实际写入文件系统，并在输出里列出绝对路径。
3. 完成前做一次自查：逐条对照验收标准、运行可执行验证命令，并说明通过/风险。
4. 结束输出必须包含“交接摘要”：已完成内容、产物路径、验证命令/结果、剩余风险。`
  }

  getClaudeAgentName(agent) {
    if (!agent) return 'executor'
    return agent.claudeAgentName || AGENT_NAME_MAP[agent.role] || agent.name || agent.role || 'executor'
  }

  getTaskRuntimeState(taskId) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) {
      return {
        liveSession: null,
        runtimeSession: null
      }
    }

    const runtimeSession = {
      active: true,
      mode: activeTask.sessionMode || 'batch',
      sessionId: activeTask.liveSessionId || null,
      agentId: activeTask.agent?.id || null,
      agentName: activeTask.agent?.description || activeTask.agent?.name || null,
      startedAt: activeTask.startedAt,
      lastActivity: activeTask.lastActivity,
      isResponding: Boolean(activeTask.isResponding),
      queuedCount: activeTask.queuedUserMessages?.length || 0,
      turns: activeTask.turns || 0,
      pendingAssistantText: String(activeTask.pendingAssistantText || ''),
      currentTool: activeTask.currentTool || null,
      recentToolEvents: Array.isArray(activeTask.recentToolEvents) ? activeTask.recentToolEvents.slice(-8) : []
    }

    return {
      liveSession: activeTask.sessionMode === 'live' ? runtimeSession : null,
      runtimeSession
    }
  }

  isTaskCoolingDown(task) {
    const retryAfter = task?.retryAfter ? Date.parse(task.retryAfter) : 0
    return Number.isFinite(retryAfter) && retryAfter > Date.now()
  }

  getTaskDepth(task) {
    const depth = Number.parseInt(task?.depth, 10)
    return Number.isInteger(depth) && depth > 0 ? depth : 1
  }

  getTaskMaxDecompositionDepth(task) {
    const depth = this.getTaskDepth(task)
    const maxDepth = Number.parseInt(task?.maxDecompositionDepth, 10)
    const normalizedMaxDepth = Number.isInteger(maxDepth) && maxDepth > 0
      ? maxDepth
      : 3
    return Math.max(depth, normalizedMaxDepth)
  }

  canTaskDecomposeFurther(task) {
    return this.getTaskDepth(task) < this.getTaskMaxDecompositionDepth(task)
  }

  needsTaskAnalysis(task) {
    if (!task) return false

    const hasNoSubTasks = !Array.isArray(task.subTaskIds) || task.subTaskIds.length === 0
    if (!hasNoSubTasks || !this.canTaskDecomposeFurther(task)) {
      return false
    }

    if (!task.parentTaskId) {
      return true
    }

    return Boolean(task.shouldDecomposeFurther)
  }

  areTaskDependenciesDone(task) {
    const dependencyIds = Array.isArray(task?.dependsOnSubTaskIds) ? task.dependsOnSubTaskIds : []
    if (dependencyIds.length === 0) return true

    return dependencyIds.every(depId => {
      const dependency = db.getTaskById(depId)
      return !dependency || dependency.status === 'Done' || dependency.skipAsDependency
    })
  }

  resolvePlannerDependencyIds(dependencyRefs, plannerSubTasks, createdSubTasks, currentIndex) {
    const refs = Array.isArray(dependencyRefs) ? dependencyRefs : []
    const dependencyIds = []

    for (const ref of refs) {
      let dependencyIndex = -1

      if (typeof ref === 'number') {
        dependencyIndex = ref > 0 ? ref - 1 : ref
      } else if (typeof ref === 'string') {
        const value = ref.trim()
        const numberMatch = value.match(/^#?(\d+)$/)
        if (numberMatch) {
          dependencyIndex = Number(numberMatch[1]) - 1
        } else {
          dependencyIndex = plannerSubTasks.findIndex(st => String(st.title || '').trim() === value)
        }
      } else if (ref && typeof ref === 'object') {
        if (Number.isInteger(ref.index)) {
          dependencyIndex = ref.index > 0 ? ref.index - 1 : ref.index
        } else if (Number.isInteger(ref.taskIndex)) {
          dependencyIndex = ref.taskIndex > 0 ? ref.taskIndex - 1 : ref.taskIndex
        } else if (ref.title) {
          dependencyIndex = plannerSubTasks.findIndex(st => String(st.title || '').trim() === String(ref.title).trim())
        }
      }

      if (dependencyIndex >= 0 && dependencyIndex < currentIndex && createdSubTasks[dependencyIndex]?.id) {
        dependencyIds.push(createdSubTasks[dependencyIndex].id)
      }
    }

    return [...new Set(dependencyIds)]
  }

  markTaskBlockedAfterMaxRetries(task, maxLoopCount) {
    if (!task || task.status !== 'InFix' || task.maxRetryBlockedAt) return false

    const message = `已达到最大自动修复次数（${task.loopCount}/${maxLoopCount}），调度器已停止继续自动重试，避免任务永久卡在修复中。`
    db.updateTaskStatus(task.id, 'Blocked')
    const taskRef = db.getTaskById(task.id)
    if (taskRef) {
      taskRef.blockedReason = message
      taskRef.maxRetryBlockedAt = new Date().toISOString()
      taskRef.updatedAt = new Date().toISOString()
      taskRef.workspace.status = 'blocked'
      taskRef.workspace.retainedForQa = false
      taskRef.workspace.updatedAt = new Date().toISOString()
      db.save()
    }
    db.addTaskLog(task.id, {
      action: '自动阻塞',
      message
    })
    db.appendTaskOutput(task.id, `[系统] ${message}`)
    return true
  }

  addTaskLogDeduped(taskId, log, dedupeWindowMs = FAILURE_LOG_DEDUPE_WINDOW_MS) {
    if (!taskId || !log?.action) return null

    const [latestLog] = db.getTaskLogs(taskId, { limit: 1 })
    if (latestLog && latestLog.action === log.action && (latestLog.message || null) === (log.message || null)) {
      const latestTime = Date.parse(latestLog.createdAt)
      if (Number.isFinite(latestTime) && Date.now() - latestTime <= dedupeWindowMs) {
        return latestLog
      }
    }

    return db.addTaskLog(taskId, log)
  }

  appendTaskOutputDeduped(taskId, line, dedupeWindowMs = FAILURE_LOG_DEDUPE_WINDOW_MS) {
    const task = db.getTaskById(taskId)
    if (!task) return null

    const normalizedLine = String(line || '')
    const latestLine = Array.isArray(task.outputLines) && task.outputLines.length > 0
      ? task.outputLines[task.outputLines.length - 1]
      : null
    if (latestLine && String(latestLine.content || '') === normalizedLine) {
      const latestTime = Date.parse(latestLine.timestamp)
      if (Number.isFinite(latestTime) && Date.now() - latestTime <= dedupeWindowMs) {
        return latestLine
      }
    }

    return db.appendTaskOutput(taskId, normalizedLine)
  }

  beginExecutionSettlement(taskId) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.executionSettlementStarted) {
      return null
    }
    activeTask.executionSettlementStarted = true
    return activeTask
  }

  resetExecutionFailureState(taskId) {
    const task = db.getTaskById(taskId)
    if (!task) return null

    if (!task.executionFailureCount && !task.executionFailureBlockedAt && !task.lastExecutionFailureAt) {
      return task
    }

    task.executionFailureCount = 0
    task.executionFailureBlockedAt = null
    task.lastExecutionFailureAt = null
    task.updatedAt = new Date().toISOString()
    db.save()
    return task
  }

  async handleExecutionProcessFailure(taskId, activeTask, options = {}) {
    const taskRef = db.getTaskById(taskId)
    if (!taskRef) {
      if (activeTask?.agent?.id) {
        db.releaseAgent(activeTask.agent.id, taskId)
      }
      this.activeTasks.delete(taskId)
      return null
    }

    const code = options.code
    const trigger = options.trigger || 'close'
    const nextFailureCount = Number(taskRef.executionFailureCount || 0) + 1
    const now = new Date()
    const nowIso = now.toISOString()
    const currentStatus = ['InDev', 'InFix', 'ReadyForDeploy'].includes(taskRef.status) ? taskRef.status : 'InDev'

    taskRef.executionFailureCount = nextFailureCount
    taskRef.lastExecutionFailureAt = nowIso
    taskRef.updatedAt = nowIso
    taskRef.retryAfter = new Date(now.getTime() + EXECUTION_PROCESS_FAILURE_RETRY_DELAY_MS).toISOString()
    taskRef.transientError = {
      stage: 'execution_process',
      reason: trigger,
      message: `执行进程异常退出（code: ${code ?? 'unknown'}）`,
      createdAt: nowIso
    }
    taskRef.workspace.status = currentStatus === 'ReadyForDeploy' ? 'retained_for_qa' : 'retained_for_fix'
    taskRef.workspace.retainedForQa = currentStatus === 'ReadyForDeploy'
    taskRef.workspace.updatedAt = nowIso

    if (activeTask?.agent?.id) {
      db.releaseAgent(activeTask.agent.id, taskId)
    }

    let statusChanged = false
    if (taskRef.status !== currentStatus) {
      db.updateTaskStatus(taskId, currentStatus)
      statusChanged = true
    }

    if (nextFailureCount >= EXECUTION_PROCESS_FAILURE_MAX_COUNT) {
      const blockedMessage = `执行进程已连续 ${nextFailureCount} 次启动/退出异常（最近 code: ${code ?? 'unknown'}），调度器已自动阻塞任务，避免无限重试。`
      db.updateTaskStatus(taskId, 'Blocked')
      taskRef.blockedReason = blockedMessage
      taskRef.executionFailureBlockedAt = nowIso
      delete taskRef.retryAfter
      delete taskRef.transientError
      taskRef.workspace.status = 'blocked'
      taskRef.workspace.retainedForQa = false
      taskRef.workspace.updatedAt = nowIso
      taskRef.updatedAt = nowIso
      taskRef.maxRetryBlockedAt = taskRef.maxRetryBlockedAt || nowIso
      db.save()
      this.addTaskLogDeduped(taskId, {
        agentId: activeTask?.agent?.id,
        action: '自动阻塞',
        message: blockedMessage
      })
      this.appendTaskOutputDeduped(taskId, `[系统] ${blockedMessage}`)
    } else {
      const retryMessage = `执行进程异常退出（code: ${code ?? 'unknown'}），任务保持 ${currentStatus} 并进入冷却，${Math.round(EXECUTION_PROCESS_FAILURE_RETRY_DELAY_MS / 1000)} 秒后自动重试（${nextFailureCount}/${EXECUTION_PROCESS_FAILURE_MAX_COUNT}）。`
      db.save()
      this.addTaskLogDeduped(taskId, {
        agentId: activeTask?.agent?.id,
        action: '执行启动异常',
        message: retryMessage
      })
      this.appendTaskOutputDeduped(taskId, `[系统] ${retryMessage}`)
      if (!statusChanged) {
        db.emitTaskRefresh(taskId, { status: taskRef.status })
      }
    }

    this.activeTasks.delete(taskId)
    this.scheduleNext()
    return db.getTaskById(taskId)
  }

  decorateTask(task) {
    if (!task) return task
    const resolvedStatuses = new Set(['ReadyForTest', 'ReadyForDeploy', 'Done'])
    return {
      ...task,
      bugReport: resolvedStatuses.has(task.status) ? null : task.bugReport,
      blockedReason: resolvedStatuses.has(task.status) ? null : task.blockedReason,
      ...this.getTaskRuntimeState(task.id)
    }
  }

  trackWorkspaceProcess(taskId, proc) {
    const workspace = workspaceManager.getWorkspace(taskId)
    if (workspace) {
      workspace.process = proc
      workspace.startedAt = new Date().toISOString()
    }
  }

  isTransientClaudeServiceError(text) {
    return /overloaded_error|API Error:\s*(?:429|529)|rate limit|当前服务集群负载较高|服务集群负载较高/i
      .test(String(text || ''))
  }

  buildTransientRetryMessage(stage, output) {
    const raw = String(output || '').replace(/\r/g, '').trim()
    const firstUsefulLine = raw
      .split('\n')
      .map(line => line.trim())
      .find(line => line && !line.startsWith('---'))
    const detail = firstUsefulLine ? `：${firstUsefulLine.slice(0, 300)}` : ''
    return `${stage}遇到 Claude 服务过载/限流${detail}。任务已退回待处理，稍后由调度器自动重试。`
  }

  markAnalysisForRetry(taskId, agent, reason, message, retryDelayMs = 60000) {
    db.updateTaskStatus(taskId, 'Backlog')

    const taskRef = db.getTaskById(taskId)
    if (taskRef) {
      taskRef.retryAfter = new Date(Date.now() + retryDelayMs).toISOString()
      taskRef.transientError = {
        stage: 'analysis',
        reason,
        message,
        createdAt: new Date().toISOString()
      }
      taskRef.updatedAt = new Date().toISOString()
      db.save()
    }

    db.addTaskLog(taskId, {
      agentId: agent?.id,
      action: '分析异常',
      message
    })
    db.appendTaskOutput(taskId, `[系统] ${message}`)

    return { success: false, reason, message }
  }

  async requeueTaskAfterTransientError(taskId, activeTask, options = {}) {
    const stage = options.stage || '执行'
    const output = options.output || ''
    const retryDelayMs = options.retryDelayMs ?? 60000
    const message = this.buildTransientRetryMessage(stage, output)
    const taskRef = db.getTaskById(taskId)

    if (!taskRef) {
      return null
    }

    if (options.restoreOriginalDescription && taskRef.originalDescription) {
      taskRef.description = taskRef.originalDescription
      taskRef.bugReport = null
      taskRef.blockedReason = null
      taskRef.loopCount = Math.max(0, Number(taskRef.loopCount || 0) - Number(options.undoLoopIncrement || 0))
      taskRef.updatedAt = new Date().toISOString()
      db.save()
    }

    db.updateTaskStatus(taskId, 'Backlog')

    const retryTask = db.getTaskById(taskId)
    if (retryTask) {
      retryTask.retryAfter = new Date(Date.now() + retryDelayMs).toISOString()
      retryTask.transientError = {
        stage,
        message,
        createdAt: new Date().toISOString()
      }
      retryTask.updatedAt = new Date().toISOString()
      db.save()
    }

    db.addTaskLog(taskId, {
      agentId: activeTask?.agent?.id,
      action: `${stage}异常`,
      message
    })
    db.appendTaskOutput(taskId, `[系统] ${message}`)

    if (activeTask?.agent?.id) {
      db.releaseAgent(activeTask.agent.id, taskId)
    }

    if (options.cleanupWorkspace) {
      const workspaceConfig = workflowManager.getWorkspaceConfig()
      await workspaceManager.cleanupWorkspace(taskId, {
        beforeCleanup: workspaceConfig.hooks?.beforeCleanup
      })
    }

    this.activeTasks.delete(taskId)
    return db.getTaskById(taskId)
  }

  buildLiveSystemPrompt(task, agent) {
    return `你正在 cloud-server 中作为一个长期在线的 Claude Code Agent，与用户围绕同一个任务进行实时多轮对话。

【任务信息】
- 任务 ID: ${task.id}
- 标题: ${task.title}
- 描述: ${task.description || '无'}
- 当前状态: ${task.status}
- Agent: ${agent.description || agent.name}
${this.buildOperationFolderContext(task)}${this.buildConversationContext(task, 10)}${this.buildAgentSkillContext(agent)}${this.buildAgentInstructionFallback(agent, { heading: '【Agent 职责回放】' })}

工作要求：
1. 你需要持续记住当前任务上下文，除非用户明确切换主题，否则始终围绕这个任务回复。
2. 优先直接回答用户问题；如果需要执行命令、读写文件或继续工作，可以直接使用 Claude Code 工具。
3. 回复使用中文，简洁明确。
4. 如果你完成了某个阶段，请主动说明下一步建议，但不要擅自结束会话。
5. 每次最终回复都必须在最后单独追加一个状态标记，格式严格为：[[TASK_STATUS:状态名]]
6. 状态名只允许使用：Collecting、InDev、ReadyForTest、Done、Blocked
7. 判定规则：
   - 还需要用户补充信息、确认参数、提供路径/权限时，用 [[TASK_STATUS:Collecting]]
   - 正在继续处理但还没完成时，用 [[TASK_STATUS:InDev]]
   - 任务已经完成，等待系统或人工验证时，用 [[TASK_STATUS:ReadyForTest]]
   - 任务已经完成且无需后续验证时，用 [[TASK_STATUS:Done]]
   - 因权限、依赖、外部条件卡住无法继续时，用 [[TASK_STATUS:Blocked]]
8. 不要解释这个状态标记本身，也不要遗漏。`
  }

  parseLiveStatusMarker(text) {
    const rawText = String(text || '').trim()
    const match = rawText.match(/\[\[TASK_STATUS:(Collecting|InDev|ReadyForTest|Done|Blocked)\]\]\s*$/)
    if (!match) {
      return {
        cleanText: rawText,
        nextStatus: null
      }
    }

    return {
      cleanText: rawText.replace(match[0], '').trim(),
      nextStatus: match[1]
    }
  }

  inferLiveStatusFromText(text, currentStatus = 'InDev') {
    const normalized = String(text || '').trim()
    if (!normalized) {
      return currentStatus
    }

    if (/(请提供|请确认|还需要|需要补充|缺少|无法确认|能否提供|告诉我|需要你提供|请补充)/.test(normalized)) {
      return 'Collecting'
    }

    if (/(无法继续|权限不足|没有权限|依赖未安装|依赖缺失|外部条件不足|被阻塞|受阻|无法访问)/.test(normalized)) {
      return 'Blocked'
    }

    if (/(已创建|已完成|已经完成|已修复|已处理|已生成|已实现|已保存|任务完成|处理完成|创建完成|修改完成)/.test(normalized)) {
      return 'ReadyForTest'
    }

    return currentStatus === 'Collecting' ? 'Collecting' : 'InDev'
  }

  async applyLiveTaskStatus(taskId, requestedStatus, activeTask = null) {
    const task = db.getTaskById(taskId)
    if (!task || !requestedStatus || task.status === requestedStatus) {
      return task
    }

    db.updateTaskStatus(taskId, requestedStatus)

    if (requestedStatus === 'Done' && this.onTaskDone) {
      const updatedTask = db.getTaskById(taskId)
      try {
        this.onTaskDone(taskId, updatedTask, activeTask?.agent || null)
      } catch (error) {
        console.error('[Scheduler] Live Task Done hook failed:', error.message)
      }
    }

    return db.getTaskById(taskId)
  }

  async waitForTaskToLeaveActive(taskId, timeoutMs = 20000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (!this.activeTasks.has(taskId)) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return !this.activeTasks.has(taskId)
  }

  async requeueActiveTaskForUserMessage(taskId, options = {}) {
    const {
      reason = 'user_message',
      skipSchedule = false
    } = options
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) return false

    const task = db.getTaskById(taskId)
    if (!task) return false

    const nextStatus = activeTask.isAnalysis ? 'Backlog' : (task.status || 'InDev')
    if (nextStatus !== task.status) {
      db.updateTaskStatus(taskId, nextStatus)
    }

    db.releaseAgent(activeTask.agent.id, taskId)

    const workspaceConfig = workflowManager.getWorkspaceConfig()
    await workspaceManager.cleanupWorkspace(taskId, {
      beforeCleanup: workspaceConfig.hooks?.beforeCleanup
    })

    this.activeTasks.delete(taskId)
    if (reason === 'live_session') {
      db.appendTaskOutput(taskId, '[系统] 已停止当前批处理流程，准备切换为实时多轮会话。')
    } else {
      db.appendTaskOutput(
        taskId,
        activeTask.isAnalysis
          ? '[系统] 已携带最新消息重新进入分析队列。'
          : '[系统] 已携带最新消息重新进入执行队列。'
      )
    }

    if (this.running && !skipSchedule) {
      this.scheduleNext()
    }

    return true
  }

  createFollowUpTaskForCompletedTask(taskId, messageText) {
    const sourceTask = db.getTaskById(taskId)
    if (!sourceTask) return null

    const followUpTask = db.createFollowUpTaskFromCompletedTask(taskId, messageText)
    if (!followUpTask) return null

    db.addTaskMessage(taskId, {
      role: 'system',
      kind: 'system',
      content: `已收到补充要求，已创建新任务「${followUpTask.title}」继续处理，原任务保持已完成。`,
      meta: {
        followUpTaskId: followUpTask.id
      }
    })
    db.addTaskLog(taskId, {
      action: '补充任务创建',
      message: `已创建补充任务：${followUpTask.title}（${followUpTask.id}）`
    })
    db.appendTaskOutput(
      taskId,
      `[系统] 已收到补充要求，已创建新任务「${followUpTask.title}」继续处理。`
    )

    return followUpTask
  }

  async handleUserMessage(taskId, content) {
    const messageText = String(content || '').trim()
    if (!messageText) {
      throw new Error('message is required')
    }

    const task = db.getTaskById(taskId)
    if (!task) {
      throw new Error('Task not found')
    }

    const currentActiveTask = this.activeTasks.get(taskId)
    if (currentActiveTask?.sessionMode === 'live') {
      return this.handleLiveUserMessage(taskId, messageText)
    }

    const message = db.addTaskMessage(taskId, {
      role: 'user',
      kind: 'user',
      content: messageText
    })

    db.addTaskLog(taskId, {
      action: '用户消息',
      message: messageText
    })
    db.appendTaskOutput(taskId, `[用户消息] ${messageText}`)

    if (task.status === 'Collecting') {
      db.addTaskMessage(taskId, {
        role: 'system',
        kind: 'system',
        content: '已收到补充信息，任务已回到待分析队列。'
      })
      db.updateTaskStatus(taskId, 'Backlog')
      db.addTaskLog(taskId, {
        action: '补充信息已接收',
        message: '任务已重新进入分析队列'
      })
      db.appendTaskOutput(taskId, '[系统] 已收到补充信息，任务将重新进入分析。')
      if (this.running) {
        this.scheduleNext()
      }
      return {
        message,
        task: db.getTaskById(taskId),
        delivery: 'queued_for_analysis'
      }
    }

    if (task.status === 'Done') {
      const followUpTask = this.createFollowUpTaskForCompletedTask(taskId, messageText)
      if (!followUpTask) {
        throw new Error('Failed to create follow-up task')
      }

      if (this.running) {
        this.scheduleNext()
      }

      return {
        message,
        task: followUpTask,
        sourceTask: db.getTaskById(taskId),
        followUpTask,
        followUpTaskId: followUpTask.id,
        delivery: 'followup_created'
      }
    }

    const activeTask = this.activeTasks.get(taskId)
    if (activeTask) {
      db.addTaskMessage(taskId, {
        role: 'system',
        kind: 'system',
        content: activeTask.process
          ? '已收到消息，正在中断当前执行并按最新上下文重新调度。'
          : '已收到消息，当前阶段会在下一轮调度中带上最新上下文。'
      })

      if (activeTask.process && typeof activeTask.process.kill === 'function') {
        activeTask.restartRequested = {
          reason: 'user_message',
          requestedAt: new Date().toISOString()
        }
        db.appendTaskOutput(taskId, '[系统] 已收到消息，正在按最新上下文重新调度 Agent...')
        activeTask.process.kill('SIGTERM')
        return {
          message,
          task: db.getTaskById(taskId),
          delivery: 'restart_requested'
        }
      }

      db.appendTaskOutput(taskId, '[系统] 已记录消息，会在当前阶段结束后带上新的上下文。')
      return {
        message,
        task: db.getTaskById(taskId),
        delivery: 'queued_for_current_stage'
      }
    }

    if (this.running && !task.assignedAgentId && !['Done', 'Cancelled', 'Duplicate'].includes(task.status)) {
      db.addTaskMessage(taskId, {
        role: 'system',
        kind: 'system',
        content: '已记录消息，任务会在下一轮调度中带上新的上下文。'
      })
      db.appendTaskOutput(taskId, '[系统] 已记录消息，任务会在下一轮调度中带上新的上下文。')
      this.scheduleNext()
      return {
        message,
        task: db.getTaskById(taskId),
        delivery: 'queued'
      }
    }

    db.addTaskMessage(taskId, {
      role: 'system',
      kind: 'system',
      content: '已记录消息。当前任务不在执行队列中。'
    })

    return {
      message,
      task: db.getTaskById(taskId),
      delivery: 'recorded_only'
    }
  }

  async startLiveSession(taskId, options = {}) {
    const task = db.getTaskById(taskId)
    if (!task) {
      throw new Error('Task not found')
    }

    if (['Done', 'Cancelled', 'Duplicate'].includes(task.status)) {
      throw new Error('Terminal tasks cannot start live sessions')
    }

    const existingActiveTask = this.activeTasks.get(taskId)
    if (existingActiveTask?.sessionMode === 'live' && existingActiveTask.process) {
      return {
        task: db.getTaskById(taskId),
        liveSession: this.getTaskRuntimeState(taskId).liveSession,
        delivery: 'already_connected'
      }
    }

    if (existingActiveTask && existingActiveTask.sessionMode !== 'live') {
      existingActiveTask.restartRequested = {
        reason: 'live_session',
        requestedAt: new Date().toISOString()
      }

      db.addTaskLog(taskId, {
        agentId: existingActiveTask.agent?.id,
        action: '切换实时会话',
        message: '停止当前批处理流程，准备切换为实时多轮会话'
      })

      if (existingActiveTask.process && typeof existingActiveTask.process.kill === 'function') {
        existingActiveTask.process.kill('SIGTERM')
      }

      const released = await this.waitForTaskToLeaveActive(taskId)
      if (!released) {
        throw new Error('Failed to switch task into live session mode')
      }
    }

    if (!this.canAcceptTask()) {
      throw new Error('当前没有空闲的 Agent 容量，请稍后再试')
    }

    const refreshedTask = db.getTaskById(taskId)
    if (!refreshedTask) {
      throw new Error('Task not found')
    }

    if (refreshedTask.assignedAgentId && !this.activeTasks.has(taskId)) {
      db.releaseAgent(refreshedTask.assignedAgentId, taskId)
    }

    const preferredAgent = options.preferredAgentId ? db.getAgentById(options.preferredAgentId) : null
    const taskType = ['Backlog', 'Collecting', 'Analyzing'].includes(refreshedTask.status) ? 'analysis' : 'execution'
    const agent = preferredAgent && !preferredAgent.currentTaskId
      ? preferredAgent
      : this.findBestAgentForTask(refreshedTask, taskType)

    if (!agent) {
      throw new Error('当前没有可用的 Agent')
    }

    const workspaceConfig = workflowManager.getWorkspaceConfig()
    const workspaceResult = await workspaceManager.createWorkspace(taskId, {
      afterCreate: workspaceConfig.hooks?.afterCreate
    })
    const workspacePath = workspaceResult.path

    const result = db.claimTask(taskId, agent.id)
    if (!result) {
      throw new Error('Task is already claimed')
    }

    const initialLiveStatus = ['Backlog', 'Analyzing', 'Collecting'].includes(refreshedTask.status)
      ? 'Collecting'
      : refreshedTask.status || 'InDev'
    if (result.task.status !== initialLiveStatus) {
      db.updateTaskStatus(taskId, initialLiveStatus)
      result.task = db.getTaskById(taskId)
    }

    const { spawn } = await import('child_process')
    const claudeAgentName = this.getClaudeAgentName(result.agent)
    const proc = spawn(CLAUDE_LAUNCH_SPEC.command, [
      ...CLAUDE_LAUNCH_SPEC.prefixArgs,
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--replay-user-messages',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--agent', claudeAgentName,
      '--append-system-prompt', this.buildLiveSystemPrompt(result.task, result.agent)
    ], {
      cwd: path.resolve(workspacePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: '' }
    })

    const activeTask = {
      task: result.task,
      agent: result.agent,
      workspace: workspacePath,
      startedAt: new Date().toISOString(),
      turns: 0,
      lastActivity: new Date().toISOString(),
      process: proc,
      sessionMode: 'live',
      liveSessionId: null,
      isResponding: false,
      queuedUserMessages: [],
      pendingAssistantText: '',
      currentTool: null,
      recentToolEvents: [],
      closing: false,
      restartRequested: null
    }

    this.activeTasks.set(taskId, activeTask)
    this.trackWorkspaceProcess(taskId, proc)

    db.addTaskLog(taskId, {
      agentId: result.agent.id,
      action: '实时会话开始',
      message: `已连接 ${result.agent.description || result.agent.name}`
    })
    db.addTaskMessage(taskId, {
      role: 'system',
      kind: 'system',
      content: `已连接 ${result.agent.description || result.agent.name}，现在可以直接持续对话。`,
      meta: { live: true }
    })
    db.emitTaskRefresh(taskId, { liveSession: true })

    let stdoutBuffer = ''
    proc.stdout.on('data', (data) => {
      stdoutBuffer += data.toString()
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (line) {
          this.handleLiveSessionEvent(taskId, line)
        }
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })

    proc.stderr.on('data', (data) => {
      const text = data.toString().trim()
      if (!text) return
      db.appendTaskOutput(taskId, `[ERROR] ${text}`)
    })

    proc.on('close', async (code) => {
      const liveTask = this.activeTasks.get(taskId)
      if (!liveTask || liveTask.sessionMode !== 'live') {
        return
      }
      const remaining = stdoutBuffer.trim()
      if (remaining) {
        stdoutBuffer = ''
        await this.handleLiveSessionEvent(taskId, remaining)
      }
      if (!liveTask.closing) {
        await this.teardownLiveSession(taskId, code === 0 ? 'session_closed' : 'session_error')
      }
    })

    proc.on('error', async (error) => {
      db.appendTaskOutput(taskId, `[ERROR] 实时会话进程异常: ${error.message}`)
      const liveTask = this.activeTasks.get(taskId)
      if (!liveTask || liveTask.sessionMode !== 'live') {
        return
      }
      if (!liveTask.closing) {
        await this.teardownLiveSession(taskId, 'session_error')
      }
    })

    return {
      task: db.getTaskById(taskId),
      liveSession: this.getTaskRuntimeState(taskId).liveSession,
      delivery: 'started'
    }
  }

  async handleLiveSessionEvent(taskId, rawLine) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live') {
      return
    }

    const result = this.processStructuredStreamEvent(taskId, activeTask, rawLine)
    if (!result.handled || result.finalText === undefined) {
      return
    }

    const rawFinalText = String(result.finalText || '').trim()
    const taskBeforeUpdate = db.getTaskById(taskId)
    const { cleanText, nextStatus: explicitStatus } = this.parseLiveStatusMarker(rawFinalText)
    const finalText = this.commitAssistantText(taskId, activeTask, cleanText, {
      persistMessage: true,
      persistOutput: true,
      messageMeta: { mode: 'live' }
    })
    const nextStatus = explicitStatus || this.inferLiveStatusFromText(finalText, taskBeforeUpdate?.status || 'InDev')
    activeTask.turns = Number(activeTask.turns || 0) + 1

    await this.applyLiveTaskStatus(taskId, nextStatus, activeTask)
    db.emitTaskRefresh(taskId, { liveSession: true })
    this.flushQueuedLiveMessages(taskId)
  }

  async dispatchLiveMessage(taskId, content) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live') {
      throw new Error('Live session is not active')
    }

    if (!activeTask.process?.stdin || activeTask.process.stdin.destroyed || !activeTask.process.stdin.writable) {
      throw new Error('Live session is unavailable')
    }

    activeTask.isResponding = true
    activeTask.pendingAssistantText = ''
    activeTask.currentTool = null
    activeTask.lastActivity = new Date().toISOString()
    db.emitTaskRefresh(taskId, { liveSession: true })

    activeTask.process.stdin.write(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }]
      }
    }) + '\n')
  }

  async flushQueuedLiveMessages(taskId) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live' || activeTask.isResponding) {
      return false
    }

    const nextMessage = activeTask.queuedUserMessages.shift()
    if (!nextMessage) {
      db.emitTaskRefresh(taskId, { liveSession: true })
      return false
    }

    await this.dispatchLiveMessage(taskId, nextMessage.content)
    return true
  }

  async handleLiveUserMessage(taskId, content, options = {}) {
    const messageText = String(content || '').trim()
    if (!messageText) {
      throw new Error('message is required')
    }

    await this.startLiveSession(taskId, options)

    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live') {
      throw new Error('Live session is not active')
    }

    const message = db.addTaskMessage(taskId, {
      role: 'user',
      kind: 'user',
      content: messageText,
      meta: {
        live: true,
        sessionId: activeTask.liveSessionId || null,
        agentId: activeTask.agent?.id || null
      }
    })

    db.addTaskLog(taskId, {
      agentId: activeTask.agent?.id,
      action: '实时对话',
      message: messageText
    })

    if (activeTask.isResponding) {
      activeTask.queuedUserMessages.push({ content: messageText, messageId: message?.id || null })
      db.emitTaskRefresh(taskId, { liveSession: true })
      return {
        message,
        task: db.getTaskById(taskId),
        liveSession: this.getTaskRuntimeState(taskId).liveSession,
        delivery: 'queued'
      }
    }

    await this.dispatchLiveMessage(taskId, messageText)

    return {
      message,
      task: db.getTaskById(taskId),
      liveSession: this.getTaskRuntimeState(taskId).liveSession,
      delivery: 'sent'
    }
  }

  async teardownLiveSession(taskId, reason = 'session_closed') {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live') {
      return false
    }

    if (activeTask.closing) {
      return false
    }
    activeTask.closing = true

    try {
      if (activeTask.process?.stdin && !activeTask.process.stdin.destroyed) {
        activeTask.process.stdin.end()
      }
    } catch (error) {}

    try {
      if (activeTask.process && typeof activeTask.process.kill === 'function' && !activeTask.process.killed) {
        activeTask.process.kill('SIGTERM')
      }
    } catch (error) {}

    db.releaseAgent(activeTask.agent.id, taskId)

    const workspaceConfig = workflowManager.getWorkspaceConfig()
    await workspaceManager.cleanupWorkspace(taskId, {
      beforeCleanup: workspaceConfig.hooks?.beforeCleanup
    })

    this.activeTasks.delete(taskId)

    const reasonText = reason === 'user_stopped'
      ? '实时会话已结束。'
      : reason === 'session_error'
        ? '实时会话异常中断。'
        : '实时会话已断开。'

    db.addTaskMessage(taskId, {
      role: 'system',
      kind: 'system',
      content: reasonText,
      meta: { live: true }
    })
    db.addTaskLog(taskId, {
      agentId: activeTask.agent?.id,
      action: '实时会话结束',
      message: reasonText
    })
    db.emitTaskRefresh(taskId, { liveSession: true })

    // Stop Hook: 会话结束时触发
    if (this.onStop) {
      try {
        await this.onStop(taskId, activeTask, reason)
      } catch (e) {
        console.error('[Scheduler] Stop hook failed:', e.message)
      }
    }

    return true
  }

  async stopLiveSession(taskId, reason = 'user_stopped') {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask || activeTask.sessionMode !== 'live') {
      return {
        success: false,
        reason: 'not_active'
      }
    }

    await this.teardownLiveSession(taskId, reason)

    return {
      success: true,
      task: db.getTaskById(taskId)
    }
  }

  /**
   * 获取任务优先级分数
   */
  getTaskPriority(task) {
    let priority = 0

    // 根据状态计算优先级
    switch (task.status) {
      case 'InFix':
        priority += 100 // 修复任务最高优先
        break
      case 'Blocked':
        priority += 90
        break
      case 'ReadyForTest':
        priority += 80
        break
      case 'ReadyForDeploy':
        priority += 70
        break
      case 'InDev':
        priority += 50
        break
      case 'Backlog':
        priority += 30
        break
    }

    // 根据循环次数调整（Bug 循环多的优先）
    const loopCount = Number(task.loopCount || 0)
    if (loopCount > 0) {
      priority += loopCount * 5
    }

    // 老任务优先
    const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : Date.now()
    const age = Date.now() - createdAt
    const ageHours = age / (1000 * 60 * 60)
    priority += Math.min(ageHours, 24) // 最多加 24 分

    return priority
  }

  /**
   * 排序任务队列
   */
  sortTaskQueue() {
    this.taskQueue.sort((a, b) => {
      return this.getTaskPriority(b) - this.getTaskPriority(a)
    })
  }

  /**
   * 查找可认领的任务
   * 返回 { analysisTasks: [], executionTasks: [], verificationTasks: [] }
   */
  findClaimableTasks() {
    const board = db.getBoard()
    const analysisTasks = []  // 需要分析的任务（顶级任务默认分析；复杂子任务可递归分析到第 3 层）
    const executionTasks = [] // 普通执行任务（包括子任务）
    const verificationTasks = [] // 待验证任务（ReadyForTest）

    // Backlog 中的任务：顶级任务先做一次分析。子任务是否继续分析，由父任务调度时决定。
    const backlogTasks = board['Backlog'] || []
    for (const task of backlogTasks) {
      if (this.isTaskCoolingDown(task)) {
        continue
      }
      if (!task.assignedAgentId && !this.activeTasks.has(task.id)) {
        const isTopLevelTask = !task.parentTaskId
        const hasNoSubTasks = !task.subTaskIds || task.subTaskIds.length === 0

        if (isTopLevelTask && hasNoSubTasks) {
          analysisTasks.push(task)
        } else if (isTopLevelTask && !hasNoSubTasks) {
          executionTasks.push(task)
        }
      }
    }

    // ReadyForTest 状态的任务进入 QA 自动化验证。
    // 子任务先验证自身交付结果，全部通过后父任务再做主任务级统一验证。
    const readyForTestTasks = board['ReadyForTest'] || []
    for (const task of readyForTestTasks) {
      if (this.isTaskCoolingDown(task)) {
        continue
      }
      if (task.parentTaskId && !this.areTaskDependenciesDone(task)) {
        continue
      }
      if (!task.assignedAgentId && !this.activeTasks.has(task.id)) {
        verificationTasks.push(task)
      }
    }

    // 执行任务：InFix, ReadyForDeploy, InDev
    // 注意：跳过有子任务的父任务（父任务只跟踪子任务进度，不直接执行）
    // 注意：Blocked 状态的任务不自动执行，需要人工介入
    const executionStatuses = ['InFix', 'ReadyForDeploy', 'InDev']
    const MAX_LOOP_COUNT = 3 // 最大循环次数

    for (const status of executionStatuses) {
      const tasks = board[status] || []
      for (const task of tasks) {
        if (this.isTaskCoolingDown(task)) {
          continue
        }
        const hasSubTasks = task.subTaskIds && task.subTaskIds.length > 0

        // 有子任务的父任务：检查是否有子任务可以调度
        if (hasSubTasks) {
          // 获取子任务状态
          const subTasks = task.subTaskIds.map(id => db.getTaskById(id)).filter(t => t)
          const allSubTasksDone = subTasks.length > 0 && subTasks.every(st => st.status === 'Done')
          const runnableSubTasks = subTasks.filter(st =>
            this.areTaskDependenciesDone(st) &&
              st.status === 'Backlog' &&
              !st.assignedAgentId &&
              !this.activeTasks.has(st.id)
          )

          if (runnableSubTasks.length > 0) {
            const recursiveAnalysisTasks = []
            const directExecutionTasks = []

            for (const subTask of runnableSubTasks) {
              if (this.needsTaskAnalysis(subTask)) {
                recursiveAnalysisTasks.push(subTask)
              } else {
                directExecutionTasks.push(subTask)
              }
            }

            analysisTasks.push(...recursiveAnalysisTasks)
            executionTasks.push(...directExecutionTasks)
          } else if (status === 'InFix' && allSubTasksDone && !task.assignedAgentId && !this.activeTasks.has(task.id)) {
            // 子任务都完成后，父任务级 QA 仍失败时，允许父任务执行最终整合/修复。
            if (task.loopCount >= MAX_LOOP_COUNT) {
              this.markTaskBlockedAfterMaxRetries(task, MAX_LOOP_COUNT)
            } else {
              executionTasks.push(task)
            }
          }
          // 跳过父任务本身
          continue
        }

        // 普通任务：检查是否可以执行
        if (!task.assignedAgentId && !this.activeTasks.has(task.id)) {
          if (task.parentTaskId && !this.areTaskDependenciesDone(task)) {
            continue
          }
          if (status === 'InFix' && task.loopCount >= MAX_LOOP_COUNT) {
            this.markTaskBlockedAfterMaxRetries(task, MAX_LOOP_COUNT)
            continue
          }
          executionTasks.push(task)
        }
      }
    }

    return { analysisTasks, executionTasks, verificationTasks }
  }

  /**
   * 认领任务
   */
  async claimTask(task, agent) {
    if (!this.canAcceptTask()) {
      console.log(`[Scheduler] Cannot accept task ${task.id}: at max capacity`)
      return null
    }

    try {
      // 创建工作区
      const workspaceConfig = workflowManager.getWorkspaceConfig()
      const workspaceResult = await workspaceManager.createWorkspace(task.id, {
        afterCreate: workspaceConfig.hooks?.afterCreate
      })
      const workspacePath = workspaceResult.path
      const now = new Date().toISOString()
      db.updateTaskWorkspace(task.id, {
        path: path.resolve(workspacePath),
        status: 'active',
        retainedForQa: false,
        lastExecutionAt: now,
        cleanedAt: null
      })

      // 认领任务
      const result = db.claimTask(task.id, agent.id)
      if (!result) {
        await workspaceManager.cleanupWorkspace(task.id)
        return null
      }

      const mountedArtifacts = this.materializeDependencyArtifacts(task.id, workspacePath)
      if (mountedArtifacts.length > 0) {
        db.addTaskLog(task.id, {
          agentId: agent.id,
          action: '挂载依赖工件',
          message: `已复制 ${mountedArtifacts.length} 个依赖工件到当前工作区`
        })
        db.appendTaskOutput(task.id, `[系统] 已挂载 ${mountedArtifacts.length} 个依赖工件到工作区`)
      }

      // 添加到活跃列表
      this.activeTasks.set(task.id, {
        task: result.task,
        agent: result.agent,
        workspace: workspacePath,
        startedAt: new Date().toISOString(),
        turns: 0,
        lastActivity: new Date().toISOString(),
        process: null,
        restartRequested: null,
        sessionMode: 'batch',
        isResponding: true,
        pendingAssistantText: '',
        currentTool: null,
        recentToolEvents: []
      })

      console.log(`[Scheduler] Claimed task ${task.id} with workspace`)

      // 启动 Claude Code 执行任务
      this.executeTaskWithClaude(task.id, result.task, result.agent, workspacePath)

      return result
    } catch (error) {
      console.error(`[Scheduler] Failed to claim task ${task.id}:`, error.message)
      await workspaceManager.cleanupWorkspace(task.id)
      return null
    }
  }

  /**
   * 使用 Claude Code 执行任务
   */
  async executeTaskWithClaude(taskId, task, agent, workspacePath) {
    const { spawn } = await import('child_process')
    const claudeAgentName = this.getClaudeAgentName(agent)
    const taskPrompt = this.buildExecutionPrompt(task, agent)

    console.log(`[Scheduler] Starting Claude Code for task ${taskId}`)
    console.log(`[Scheduler] Cloud agent: ${agent.name} (role: ${agent.role}) -> Claude Code agent: ${claudeAgentName}`)

    // 构建 Claude Code 命令
    // Claude Code 完整路径
    // 构建参数
    // 注意：不使用 -w 标志，因为那会创建 git worktree
    // 我们直接用 cwd 设置工作目录
    const absoluteWorkspacePath = path.resolve(workspacePath)
    const args = [
      '-p',                          // 非交互模式
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--dangerously-skip-permissions', // 跳过权限检查
      '--no-session-persistence',     // 不持久化会话
      '--agent', claudeAgentName,      // 使用 Claude Code agent 角色
      '--',
      taskPrompt
    ]

    console.log(`[Scheduler] Executing: ${CLAUDE_LAUNCH_SPEC.displayCommand} ${args.join(' ')}`)
    console.log(`[Scheduler] cwd: ${absoluteWorkspacePath}`)

    // 关键：设置 CLAUDECODE 为空字符串（而不是删除环境变量）
    // 这样可以避免 "Cannot be launched inside another Claude Code session" 错误
    const spawnEnv = { ...process.env, CLAUDECODE: '' }

    const proc = spawn(CLAUDE_LAUNCH_SPEC.command, [...CLAUDE_LAUNCH_SPEC.prefixArgs, ...args], {
      cwd: absoluteWorkspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv
    })

    console.log(`[Scheduler] Process spawned with pid: ${proc.pid}`)

    // 保存进程引用
    const activeTask = this.activeTasks.get(taskId)
    if (activeTask) {
      activeTask.process = proc
    }
    this.trackWorkspaceProcess(taskId, proc)

    // 捕获输出并保存到任务
    let outputBuffer = ''
    const streamState = {
      buffer: '',
      capturedText: ''
    }
    proc.stdout.on('data', (data) => {
      const text = data.toString()
      if (process.env.CLAUDE_SCHEDULER_DEBUG_STREAMS === '1') {
        console.log(`[Scheduler] STDOUT for ${taskId}: ${text.substring(0, 200)}...`)
        process.stdout.write(text)
      }
      const currentActiveTask = this.activeTasks.get(taskId)
      if (!currentActiveTask) return

      this.handleStructuredStdoutChunk(taskId, currentActiveTask, text, streamState, {
        finalizeOptions: {
          persistMessage: true,
          persistOutput: true,
          messageMeta: { mode: 'batch' }
        },
        onPlainText: (line) => {
          const isCodeBlock = line.includes('```') || line.trim().startsWith('{') || line.trim().startsWith('[')
          if (isCodeBlock) {
            const content = line.split('\n').filter(l => l.trim()).join('\n')
            if (content) db.appendTaskOutput(taskId, content)
            return
          }
          db.appendTaskOutput(taskId, line)
        }
      })
    })

    proc.stderr.on('data', (data) => {
      const text = data.toString()
      if (process.env.CLAUDE_SCHEDULER_DEBUG_STREAMS === '1') {
        console.log(`[Scheduler] STDERR for ${taskId}: ${text.substring(0, 200)}...`)
        process.stderr.write(text)
      }
      outputBuffer += text
      // 错误信息也保存
      const lines = text.split('\n').filter(l => l.length)
      for (const line of lines) {
        db.appendTaskOutput(taskId, `[ERROR] ${line}`)
      }
    })

    proc.on('close', async (code) => {
      console.log(`[Scheduler] Claude Code exited for task ${taskId} with code ${code}`)

      const activeTask = this.beginExecutionSettlement(taskId)
      if (activeTask) {
        this.flushStructuredStdoutBuffer(taskId, activeTask, streamState, {
          finalizeOptions: {
            persistMessage: true,
            persistOutput: true,
            messageMeta: { mode: 'batch' }
          },
          onPlainText: (line) => {
            const isCodeBlock = line.includes('```') || line.trim().startsWith('{') || line.trim().startsWith('[')
            if (isCodeBlock) {
              const content = line.split('\n').filter(l => l.trim()).join('\n')
              if (content) db.appendTaskOutput(taskId, content)
              return
            }
            db.appendTaskOutput(taskId, line)
          }
        })
        outputBuffer += streamState.capturedText

        if (activeTask.restartRequested) {
          activeTask.process = null
          activeTask.lastActivity = new Date().toISOString()
          await this.requeueActiveTaskForUserMessage(taskId, {
            reason: activeTask.restartRequested.reason,
            skipSchedule: activeTask.restartRequested.reason === 'live_session'
          })
          return
        }

        activeTask.process = null
        activeTask.lastActivity = new Date().toISOString()

        if (code === 0) {
          // 任务成功完成
          await this.completeTask(taskId, 'ReadyForTest')
        } else if (this.isTransientClaudeServiceError(outputBuffer)) {
          await this.requeueTaskAfterTransientError(taskId, activeTask, {
            stage: '执行',
            output: outputBuffer,
            cleanupWorkspace: true,
            restoreOriginalDescription: false
          })
          this.scheduleNext()
        } else {
          // Claude Code 进程直接异常退出时，进入冷却重试而不是立刻打回 InFix。
          await this.handleExecutionProcessFailure(taskId, activeTask, {
            code,
            trigger: 'close'
          })
        }

        // Stop Hook: batch 会话结束时触发
        if (this.onStop) {
          try {
            await this.onStop(taskId, activeTask, code === 0 ? 'batch_completed' : 'batch_failed')
          } catch (e) {
            console.error('[Scheduler] Stop hook failed:', e.message)
          }
        }
      }
    })

    proc.on('error', (error) => {
      console.error(`[Scheduler] Claude Code process error for task ${taskId}:`, error.message)

      const activeTask = this.beginExecutionSettlement(taskId)
      if (activeTask) {
        if (activeTask.restartRequested) {
          activeTask.process = null
          this.requeueActiveTaskForUserMessage(taskId, {
            reason: activeTask.restartRequested.reason,
            skipSchedule: activeTask.restartRequested.reason === 'live_session'
          })
          return
        }

        activeTask.process = null
        this.handleExecutionProcessFailure(taskId, activeTask, {
          code: null,
          trigger: `process_error:${error.message}`
        }).catch(settlementError => {
          console.error(`[Scheduler] Failed to settle execution process error for ${taskId}:`, settlementError.message)
        })
      }
    })
  }

  /**
   * 分析并分解任务（planner agent 执行）
   */
  async analyzeAndDecompose(task, agent, workspacePath) {
    const { spawn } = await import('child_process')
    const currentDepth = this.getTaskDepth(task)
    const maxDepth = this.getTaskMaxDecompositionDepth(task)
    const nextDepth = currentDepth + 1
    const canSubTasksDecomposeFurther = nextDepth < maxDepth
    const taskPrompt = `你是一个任务规划专家。请分析以下任务并分解成可执行的小任务。

任务：${task.title}
${task.description || '无详细描述'}

当前任务深度: 第 ${currentDepth} 层
本轮生成的子任务深度: 第 ${nextDepth} 层
系统允许的最大拆解深度: 第 ${maxDepth} 层
${canSubTasksDecomposeFurther
    ? '本轮生成的子任务如果仍然明显过大、包含多阶段/多产物/强依赖，可以标记 shouldDecomposeFurther: true，后续再拆到第 3 层。'
    : '本轮已经是最后一层，所有子任务都必须可以直接执行，shouldDecomposeFurther 必须为 false。'}${this.buildOperationFolderContext(task)}${this.buildConversationContext(task)}${this.buildAgentInstructionFallback(agent, { heading: '【Planner Agent 职责回放】' })}

请以 JSON 格式输出任务分解计划，格式如下：
{
  "summary": "对该任务的整体分析和分解思路",
  "acceptanceCriteria": ["如果不拆分子任务，主任务级验收标准1"],
  "verificationPlan": ["如果不拆分子任务，主任务级验证步骤1"],
  "subTasks": [
    {
      "title": "子任务1标题",
      "description": "子任务1的具体描述",
      "dependsOn": [],
      "parallelGroup": "可选的并行分组名",
      "canRunInParallel": true,
      "acceptanceCriteria": [
        "可测试、可观察的完成标准，避免只写'完成实现'"
      ],
      "verificationPlan": [
        "QA 可以实际执行的验证步骤/命令/文件路径"
      ],
      "handoffArtifacts": [
        "需要交给下游任务的文件、路径、接口或决策"
      ],
      "canExecuteDirectly": true,
      "shouldDecomposeFurther": false,
      "decompositionReason": "为什么这个子任务可以直接执行，或为什么还需要继续拆",
      "riskSignals": [
        "多阶段流程"
      ],
      "qaRubric": {
        "functionality": "功能完整性 1-5 分，低于 4 失败",
        "realArtifacts": "真实产物 1-5 分，低于 4 失败",
        "usability": "可用性/产品深度 1-5 分，低于 3 失败",
        "codeQuality": "代码质量/可维护性 1-5 分，低于 3 失败"
      }
    },
    {
      "title": "子任务2标题",
      "description": "子任务2的具体描述",
      "dependsOn": [1],
      "parallelGroup": "可选的并行分组名",
      "canRunInParallel": false,
      "acceptanceCriteria": ["必须等待第 1 个任务产物存在并可用"],
      "verificationPlan": ["检查第 1 个任务产物并执行本任务的验证命令"],
      "handoffArtifacts": ["本任务输出给后续任务使用的产物"],
      "canExecuteDirectly": false,
      "shouldDecomposeFurther": true,
      "decompositionReason": "这个子任务仍然包含研究、实现、联调多个阶段，建议继续拆解",
      "riskSignals": ["研究+实现混合", "多产物交付", "跨目录工件交接"],
      "qaRubric": {
        "functionality": "功能完整性 1-5 分，低于 4 失败",
        "realArtifacts": "真实产物 1-5 分，低于 4 失败",
        "usability": "可用性/产品深度 1-5 分，低于 3 失败",
        "codeQuality": "代码质量/可维护性 1-5 分，低于 3 失败"
      }
    }
  ]
}

请确保分解出的子任务：
1. 逻辑清晰，每任务可独立执行
2. 有明确的完成标准
3. 按照执行顺序排列
4. 必须标注依赖关系：dependsOn 使用 1-based 子任务序号数组，例如 [1, 2] 表示必须等第 1、2 个子任务 Done 后才能执行
5. 可以并行执行的任务 dependsOn 设为空数组或只依赖相同前置任务，并设置 canRunInParallel: true；有严格先后关系的任务设置 canRunInParallel: false
6. 为每个子任务写“冲刺契约”：acceptanceCriteria 必须具体、可测试；verificationPlan 必须让 QA 能真实执行；handoffArtifacts 必须说明给后续任务传递什么
7. 不要过早规定具体实现细节；契约约束“交付什么、如何验收”，实现路径交给执行 agent
8. 你必须为每个子任务判断 canExecuteDirectly / shouldDecomposeFurther：
   - canExecuteDirectly: true 表示一个合格执行 agent 可以在一次连续执行里完成它，不需要再拆
   - shouldDecomposeFurther: true 只在子任务本身仍然是多阶段、多产物、强依赖、跨目录工件交接，或“研究 + 实现 + 验证”混合包时使用
   - canExecuteDirectly 和 shouldDecomposeFurther 不要同时为 true
   - decompositionReason 用中文简要解释判断原因
   - riskSignals 列出触发继续拆解判断的风险信号；如果没有明显风险，返回空数组
9. ${canSubTasksDecomposeFurther
    ? `本轮生成的是第 ${nextDepth} 层子任务，你可以按需标记 shouldDecomposeFurther: true，让系统在下一轮再拆解一次。`
    : `本轮生成的是最后一层（第 ${nextDepth} 层），所以所有子任务都必须设置 shouldDecomposeFurther: false，并写成可以直接执行的工作包。`}

重要：如果任务描述不完整或缺少关键信息（如目标、路径、具体要求等），请在 summary 中指出需要补充的信息，并设置 needsMoreInfo: true。

只输出 JSON，不要有其他内容。`

    const claudeAgentName = this.getClaudeAgentName(agent)
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--agent', claudeAgentName,
      '--',
      taskPrompt
    ]

    console.log(`[Scheduler] Analyzing task ${task.id} with ${claudeAgentName} agent`)

    const spawnEnv = { ...process.env, CLAUDECODE: '' }

    return new Promise((resolve) => {
      let output = ''
      let errorOutput = ''
      const streamState = {
        buffer: '',
        capturedText: ''
      }

      const proc = spawn(CLAUDE_LAUNCH_SPEC.command, [...CLAUDE_LAUNCH_SPEC.prefixArgs, ...args], {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv
      })

      const activeTask = this.activeTasks.get(task.id)
      if (activeTask) {
        activeTask.process = proc
      }
      this.trackWorkspaceProcess(task.id, proc)

      proc.stdout.on('data', (data) => {
        const text = data.toString()
        const currentActiveTask = this.activeTasks.get(task.id)
        if (!currentActiveTask) return

        this.handleStructuredStdoutChunk(task.id, currentActiveTask, text, streamState, {
          finalizeOptions: {
            persistMessage: false,
            persistOutput: true
          },
          onPlainText: (line) => {
            const isCodeBlock = line.includes('```') || line.trim().startsWith('{') || line.trim().startsWith('[')
            if (isCodeBlock) {
              const content = line.split('\n').filter(l => l.trim()).join('\n')
              if (content) db.appendTaskOutput(task.id, content)
              return
            }
            db.appendTaskOutput(task.id, line)
          }
        })
      })

      proc.stderr.on('data', (data) => {
        const text = data.toString()
        errorOutput += text
        // 错误信息也保存
        const lines = text.split('\n').filter(l => l.trim())
        for (const line of lines) {
          db.appendTaskOutput(task.id, `[ERROR] ${line}`)
        }
      })

      proc.on('close', async (code) => {
        console.log(`[Scheduler] Planner exited with code ${code}`)
        const activeTask = this.activeTasks.get(task.id)
        if (activeTask?.restartRequested) {
          resolve({ success: false, reason: 'requeued_by_user_message' })
          return
        }

        if (activeTask) {
          this.flushStructuredStdoutBuffer(task.id, activeTask, streamState, {
            finalizeOptions: {
              persistMessage: false,
              persistOutput: true
            },
            onPlainText: (line) => {
              const isCodeBlock = line.includes('```') || line.trim().startsWith('{') || line.trim().startsWith('[')
              if (isCodeBlock) {
                const content = line.split('\n').filter(l => l.trim()).join('\n')
                if (content) db.appendTaskOutput(task.id, content)
                return
              }
              db.appendTaskOutput(task.id, line)
            }
          })
        }

        output = streamState.capturedText
        console.log(`[Scheduler] Planner output: ${output.substring(0, 500)}`)

        // 保存最终输出摘要
        db.appendTaskOutput(task.id, `--- Planner 分析完成 (code: ${code}) ---`)

        const combinedOutput = `${output}\n${errorOutput}`.trim()
        if (code !== 0) {
          const isTransientError = this.isTransientClaudeServiceError(combinedOutput)
          const message = isTransientError
            ? this.buildTransientRetryMessage('分析', combinedOutput)
            : `Planner 分析进程异常退出（code: ${code}），任务已退回待处理等待重新分析。`
          const reason = isTransientError ? 'planner_infra_error' : 'planner_process_failed'
          resolve(this.markAnalysisForRetry(task.id, agent, reason, message, isTransientError ? 60000 : 30000))
          return
        }

        // 解析 JSON 输出
        try {
          // 尝试提取 JSON
          const jsonMatch = output.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0])
            if (result?.type === 'error' || result?.error) {
              const serializedResult = JSON.stringify(result)
              const isTransientError = this.isTransientClaudeServiceError(serializedResult)
              const message = isTransientError
                ? this.buildTransientRetryMessage('分析', serializedResult)
                : 'Planner 返回错误对象而不是任务分解计划，任务已退回待处理等待重新分析。'
              const reason = isTransientError ? 'planner_infra_error' : 'planner_invalid_output'
              resolve(this.markAnalysisForRetry(task.id, agent, reason, message, isTransientError ? 60000 : 30000))
              return
            }

            const needsMoreInfo = result.needsMoreInfo || false
            if (!needsMoreInfo && !Array.isArray(result.subTasks)) {
              const message = 'Planner 输出缺少 subTasks 数组，任务已退回待处理等待重新分析。'
              resolve(this.markAnalysisForRetry(task.id, agent, 'planner_invalid_output', message, 30000))
              return
            }

            const subTasks = Array.isArray(result.subTasks) ? result.subTasks : []
            const canSubTasksBeSplitAgain = nextDepth < maxDepth

            console.log(`[Scheduler] Created ${subTasks.length} subtasks for task ${task.id}`)

            // 检查是否需要更多信息
            if (needsMoreInfo) {
              // 信息不全，进入 Collecting 状态，等待人类补充
              db.updateTaskStatus(task.id, 'Collecting')
              db.addTaskLog(task.id, {
                agentId: agent.id,
                action: '需要补充信息',
                message: result.summary || '任务缺少关键信息，需要人类补充'
              })
              // 记录需要补充的具体问题
              const taskRef = db.getTaskById(task.id)
              if (taskRef) {
                taskRef.decompositionNote = result.summary || ''
                taskRef.collectingQuestions = result.questions || []
                taskRef.updatedAt = new Date().toISOString()
                db.save()
              }
              resolve({ success: false, reason: 'needs_more_info', message: result.summary })
              return
            }

            // 信息完整，创建子任务，并保留 Planner 给出的依赖/并行元数据。
            const createdSubTasks = []
            subTasks.forEach((st, index) => {
              const dependencyRefs = Array.isArray(st.dependsOn) ? st.dependsOn : []
              const shouldDecomposeFurther = canSubTasksBeSplitAgain && st.shouldDecomposeFurther === true
              const createdSubTask = db.createSubTask(task.id, st.title, st.description || '', {
                sequenceIndex: index,
                dependencyRefs,
                parallelGroup: st.parallelGroup || st.phase || null,
                canRunInParallel: st.canRunInParallel !== false,
                acceptanceCriteria: this.normalizeStringArray(st.acceptanceCriteria),
                verificationPlan: this.normalizeStringArray(st.verificationPlan),
                handoffArtifacts: this.normalizeStringArray(st.handoffArtifacts),
                qaRubric: st.qaRubric || null,
                canExecuteDirectly: shouldDecomposeFurther ? false : st.canExecuteDirectly !== false,
                shouldDecomposeFurther,
                decompositionReason: typeof st.decompositionReason === 'string' ? st.decompositionReason : '',
                riskSignals: this.normalizeStringArray(st.riskSignals)
              })
              if (createdSubTask) {
                createdSubTasks.push(createdSubTask)
              }
            })

            createdSubTasks.forEach((createdSubTask, index) => {
              const plannerSubTask = subTasks[index] || {}
              createdSubTask.dependsOnSubTaskIds = this.resolvePlannerDependencyIds(
                plannerSubTask.dependsOn,
                subTasks,
                createdSubTasks,
                index
              )
              createdSubTask.updatedAt = new Date().toISOString()
            })
            if (createdSubTasks.length > 0) {
              db.save()
            }

            // 创建子任务后父任务进入开发跟踪；没有子任务则由执行 agent 直接处理主任务。
            db.updateTaskStatus(task.id, 'InDev')
            const recursiveSubTaskCount = createdSubTasks.filter(st => st.shouldDecomposeFurther).length

            // 记录分析日志
            db.addTaskLog(task.id, {
              agentId: agent.id,
              action: '任务分解',
              message: subTasks.length > 0
                ? `Planner 分析完成，分解为 ${subTasks.length} 个子任务，其中 ${recursiveSubTaskCount} 个子任务标记为建议继续拆解`
                : 'Planner 分析完成，未拆分子任务，主任务将直接进入执行'
            })

            // 记录分解说明
            const taskRef = db.getTaskById(task.id)
            if (taskRef) {
              taskRef.decompositionNote = result.summary || ''
              taskRef.decompositionReason = result.summary || taskRef.decompositionReason || ''
              taskRef.shouldDecomposeFurther = false
              taskRef.canExecuteDirectly = subTasks.length === 0
              if (subTasks.length === 0) {
                taskRef.acceptanceCriteria = this.normalizeStringArray(result.acceptanceCriteria)
                taskRef.verificationPlan = this.normalizeStringArray(result.verificationPlan)
                taskRef.handoffArtifacts = this.normalizeStringArray(result.handoffArtifacts)
                taskRef.qaRubric = result.qaRubric || null
              }
              taskRef.updatedAt = new Date().toISOString()
              db.save()
            }

            resolve({ success: true, subTaskCount: subTasks.length })
          } else {
            // 无法解析 JSON，将任务改回 Backlog 以便重新分析
            console.error('[Scheduler] Failed to parse planner output as JSON')
            db.appendTaskOutput(task.id, `[ERROR] 无法解析 Planner 输出为 JSON 格式`)
            resolve(this.markAnalysisForRetry(
              task.id,
              agent,
              'planner_invalid_output',
              'Planner 输出无法解析为 JSON，任务已退回待处理等待重新分析。',
              30000
            ))
          }
        } catch (e) {
          console.error('[Scheduler] Error parsing planner output:', e.message)
          db.appendTaskOutput(task.id, `[ERROR] 解析 Planner 输出失败: ${e.message}`)
          resolve(this.markAnalysisForRetry(
            task.id,
            agent,
            'planner_invalid_output',
            `Planner 输出解析异常：${e.message}。任务已退回待处理等待重新分析。`,
            30000
          ))
        }
      })

      proc.on('error', (error) => {
        console.error(`[Scheduler] Planner process error:`, error.message)
        const activeTask = this.activeTasks.get(task.id)
        if (activeTask?.restartRequested) {
          resolve({ success: false, reason: 'requeued_by_user_message' })
          return
        }
        resolve(this.markAnalysisForRetry(
          task.id,
          agent,
          'planner_process_error',
          `Planner 进程启动/运行异常：${error.message}。任务已退回待处理等待重新分析。`,
          30000
        ))
      })
    })
  }

  /**
   * PTY 模式完成任务
   */
  async completeTaskFromPty(taskId, exitCode) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) {
      console.log(`[Scheduler] Task ${taskId} not in active list (PTY)`)
      return
    }

    // 清理 PTY
    if (activeTask.pty) {
      try {
        activeTask.pty.kill()
      } catch (e) {}
    }

    await this.completeTask(taskId, exitCode === 0 ? 'ReadyForTest' : 'InFix')
  }

  /**
   * 完成任务
   */
  async completeTask(taskId, newStatus = 'ReadyForTest') {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) {
      console.log(`[Scheduler] Task ${taskId} not in active list`)
      return
    }

    try {
      this.resetExecutionFailureState(taskId)

      // 保存 agent 和 task 引用
      const agent = activeTask.agent
      const task = activeTask.task

      // 子任务执行完成后保留在 ReadyForTest，进入测试清单；
      // 但调度器不会自动把子任务送进 AI QA，统一由父任务在集成完成后验证。
      let effectiveStatus = newStatus
      const executionCompletedAt = new Date().toISOString()
      const workspacePath = activeTask.workspace || task.workspace?.path || workspaceManager.getWorkspacePath(taskId)
      const absoluteWorkspacePath = workspacePath ? path.resolve(workspacePath) : ''

      if (absoluteWorkspacePath) {
        const artifactCheck = this.captureTaskArtifacts(taskId, absoluteWorkspacePath)
        const retainedWorkspaceStatus = effectiveStatus === 'ReadyForTest'
          ? 'retained_for_qa'
          : effectiveStatus === 'InFix'
            ? 'retained_for_fix'
            : 'retained'

        db.updateTaskWorkspace(taskId, {
          path: absoluteWorkspacePath,
          status: retainedWorkspaceStatus,
          retainedForQa: effectiveStatus === 'ReadyForTest',
          lastExecutionAt: executionCompletedAt,
          cleanedAt: null
        })

        if (effectiveStatus === 'ReadyForTest' && artifactCheck.missingRequired.length > 0) {
          const missingArtifacts = artifactCheck.missingRequired
            .map(item => item.path || item.absolutePath)
            .join('、')
          const bugMessage = `系统工件校验失败：缺少必须交付的工件 ${missingArtifacts}。请在任务工作区内生成真实产物后再提交。`

          db.addTaskLog(taskId, {
            agentId: agent.id,
            action: '工件校验',
            message: bugMessage
          })
          db.appendTaskOutput(taskId, `[系统] ${bugMessage}`)

          const bugResult = db.reportBug(taskId, bugMessage)
          effectiveStatus = bugResult?.task?.status || 'InFix'
          db.updateTaskWorkspace(taskId, {
            path: absoluteWorkspacePath,
            status: effectiveStatus === 'Blocked' ? 'blocked' : 'retained_for_fix',
            retainedForQa: false
          })
        } else if (effectiveStatus === 'ReadyForTest') {
          const existingCount = artifactCheck.manifest.filter(item => item.exists).length
          const summary = artifactCheck.manifest.length > 0
            ? `系统已记录 ${existingCount}/${artifactCheck.manifest.length} 个工件路径，QA 将直接复用当前工作区验证。`
            : '系统暂未识别到可校验工件路径，QA 将在当前工作区继续验证。'
          db.addTaskLog(taskId, {
            agentId: agent.id,
            action: '工件校验',
            message: summary
          })
        }
      }

      const persistedTask = db.getTaskById(taskId)
      if (persistedTask && persistedTask.status !== effectiveStatus) {
        db.updateTaskStatus(taskId, effectiveStatus)
      }

      // 记录执行日志
      const actionLabels = {
        'ReadyForTest': '开发完成',
        'ReadyForDeploy': '测试通过',
        'Done': '任务完成',
        'InFix': '执行异常'
      }
      const logAction = actionLabels[effectiveStatus] || '状态变更'
      const logMessage = `Agent [${agent.name}] 执行完成，流转至 ${effectiveStatus}`
      db.addTaskLog(taskId, {
        agentId: agent.id,
        action: logAction,
        message: logMessage
      })

      // 提取最终完成总结到 outputLines
      const completedTask = db.getTaskById(taskId)
      if (completedTask) {
        const summaryLine = `✓ Agent [${agent.name}] 完成执行，状态流转至: ${effectiveStatus}`
        db.appendTaskOutput(taskId, summaryLine)
      }

      // 如果是子任务，检查父任务是否所有子任务都完成
      if (task.parentTaskId) {
        db.checkAndUpdateParentCompletion(taskId)
      }

      // 释放 agent（清除 currentTaskId，设置 status 为 idle，并清除任务的 assignedAgentId）
      db.releaseAgent(agent.id, taskId)

      // 从活跃列表移除
      this.activeTasks.delete(taskId)

      console.log(`[Scheduler] Completed task ${taskId} -> ${effectiveStatus}`)

      // 触发下一个任务
      this.scheduleNext()
    } catch (error) {
      console.error(`[Scheduler] Error completing task ${taskId}:`, error.message)
    }
  }

  /**
   * 报告 Bug
   */
  async reportBug(taskId, bugReport) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) {
      console.log(`[Scheduler] Task ${taskId} not in active list`)
      return
    }

    try {
      const result = db.reportBug(taskId, bugReport)
      if (!result) return

      // 更新活跃任务信息
      activeTask.task = result.task
      activeTask.turns++

      // 如果任务被阻塞，从活跃列表移除
      if (result.blocked) {
        console.log(`[Scheduler] Task ${taskId} is now blocked`)
        db.updateTaskWorkspace(taskId, {
          status: 'blocked',
          retainedForQa: false
        })

        this.activeTasks.delete(taskId)
      }

      // 触发下一个任务
      this.scheduleNext()
    } catch (error) {
      console.error(`[Scheduler] Error reporting bug for ${taskId}:`, error.message)
    }
  }

  /**
   * 调度下一个任务
   */
  async scheduleNext() {
    if (!this.running) {
      return
    }

    // 防止并发调度
    if (this.isScheduling) {
      return
    }
    this.isScheduling = true

    try {
      while (this.canAcceptTask()) {
        // 查找可认领的任务（分离分析任务、执行任务和验证任务）
        const { analysisTasks, executionTasks, verificationTasks } = this.findClaimableTasks()

        // 调试日志
        console.log(`[Scheduler] Found: ${analysisTasks.length} analysis, ${executionTasks.length} execution, ${verificationTasks.length} verification`)

        let claimed = false

        // 优先处理分析任务
        if (analysisTasks.length > 0) {
          const agent = this.findBestAgentForTask(analysisTasks[0], 'analysis')
          if (agent) {
            await this.claimAnalysisTask(analysisTasks[0], agent)
            claimed = true
          }
        }

        // 处理验证任务（ReadyForTest）- QA 自动化验证
        if (!claimed && verificationTasks.length > 0) {
          const agent = this.findBestAgentForTask(verificationTasks[0], 'verification')
          if (agent) {
            await this.claimVerificationTask(verificationTasks[0], agent)
            claimed = true
          }
        }

        // 处理执行任务
        if (!claimed && executionTasks.length > 0) {
          // 按优先级排序
          executionTasks.sort((a, b) => this.getTaskPriority(b) - this.getTaskPriority(a))
          const agent = this.findBestAgentForTask(executionTasks[0], 'execution')
          if (agent) {
            await this.claimTask(executionTasks[0], agent)
            claimed = true
          }
        }

        if (!claimed) {
          console.log('[Scheduler] No tasks or agents available')
          break
        }

        // 分析会占用当前调度循环较长时间，这里交回后续 tick 或显式触发继续调度。
        // 验证任务会异步运行，可以继续领取其它待测试任务来填满容量。
        if (this.isScheduling && this.activeTasks.size > 0 && analysisTasks.length > 0) {
          break
        }
      }
    } finally {
      this.isScheduling = false
    }
  }

  requestImmediateSchedule(reason = 'manual') {
    if (!this.running || this.pendingImmediateSchedule) {
      return false
    }

    this.pendingImmediateSchedule = true
    setTimeout(async () => {
      this.pendingImmediateSchedule = false
      try {
        console.log(`[Scheduler] Immediate schedule requested: ${reason}`)
        await this.tick()
      } catch (error) {
        console.error(`[Scheduler] Immediate schedule failed (${reason}):`, error.message)
      }
    }, 0)

    return true
  }

  /**
   * 根据任务类型和内容选择最合适的 agent
   */
  findBestAgentForTask(task, taskType) {
    // 获取所有空闲的 agents
    const idleAgents = db.getAgents().filter(a => a.status !== 'offline' && !a.currentTaskId)

    if (idleAgents.length === 0) {
      return null
    }

    // 验证任务：根据父任务 context 选择合适的验证 agent
    if (taskType === 'verification') {
      // 优先选择 qa-tester, verifier, test-engineer
      const preferredAgents = idleAgents.filter(a => ['qa-tester', 'verifier', 'test-engineer'].includes(a.role))
      if (preferredAgents.length > 0) {
        return preferredAgents[0]
      }
      // 如果没有专业的 QA agent，选择 code-reviewer
      const reviewerAgents = idleAgents.filter(a => ['code-reviewer', 'critic'].includes(a.role))
      if (reviewerAgents.length > 0) {
        return reviewerAgents[0]
      }
      return idleAgents[0]
    }

    // 分析任务：优先选择 planner
    if (taskType === 'analysis') {
      const plannerAgents = idleAgents.filter(a => ['planner', 'analyst', 'architect'].includes(a.role))
      if (plannerAgents.length > 0) {
        return plannerAgents[0]
      }
      return idleAgents[0]
    }

    const rankedAgents = idleAgents
      .map(agent => {
        const scoring = this.scoreExecutionAgentForTask(task, agent)
        return {
          agent,
          score: scoring.score,
          scoreBreakdown: scoring.scoreBreakdown,
          priorityBonus: this.getRolePriorityBonus(agent.role, 'execution')
        }
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score
        if (right.priorityBonus !== left.priorityBonus) return right.priorityBonus - left.priorityBonus
        const rightLevel = Number.isFinite(Number(right.agent?.level)) ? Number(right.agent.level) : 0
        const leftLevel = Number.isFinite(Number(left.agent?.level)) ? Number(left.agent.level) : 0
        if (rightLevel !== leftLevel) return rightLevel - leftLevel
        return String(left.agent?.name || '').localeCompare(String(right.agent?.name || ''))
      })

    const bestMatch = rankedAgents[0]
    if (bestMatch) {
      const breakdown = bestMatch.scoreBreakdown
        .map(item => `${item.reason}:${item.score > 0 ? '+' : ''}${item.score}`)
        .join(', ')
      console.log(
        `[Scheduler] Task "${task.title}" selected agent: ${bestMatch.agent.role} ` +
        `(score=${bestMatch.score}${breakdown ? `; ${breakdown}` : ''})`
      )
      return bestMatch.agent
    }

    return idleAgents[0]
  }

  /**
   * 认领分析任务（使用 planner）
   */
  async claimAnalysisTask(task, agent) {
    if (!this.canAcceptTask()) {
      console.log(`[Scheduler] Cannot accept analysis task ${task.id}: at max capacity`)
      return null
    }

    try {
      // 创建工作区
      const workspaceConfig = workflowManager.getWorkspaceConfig()
      const workspaceResult = await workspaceManager.createWorkspace(task.id, {
        afterCreate: workspaceConfig.hooks?.afterCreate
      })
      const workspacePath = workspaceResult.path

      // 先更新状态为"分析中"
      db.updateTaskStatus(task.id, 'Analyzing')

      // 认领任务（只设置 assignedAgentId，不改状态）
      const taskRef = db.getTaskById(task.id)
      if (!taskRef) {
        await workspaceManager.cleanupWorkspace(task.id)
        return null
      }
      taskRef.assignedAgentId = agent.id
      agent.currentTaskId = task.id
      agent.status = 'busy'
      db.save()

      // 添加到活跃列表
      this.activeTasks.set(task.id, {
        task: taskRef,
        agent: agent,
        workspace: workspacePath,
        startedAt: new Date().toISOString(),
        turns: 0,
        lastActivity: new Date().toISOString(),
        process: null,
        isAnalysis: true,
        restartRequested: null,
        sessionMode: 'analysis',
        isResponding: true,
        pendingAssistantText: '',
        currentTool: null,
        recentToolEvents: []
      })

      console.log(`[Scheduler] Claimed analysis task ${task.id}`)

      // 执行分析分解
      const result = await this.analyzeAndDecompose(taskRef, agent, workspacePath)

      // 分析完成，清理工作区
      await workspaceManager.cleanupWorkspace(task.id, {
        beforeCleanup: workspaceConfig.hooks?.beforeCleanup
      })

      // 检查是否需要补充信息
      if (result && result.reason === 'needs_more_info') {
        // 需要补充信息：任务进入 Collecting 状态，保留给人类补充
        // 清除 assignedAgentId，让任务可以被人类认领修改
        taskRef.assignedAgentId = null
        agent.currentTaskId = null
        agent.status = 'idle'
        db.save()

        // 从活跃列表移除，但不调度下一个（等人类补充）
        this.activeTasks.delete(task.id)
        console.log(`[Scheduler] Task ${task.id} needs more info, moved to Collecting`)
        return { task: taskRef, agent }
      }

      if (result && result.reason === 'requeued_by_user_message') {
        taskRef.assignedAgentId = null
        agent.currentTaskId = null
        agent.status = 'idle'
        db.save()

        this.activeTasks.delete(task.id)
        db.updateTaskStatus(task.id, 'Backlog')
        console.log(`[Scheduler] Task ${task.id} interrupted by user message, back to Backlog`)
        this.scheduleNext()
        return { task: taskRef, agent }
      }

      // 释放 agent（清除 currentTaskId，设置 status 为 idle，并清除任务的 assignedAgentId）
      db.releaseAgent(agent.id, task.id)

      // 从活跃列表移除
      this.activeTasks.delete(task.id)

      // 继续调度下一个任务
      this.scheduleNext()

      return { task: taskRef, agent }
    } catch (error) {
      console.error(`[Scheduler] Failed to claim analysis task ${task.id}:`, error.message)
      return null
    }
  }

  /**
   * 认领验证任务（QA 验证）
   * 验证任务是否有有效输出，通过则流转到 Done，否则流转到 InFix
   */
  async claimVerificationTask(task, agent) {
    if (!this.canAcceptTask()) {
      console.log(`[Scheduler] Cannot accept verification task ${task.id}: at max capacity`)
      return null
    }

    try {
      // 认领任务
      const result = db.claimTask(task.id, agent.id)
      if (!result) {
        console.log(`[Scheduler] Failed to claim verification task ${task.id}`)
        return null
      }

      const taskRef = result.task
      const agentRef = result.agent

      // 添加到活跃列表
      this.activeTasks.set(task.id, {
        task: taskRef,
        agent: agentRef,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        sessionMode: 'verification',
        isResponding: true,
        pendingAssistantText: '',
        currentTool: null,
        recentToolEvents: []
      })

      console.log(`[Scheduler] Claimed verification task ${task.id} with agent ${agent.name}`)

      // 执行验证
      this.verifyTask(task.id, agentRef).catch(error => {
        console.error(`[Scheduler] Verification task ${task.id} crashed:`, error.message)
        this.activeTasks.delete(task.id)
        db.releaseAgent(agentRef.id, task.id)
        this.scheduleNext()
      })

      return { task: taskRef, agent: agentRef }
    } catch (error) {
      console.error(`[Scheduler] Failed to claim verification task ${task.id}:`, error.message)
      return null
    }
  }

  /**
   * 验证任务
   * 使用 QA agent 实际检查任务是否完成，决定是流转到 Done 还是 InFix
   */
  cleanVerificationSummaryLine(line) {
    return String(line || '')
      .replace(/\r/g, '')
      .replace(/^\s*[-*]\s+/, '')
      .replace(/\*\*/g, '')
      .trim()
  }

  extractVerificationFailReason(verifyOutput) {
    const lines = String(verifyOutput || '').replace(/\r/g, '').split('\n')
    const interestingSections = new Set(['具体缺失内容', '错误信息', '核心问题', '核心问题汇总', '问题汇总'])
    const highlights = []
    let currentSection = ''

    for (const rawLine of lines) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue

      const headingMatch = trimmed.match(/^#{2,4}\s*(.+)$/)
      if (headingMatch) {
        currentSection = this.cleanVerificationSummaryLine(headingMatch[1]).replace(/[：:]$/, '')
        continue
      }

      if (/^\|/.test(trimmed) || /^-{3,}$/.test(trimmed) || /^✅/.test(trimmed) || /^❌\s*\*{0,2}验证/.test(trimmed)) {
        continue
      }

      const cleaned = this.cleanVerificationSummaryLine(trimmed)
      if (!cleaned) continue

      const isStructuredProblem =
        /^(要求未满足|缺失内容|错误信息)[：:]/.test(cleaned) ||
        /^问题\s*\d+[：:]/i.test(cleaned)
      const isInterestingSectionLine = interestingSections.has(currentSection) && /^[-*]\s+/.test(trimmed)

      if (isStructuredProblem || isInterestingSectionLine) {
        highlights.push(cleaned)
      }
    }

    const unique = []
    const seen = new Set()
    for (const item of highlights) {
      const key = item.replace(/\s+/g, '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      unique.push(item)
      if (unique.length >= 6) break
    }

    if (unique.length > 0) {
      return unique.map(item => `- ${item}`).join('\n')
    }

    const fallback = []
    let afterFailureMarker = false
    for (const rawLine of lines) {
      const trimmed = rawLine.trim()
      if (/验证不通过|验证失败|failed/i.test(trimmed)) {
        afterFailureMarker = true
        continue
      }
      if (!afterFailureMarker) continue
      if (!trimmed || /^#{1,4}\s*/.test(trimmed) || /^\|/.test(trimmed) || /^-{3,}$/.test(trimmed)) continue

      const cleaned = this.cleanVerificationSummaryLine(trimmed)
      if (!cleaned) continue
      fallback.push(cleaned)
      if (fallback.length >= 5) break
    }

    return fallback.length > 0
      ? fallback.map(item => `- ${item}`).join('\n')
      : ''
  }

  async verifyTask(taskId, agent) {
    const task = db.getTaskById(taskId)
    if (!task) {
      console.log(`[Scheduler] Task ${taskId} not found for verification`)
      return
    }

    // 获取父任务上下文（如果有）
    let parentContext = ''
    if (task.parentTaskId) {
      const parent = db.getTaskById(task.parentTaskId)
      if (parent) {
        parentContext = `\n【父任务背景】\n标题: ${parent.title}\n描述: ${parent.description || '无'}\n分解说明: ${parent.decompositionNote || '无'}\n\n注意：当前验证对象是父任务拆出的单个子任务，只需要判断这个子任务自身要求是否完成；父任务整体效果会在全部子任务通过后再次统一验证。`
      }
    }

    // 获取历史输出作为验证依据
    const outputSummary = task.outputLines && task.outputLines.length > 0
      ? task.outputLines.map(l => l.content).join('\n').slice(-2000)
      : '无输出'
    const contractContext = this.buildContractContext(task)
    const dependencyArtifactContext = this.buildDependencyArtifactContext(task)
    const retainedWorkspacePath = task.workspace?.path && fs.existsSync(task.workspace.path)
      ? task.workspace.path
      : null
    const { spawn } = await import('child_process')
    const workspaceResult = retainedWorkspacePath
      ? { path: retainedWorkspacePath, exists: true }
      : await workspaceManager.createWorkspace(taskId, {})
    const workspacePath = workspaceResult.path
    const verificationStartedAt = new Date().toISOString()
    const artifactCheck = this.captureTaskArtifacts(taskId, workspacePath)
    let evidenceSummary = '【系统预采集证据】\n未识别到额外的页面/API/数据库证据。'

    db.updateTaskWorkspace(taskId, {
      path: path.resolve(workspacePath),
      status: 'verifying',
      retainedForQa: true,
      cleanedAt: null
    })

    try {
      const evidence = await collectVerificationEvidence(task, workspacePath, {
        artifactManifest: artifactCheck.manifest
      })
      evidenceSummary = evidence.summary || evidenceSummary
      db.addTaskLog(taskId, {
        agentId: agent.id,
        action: '验证证据',
        message: `系统已采集验证证据：${evidence.reportPath}`
      })
      db.appendTaskOutput(taskId, `[系统] QA 证据报告: ${evidence.reportPath}`)
      this.captureTaskArtifacts(taskId, workspacePath)
    } catch (error) {
      evidenceSummary = `【系统预采集证据】\n证据采集失败: ${error.message}`
      db.addTaskLog(taskId, {
        agentId: agent.id,
        action: '验证证据',
        message: `证据采集失败：${error.message}`
      })
    }

    // 构建验证 prompt - 让 QA agent 实际执行验证
    const verifyPrompt = `你是一个严格、怀疑型的 QA 评估器。你的任务是**实际验证**任务输出是否满足所有要求。

你不是执行 agent 的同伴评审，不能替它找借口。你的默认立场是：除非真实产物、命令结果或可观察行为证明完成，否则判为未完成。不要因为输出文字自称完成就通过。

【待验证任务】
标题: ${task.title}
描述/要求: ${task.description || '无'}
${contractContext}
${this.buildOperationFolderContext(task)}
${dependencyArtifactContext}
${parentContext}
${this.buildWorkspaceContext({ workspace: { path: path.resolve(workspacePath), status: 'verifying' } })}
${this.buildArtifactManifestContext({ artifactManifest: artifactCheck.manifest })}
${evidenceSummary}
${this.buildAgentInstructionFallback(agent, { heading: '【QA Agent 职责回放】' })}

【任务执行输出】
${outputSummary}
${this.buildAgentSkillContext(agent)}

请按以下步骤执行验证：
1. **逐条检查要求**：将"描述/要求"中的每一条具体要求列出来
2. **逐条检查冲刺契约**：如果存在验收标准/验证计划，必须逐条核对；任何硬性验收标准不满足都必须失败
3. **对照输出检查**：针对每条要求，检查输出中是否有对应的结果/内容
4. **实际执行验证**：如果任务要求生成文件/代码/页面/视频/API，检查文件是否存在并执行命令、访问页面、调用 API 或读取数据库
5. **评分并应用阈值**：按以下维度打 1-5 分，并解释扣分原因：
   - 功能完整性 functionality：低于 4 分失败
   - 真实产物 realArtifacts：低于 4 分失败
   - 可用性/产品深度 usability：低于 3 分失败
   - 视觉/体验设计 visualDesign（适用于前端/UI）：低于 3 分失败
   - 代码质量 codeQuality（适用于代码任务）：低于 3 分失败
6. **检查完整性**：输出是否涵盖了任务描述、冲刺契约和父任务背景中的所有关键点

重要判定规则：
- 只要有任一硬性验收标准未满足，必须输出验证不通过。
- 只要真实文件/目录/API/页面/视频不存在，不能因为 agent 文字声称完成而通过。
- 如果发现“看起来完成但核心功能只是占位/演示/空目录”，必须失败。
- 如果无法执行验证命令，要把无法验证的原因写入错误信息，不要默认为通过。

重要输出格式（必须严格遵守）：
- 通过时：输出"✅ 验证通过"，后面可跟简短说明
- 不通过时：必须输出"❌ 验证不通过，原因如下："，然后按以下格式列出每个问题：
  - 要求未满足: [具体要求描述] → 实际输出: [实际结果]
  - 缺失内容: [缺失的具体内容]
  - 错误信息: [发现的具体错误]
  - 评分: functionality=X/5, realArtifacts=X/5, usability=X/5, visualDesign=X/5, codeQuality=X/5

示例格式：
不通过，原因如下：
  - 要求未满足: "输出包含摘要" → 实际输出: 缺少摘要部分
  - 缺失内容: README.md 文件未生成
  - 错误信息: 运行 npm test 失败，返回码 1
  - 评分: functionality=2/5, realArtifacts=1/5, usability=3/5, visualDesign=不适用, codeQuality=2/5

注意：
- 不要因为输出日志较短就直接判失败，像“创建目录/写入文件/修改配置”这类任务本来就可能只有很短的执行输出。
- 如果任务要求的是文件、目录、页面或代码，请优先检查真实产物是否存在、内容是否符合要求，再下结论。

请实际执行验证，不要只读输出猜测。`

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--agent', this.getClaudeAgentName(agent),
      `--`, verifyPrompt
    ]

    const proc = spawn(CLAUDE_LAUNCH_SPEC.command, [...CLAUDE_LAUNCH_SPEC.prefixArgs, ...args], {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 清除 CLAUDECODE 环境变量，避免"nested session"错误
      env: { ...process.env, CLAUDECODE: undefined }
    })
    this.trackWorkspaceProcess(taskId, proc)

    let verifyOutput = ''
    let verifyErrorOutput = ''
    const streamState = {
      buffer: '',
      capturedText: ''
    }
    proc.stdout.on('data', (data) => {
      const currentActiveTask = this.activeTasks.get(taskId)
      if (!currentActiveTask) return

      this.handleStructuredStdoutChunk(taskId, currentActiveTask, data.toString(), streamState, {
        finalizeOptions: {
          persistMessage: false,
          persistOutput: true
        },
        onPlainText: (line) => {
          db.appendTaskOutput(taskId, line)
        }
      })
    })
    proc.stderr.on('data', (data) => {
      verifyErrorOutput += data.toString()
    })

    return new Promise((resolve) => {
      proc.on('close', async (code) => {
        const activeTask = this.activeTasks.get(taskId)
        if (activeTask) {
          this.flushStructuredStdoutBuffer(taskId, activeTask, streamState, {
            finalizeOptions: {
              persistMessage: false,
              persistOutput: true
            },
            onPlainText: (line) => {
              db.appendTaskOutput(taskId, line)
            }
          })
        }

        verifyOutput = streamState.capturedText.trim()
        const combinedVerificationOutput = `${verifyOutput}\n${verifyErrorOutput}`.trim()
        const verificationText = verifyOutput.trim() ? verifyOutput : combinedVerificationOutput
        const verificationInfraError = this.isTransientClaudeServiceError(combinedVerificationOutput)
        if (verificationInfraError) {
          const message = `QA 验证异常，保留待测试等待重试：${combinedVerificationOutput.slice(0, 500)}`
          db.addTaskLog(taskId, {
            agentId: agent.id,
            action: '验证异常',
            message
          })

          this.activeTasks.delete(taskId)
          db.updateTaskStatus(taskId, 'ReadyForTest')
          db.updateTaskWorkspace(taskId, {
            path: path.resolve(workspacePath),
            status: 'retained_for_qa',
            retainedForQa: true,
            lastVerifiedAt: verificationStartedAt
          })
          db.releaseAgent(agent.id, taskId)
          console.log(`[Scheduler] Verification infra error for task ${taskId}; kept in ReadyForTest`)
          this.scheduleNext()
          resolve()
          return
        }

        // 分析验证结果
        // 判断逻辑：分别统计通过/失败标记数量，以数量多者决定结果
        // 修复：不用简单的 hasPass && !hasFail，避免"没问题"等正常文本触发假阳性
        const outputLower = verificationText.toLowerCase()
        const passPatterns = ['验证通过', '验证成功', 'passed', 'pass', 'success', '通过验证', '测试通过']
        const failPatterns = ['验证不通过', '验证失败', 'failed', 'fail', '错误']

        // 统计每类标记出现次数（✅/❌ 单独统计，不受中文 pattern 影响）
        const emojiPassCount = (verificationText.match(/✅/g) || []).length
        const emojiFailCount = (verificationText.match(/❌/g) || []).length
        let passCount = emojiPassCount
        let failCount = emojiFailCount
        for (const p of passPatterns) passCount += (outputLower.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
        for (const p of failPatterns) failCount += (outputLower.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length

        const hasExplicitFail =
          /(?:❌|验证不通过|验证失败|不通过，原因|要求未满足|缺失内容|错误信息)/i.test(verificationText)
        const hasExplicitPass =
          /(?:✅\s*验证通过|验证通过|验证成功|测试通过)/i.test(verificationText)

        // 通过条件：必须有明确通过标记，且不能包含明确失败标记。
        // 避免清单里通过项很多、但仍有关键 ❌ 时被计数法误判为通过。
        const verificationPassed = hasExplicitPass && !hasExplicitFail

        // 添加详细日志
        console.log(`[Scheduler] Verification check - passCount:${passCount}, failCount:${failCount}, result:${verificationPassed}`)
        console.log(`[Scheduler] Verification output: ${verificationText.substring(0, 300)}`)

        // 额外保存验证输出到任务日志（用于调试）
        if (verificationText.trim()) {
          const trimmedVerifyOutput = verificationText.trim()
          const maxVerificationLogLength = 12000
          db.addTaskLog(taskId, {
            agentId: agent.id,
            action: '验证输出',
            message: trimmedVerifyOutput.length > maxVerificationLogLength
              ? `${trimmedVerifyOutput.slice(0, maxVerificationLogLength)}\n\n[系统] 验证输出过长，已截断。`
              : trimmedVerifyOutput
          })
        }

        // 添加验证日志
        const verificationResult = verificationPassed ? '通过' : '失败'
        let failReason = ''
        if (!verificationPassed) {
          // 如果验证输出为空或很短，说明验证 agent 没有正常工作
          if (!verificationText.trim() || verificationText.length < 50) {
            failReason = `验证 agent 无输出（输出长度: ${verificationText.length}字符），可能卡住或环境问题`
          } else {
            // 尝试提取失败原因 - 优先提取结构化的"问题X:"格式（每行一个）
            // 修复：用逐行解析代替带 g 标志的贪婪正则，避免 .+ 吃掉后续"问题X:"前缀导致只提取到最后一个问题
            const lines = verificationText.split('\n')
            const problemLines = lines.filter(l => /^问题\s*\d+[：:]/i.test(l.trim()))
            if (problemLines.length > 0) {
              failReason = problemLines
                .map(l => l.replace(/^问题\s*\d+[：:]\s*/i, '').trim())
                .filter(r => r.length > 0)
                .join('; ')
            } else {
              failReason = this.extractVerificationFailReason(verificationText)
            }

            // 如果还是提取不到，扫描原始输出找到有意义的内容行
            if (!failReason && verificationText.trim()) {
              const lines = verificationText.split('\n').filter(l => l.trim() && !l.includes('```') && l.length > 10)
              failReason = lines.slice(-6).join('; ').substring(0, 500)
            }
          }
        }

        db.addTaskLog(taskId, {
          agentId: agent.id,
          action: '验证',
          message: `QA 验证${verificationResult}${failReason ? ' - ' + failReason : ''}`
        })

        // 流转到相应状态
        const newStatus = verificationPassed ? 'Done' : 'InFix'
        let finalStatus = newStatus

        // 从活跃列表移除
        this.activeTasks.delete(taskId)

        // 更新任务状态
        if (newStatus === 'InFix') {
          // 验证失败：增加 loopCount，任务重新进入执行队列
          // 原来的逻辑：loopCount >= 3 后不再重试
          if (task.loopCount >= 3) {
            console.log(`[Scheduler] Task ${taskId} exceeded max loop count (${task.loopCount}), moving to Blocked`)
            db.updateTaskStatus(taskId, 'Blocked')
            finalStatus = 'Blocked'
            db.updateTaskWorkspace(taskId, {
              path: path.resolve(workspacePath),
              status: 'blocked',
              retainedForQa: false,
              lastVerifiedAt: verificationStartedAt
            })
            db.addTaskLog(taskId, {
              agentId: agent.id,
              action: '验证',
              message: `超过最大重试次数（${task.loopCount}），任务转为 Blocked，保留工作区等待人工处理`
            })
          } else {
            const bugResult = db.reportBug(taskId, `QA 验证失败：${failReason || '输出不符合要求。请检查任务输出是否完整、是否符合任务描述中的具体要求。'}`)
            finalStatus = bugResult?.task?.status || 'InFix'
            db.updateTaskWorkspace(taskId, {
              path: path.resolve(workspacePath),
              status: bugResult?.blocked ? 'blocked' : 'retained_for_fix',
              retainedForQa: false,
              lastVerifiedAt: verificationStartedAt
            })
          }
        } else {
          db.updateTaskStatus(taskId, newStatus)
          db.updateTaskWorkspace(taskId, {
            path: path.resolve(workspacePath),
            status: 'verified',
            retainedForQa: false,
            lastVerifiedAt: verificationStartedAt
          })
        }

        // 如果是子任务，检查父任务
        if (task.parentTaskId) {
          db.checkAndUpdateParentCompletion(taskId)
        }

        // 触发 Task Done hook（Wiki 生成、Skill 沉淀等）
        if (finalStatus === 'Done' && this.onTaskDone) {
          const updatedTask = db.getTaskById(taskId)
          this.onTaskDone(taskId, updatedTask, agent)
        }

        if (finalStatus === 'Done') {
          await this.cleanupTaskWorkspace(taskId)
        }

        console.log(`[Scheduler] Verification for task ${taskId}: ${verificationResult} -> ${finalStatus}`)

        // 触发下一个任务
        this.scheduleNext()
        resolve()
      })

      proc.on('error', async (error) => {
        console.error(`[Scheduler] Verification process error:`, error.message)
        // 验证失败，打回并增加 loopCount
        this.activeTasks.delete(taskId)
        const taskRef = db.getTaskById(taskId)
        if (taskRef && taskRef.loopCount >= 3) {
          console.log(`[Scheduler] Task ${taskId} exceeded max verification attempts, moving to Blocked`)
          db.updateTaskStatus(taskId, 'Blocked')
          db.updateTaskWorkspace(taskId, {
            path: path.resolve(workspacePath),
            status: 'blocked',
            retainedForQa: false,
            lastVerifiedAt: verificationStartedAt
          })
          db.addTaskLog(taskId, {
            agentId: agent.id,
            action: '验证',
            message: `超过最大验证次数，任务转为 Blocked，保留工作区等待人工处理`
          })
        } else {
          const bugResult = db.reportBug(taskId, `QA 验证进程错误: ${error.message}`)
          db.updateTaskWorkspace(taskId, {
            path: path.resolve(workspacePath),
            status: bugResult?.blocked ? 'blocked' : 'retained_for_fix',
            retainedForQa: false,
            lastVerifiedAt: verificationStartedAt
          })
        }
        db.releaseAgent(agent.id, taskId)
        this.scheduleNext()
        resolve()
      })
    })
  }

  /**
   * 检查任务状态变更
   */
  async checkTaskStateChanges() {
    for (const [taskId, activeTask] of this.activeTasks) {
      const currentTask = db.getTaskById(taskId)
      if (!currentTask) {
        // 任务被删除了
        console.log(`[Scheduler] Task ${taskId} was deleted`)
        await this.handleTaskTermination(taskId, 'deleted')
        continue
      }

      // 检查状态是否变成了终止状态
      const terminalStates = ['Done', 'Cancelled', 'Duplicate']
      if (terminalStates.includes(currentTask.status)) {
        console.log(`[Scheduler] Task ${taskId} moved to terminal state: ${currentTask.status}`)
        await this.handleTaskTermination(taskId, 'completed')
        continue
      }

      // 检查是否被分配给了别人
      if (currentTask.assignedAgentId !== activeTask.agent.id) {
        console.log(`[Scheduler] Task ${taskId} was reassigned`)
        await this.handleTaskTermination(taskId, 'reassigned')
        continue
      }
    }
  }

  /**
   * 处理任务终止
   */
  async handleTaskTermination(taskId, reason) {
    const activeTask = this.activeTasks.get(taskId)
    if (!activeTask) return

    try {
      if (activeTask.sessionMode === 'live') {
        await this.teardownLiveSession(taskId, reason === 'completed' ? 'session_closed' : 'user_stopped')
        return
      }

      if (activeTask.process && typeof activeTask.process.kill === 'function') {
        try {
          activeTask.process.kill('SIGTERM')
        } catch (error) {}
      }

      // 停止工作区进程
      await workspaceManager.stopProcess(taskId)

      // 清理工作区
      const workspaceConfig = workflowManager.getWorkspaceConfig()
      await workspaceManager.cleanupWorkspace(taskId, {
        beforeCleanup: workspaceConfig.hooks?.beforeCleanup
      })

      // 从活跃列表移除
      this.activeTasks.delete(taskId)

      console.log(`[Scheduler] Task ${taskId} terminated: ${reason}`)

      // 触发下一个任务
      this.scheduleNext()
    } catch (error) {
      console.error(`[Scheduler] Error handling termination for ${taskId}:`, error.message)
    }
  }

  /**
   * 获取调度器状态
   */
  getStatus() {
    return {
      running: this.running,
      maxConcurrentAgents: this.maxConcurrentAgents,
      activeCount: this.activeTasks.size,
      canAcceptTask: this.canAcceptTask(),
      activeTasks: Array.from(this.activeTasks.entries()).map(([id, info]) => ({
        taskId: id,
        taskTitle: info.task.title,
        agentName: info.agent.name,
        startedAt: info.startedAt,
        turns: info.turns,
        mode: info.sessionMode || 'batch',
        isResponding: Boolean(info.isResponding),
        currentTool: info.currentTool?.name || null,
        pendingAssistantText: String(info.pendingAssistantText || '').trim().slice(0, 120) || null
      })),
      queueLength: this.taskQueue.length
    }
  }

  /**
   * 清理孤儿任务（assignedAgentId 有值但不在 activeTasks 中）
   */
  cleanupOrphanedTasks() {
    const board = db.getBoard()
    const allStatuses = ['Analyzing', 'InDev', 'ReadyForTest', 'ReadyForDeploy', 'InFix']
    let cleaned = 0

    for (const status of allStatuses) {
      const tasks = board[status] || []
      for (const task of tasks) {
        if (task.assignedAgentId && !this.activeTasks.has(task.id)) {
          console.log(`[Scheduler] Cleaning orphaned task ${task.id} (status=${status}, assigned=${task.assignedAgentId})`)
          task.assignedAgentId = null
          cleaned++
        }
      }
    }

    if (cleaned > 0) {
      db.save()
      console.log(`[Scheduler] Cleaned ${cleaned} orphaned tasks`)
    }
  }

  /**
   * 启动调度器
   */
  start() {
    if (this.running) {
      console.log('[Scheduler] Already running')
      return
    }

    // 先清理孤儿任务
    this.cleanupOrphanedTasks()

    this.running = true
    console.log('[Scheduler] Enhanced scheduler started')

    // 启动轮询
    this.pollTimer = setInterval(() => this.tick(), this.pollInterval)

    // 立即执行一次
    this.tick()
  }

  /**
   * 停止调度器
   */
  stop() {
    if (!this.running) {
      return
    }

    this.running = false
    this.isScheduling = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // 清理所有活跃任务
    for (const taskId of this.activeTasks.keys()) {
      this.handleTaskTermination(taskId, 'scheduler_stopped')
    }

    console.log('[Scheduler] Enhanced scheduler stopped')
  }

  /**
   * 轮询执行
   */
  async tick() {
    if (!this.running) return

    try {
      // 检查任务状态变更
      await this.checkTaskStateChanges()

      // 尝试调度新任务
      await this.scheduleNext()
    } catch (error) {
      console.error('[Scheduler] Tick error:', error.message)
    }
  }
}

// 导出单例
export const enhancedScheduler = new EnhancedScheduler()

export default enhancedScheduler
