/**
 * Skill 执行追踪 Hook 模块
 *
 * Hook 在每次 Skill 执行完成后记录执行数据：
 * - skill_name: 执行的 skill 名称
 * - session_id: 会话 ID（live session 有，batch 为 null）
 * - duration_ms: 执行耗时（毫秒）
 * - outcome: success | fail
 * - iteration_count: 迭代次数（turns）
 *
 * 数据追加写入 .omc/skills/self-optimization/tracking/raw_executions.jsonl
 * 支持断点续传（追加模式，不覆盖已有数据）
 */

import * as fs from 'fs'
import * as path from 'path'

// Skill tool name in Claude Code event stream
const SKILL_TOOL_NAME = 'Skill'

// 追踪数据写入路径（相对于项目根目录）
const RAW_EXECUTION_FILE = '.omc/skills/self-optimization/tracking/raw_executions.jsonl'

// 文件锁目录（防止并发写冲突）
const LOCK_DIR = '.omc/skills/self-optimization/tracking/.locks'

// 每个 session 的 Skill 执行开始记录: sessionId -> Map<skillName, { startedAt }>
const inFlightExecutions = new Map()

/**
 * 初始化 Skill 追踪 Hooks
 * @param {EnhancedScheduler} scheduler - 调度器实例
 */
export function initSkillTrackingHooks(scheduler) {
  // PostToolUse: 每次 Skill tool 执行完成后触发
  scheduler.onToolUse = async (taskId, activeTask, toolEvent) => {
    if (toolEvent?.type === 'tool_result') {
      await handleToolResult(taskId, activeTask, toolEvent)
      return
    }

    await handleToolUse(taskId, activeTask, toolEvent)
  }

  // Stop: 会话结束时触发
  scheduler.onStop = async (taskId, activeTask, reason) => {
    await handleStop(taskId, activeTask, reason)
  }

  console.log('[SkillTrackingHooks] Initialized')
}

/**
 * PostToolUse Hook: 处理 tool_use 事件
 */
async function handleToolUse(taskId, activeTask, toolEvent) {
  try {
    const toolName = toolEvent?.tool || toolEvent?.name || ''
    if (toolName !== SKILL_TOOL_NAME) return

    const args = toolEvent?.input || toolEvent?.args || {}
    const skillName = extractSkillName(args)

    if (!skillName) return

    const sessionId = activeTask?.liveSessionId || null
    const startedAt = Date.now()

    // 记录执行开始
    if (!inFlightExecutions.has(sessionId)) {
      inFlightExecutions.set(sessionId, new Map())
    }
    inFlightExecutions.get(sessionId).set(skillName, { startedAt, taskId })
  } catch (e) {
    console.error('[SkillTrackingHooks] handleToolUse error:', e.message)
  }
}

/**
 * 从 tool 输入参数中提取 skill 名称
 * 支持多种参数格式: { skill }, { skill_name }, { name }, { skillName }
 */
function extractSkillName(args) {
  if (!args || typeof args !== 'object') return null
  return args.skill || args.skill_name || args.name || args.skillName || null
}

/**
 * PostToolUse Hook (result 版本): tool 执行结果返回时触发
 * 当 Skill tool 的结果返回时，计算耗时并写入记录
 */
async function handleToolResult(taskId, activeTask, toolResult) {
  try {
    const toolName = toolResult?.tool || toolResult?.name || ''
    if (toolName !== SKILL_TOOL_NAME) return

    const args = toolResult?.input || toolResult?.args || {}
    let skillName = extractSkillName(args)

    const sessionId = activeTask?.liveSessionId || null
    const executions = inFlightExecutions.get(sessionId)
    if (!skillName && executions?.size === 1) {
      skillName = Array.from(executions.keys())[0]
    }

    if (!skillName) return

    const record = executions?.get(skillName)

    const durationMs = record
      ? Date.now() - record.startedAt
      : 0

    const outcome = resolveOutcome(toolResult)
    const iterationCount = activeTask?.turns || 0

    const executionRecord = {
      skill_name: skillName,
      session_id: sessionId,
      duration_ms: durationMs,
      outcome,
      iteration_count: iterationCount,
      recorded_at: new Date().toISOString(),
      task_id: taskId || null
    }

    await appendExecutionRecord(executionRecord)

    // 清理记录
    if (executions) {
      executions.delete(skillName)
      if (executions.size === 0) {
        inFlightExecutions.delete(sessionId)
      }
    }
  } catch (e) {
    console.error('[SkillTrackingHooks] handleToolResult error:', e.message)
  }
}

/**
 * Stop Hook: 会话结束时触发
 * 清理未完成的 in-flight 执行记录（如果 tool_use 和 result 之间 session 结束）
 */
async function handleStop(taskId, activeTask, reason) {
  try {
    const sessionId = activeTask?.liveSessionId || null

    // 清理 session 相关的 in-flight 记录
    if (sessionId && inFlightExecutions.has(sessionId)) {
      const executions = inFlightExecutions.get(sessionId)
      for (const [skillName, record] of executions) {
        const durationMs = Date.now() - record.startedAt
        const outcome = reason === 'session_closed' ? 'success' : 'fail'
        const iterationCount = activeTask?.turns || 0

        const executionRecord = {
          skill_name: skillName,
          session_id: sessionId,
          duration_ms: durationMs,
          outcome,
          iteration_count: iterationCount,
          recorded_at: new Date().toISOString(),
          task_id: taskId || null,
          reason: `stop_hook:${reason}`
        }

        await appendExecutionRecord(executionRecord)
      }
      inFlightExecutions.delete(sessionId)
    }
  } catch (e) {
    console.error('[SkillTrackingHooks] handleStop error:', e.message)
  }
}

/**
 * 从 tool result 中判断 outcome
 */
function resolveOutcome(toolResult) {
  if (!toolResult) return 'fail'

  const content = toolResult?.result || toolResult?.output || toolResult?.content || ''

  // 检查错误标记
  if (
    toolResult?.error ||
    String(content).toLowerCase().includes('"error"') ||
    String(content).toLowerCase().includes('error:') ||
    String(content).toLowerCase().includes('failed')
  ) {
    return 'fail'
  }

  return 'success'
}

/**
 * 追加执行记录到 JSONL 文件（支持断点续传）
 * 使用文件锁防止并发写入冲突
 */
async function appendExecutionRecord(record) {
  const baseDir = path.dirname(RAW_EXECUTION_FILE)
  const lockDir = LOCK_DIR
  const lockFile = path.join(lockDir, 'write.lock')
  const jsonlPath = RAW_EXECUTION_FILE

  // 同步创建目录（如果不存在）
  try {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.mkdirSync(lockDir, { recursive: true })
  } catch (e) {
    // 忽略已存在的错误
  }

  const line = JSON.stringify(record) + '\n'

  // 简单文件锁：重试直到获得锁
  const maxRetries = 10
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 尝试获取锁
      if (attempt === 0 && !fs.existsSync(lockFile)) {
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
      } else {
        await sleep(50)
        if (fs.existsSync(lockFile)) {
          // 锁被其他进程持有，等待
          continue
        }
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
      }

      // 追加写入
      fs.appendFileSync(jsonlPath, line, { encoding: 'utf-8' })

      // 释放锁
      try { fs.unlinkSync(lockFile) } catch (_) {}

      return
    } catch (e) {
      if (e.code === 'EEXIST') {
        // 锁被占用，等待后重试
        await sleep(50)
        continue
      }
      if (e.code === 'ENOENT') {
        // 文件不存在（目录也不存在），先创建
        try {
          fs.mkdirSync(baseDir, { recursive: true })
          fs.mkdirSync(lockDir, { recursive: true })
        } catch (_) {}
        await sleep(50)
        continue
      }
      // 其他错误：记录但不阻塞
      console.error('[SkillTrackingHooks] append error:', e.message)
      return
    }
  }

  // 重试耗尽，输出错误但不阻塞主流程
  console.error('[SkillTrackingHooks] Failed to acquire lock after retries, record dropped')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { appendExecutionRecord }
export default { initSkillTrackingHooks, appendExecutionRecord }
