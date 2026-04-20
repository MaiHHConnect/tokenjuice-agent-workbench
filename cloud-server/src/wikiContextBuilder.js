const DECISION_KEYWORDS = ['决定', '改为', '采用', '选择', '统一', '同步', '恢复', '自动', '拆分', '分解', '方案', '为了', '由于', '因此', '优先', '兜底']
const ISSUE_KEYWORDS = ['失败', '错误', '阻塞', '缺少', '缺失', '无法', '不通过', 'bug', '问题', '异常', '重试', '修复']
const EXECUTION_KEYWORDS = ['创建', '生成', '写入', '更新', '修改', '保存', '完成', '通过', '验证', '测试', '运行', '执行', '已就绪', '路径', '目录', '文件']
const VERIFICATION_KEYWORDS = ['验证', '验收', 'QA', 'PASS', 'FAIL', '通过', '不通过', '测试通过', '验证通过', '验证失败']
const NOISE_PATTERNS = [
  /^✓\s*Agent\s*\[/i,
  /^Agent\s*\[.+\]\s*执行完成/i,
  /^已连接.+现在可以直接持续对话/,
  /^继续和当前 Agent 实时对话/,
  /^Agent 正在回复/,
  /^--- Planner 分析完成/,
  /^```(?:json|html|javascript|js|css|md)?\b/i,
  /^[{}\[\]",:\s]+$/,
  /^按新流程回退到待测试/,
  /^应用第.+轮修复/,
  /^#+\s*/,
  /^\*{0,2}第[一二三四五六七八九十0-9]+个?问题[:：]?\*{0,2}$/,
  /^###\s*/,
  /^##\s*/
]

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shorten(text, maxLength = 280) {
  const cleaned = cleanText(text)
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 1)}…`
}

function normalizeKey(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[0-9]{1,4}[/-][0-9]{1,2}[/-][0-9]{1,4}/g, '')
    .replace(/[^\p{L}\p{N}/._-]+/gu, '')
}

function isNoise(text) {
  const cleaned = cleanText(text)
  if (!cleaned) return true
  return NOISE_PATTERNS.some(pattern => pattern.test(cleaned))
}

function dedupeTexts(texts, { maxItems = 12, maxTotalChars = 2200 } = {}) {
  const result = []
  const seen = new Set()
  let totalChars = 0

  for (const rawText of texts) {
    const cleaned = shorten(rawText)
    if (!cleaned || isNoise(cleaned)) continue

    const key = normalizeKey(cleaned)
    if (!key || seen.has(key)) continue

    if (result.length >= maxItems) break
    if (totalChars + cleaned.length > maxTotalChars && result.length > 0) break

    seen.add(key)
    result.push(cleaned)
    totalChars += cleaned.length
  }

  return result
}

function containsKeyword(text, keywords) {
  const cleaned = cleanText(text)
  return keywords.some(keyword => cleaned.includes(keyword))
}

function isPositiveOutcome(text) {
  const cleaned = cleanText(text)
  if (!cleaned) return false
  const hasPositive = ['通过', '满足', '已修复', '已完成', '齐全', '成功'].some(keyword => cleaned.includes(keyword))
  const hasNegative = ['不通过', '失败', '错误', '异常', '问题', '缺失', '缺少', '阻塞'].some(keyword => cleaned.includes(keyword))
  return hasPositive && !hasNegative
}

function splitSections(text) {
  const cleaned = String(text || '')
  if (!cleaned.trim()) return {}

  const sections = {}
  const parts = cleaned.split(/(?=【[^】]+】)/g)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^【([^】]+)】\s*([\s\S]*)$/)
    if (match) {
      sections[match[1]] = cleanText(match[2])
    } else if (!sections.default) {
      sections.default = cleanText(trimmed)
    }
  }

  return sections
}

function extractArtifactPaths(text) {
  const cleaned = String(text || '')
  const matches = [
    ...(cleaned.match(/(?:~\/|\/Users\/)[^\s"'`，。；；、)]+/g) || []),
    ...(cleaned.match(/\b[\w./-]+\.(?:html|md|txt|json|js|ts|tsx|jsx|css|png|jpg|jpeg|svg)\b/g) || [])
  ]

  return dedupeTexts(matches, { maxItems: 12, maxTotalChars: 1200 })
}

function extractMeaningfulLogLines(message) {
  return String(message || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => cleanText(line))
    .filter(line => {
      if (!line || isNoise(line)) return false
      if (/^\|.*\|$/.test(line)) return false
      if (/^[-=:]{3,}$/.test(line)) return false
      if (/^`{3,}/.test(line)) return false
      if (/^\*{1,2}[^*]+[:：]\*{1,2}$/.test(line)) return false
      return true
    })
}

function formatLogLine(action, content) {
  const cleanedAction = cleanText(action)
  const cleanedContent = cleanText(content)
  if (!cleanedContent) return ''
  return cleanedAction ? `[${cleanedAction}] ${cleanedContent}` : cleanedContent
}

function collectTaskLogInsights(log) {
  const requirements = []
  const decisions = []
  const issues = []
  const execution = []
  const verifications = []
  const artifacts = []
  const action = cleanText(log?.action)
  const lines = extractMeaningfulLogLines(log?.message)

  if (action === '需要补充信息' && lines[0]) {
    requirements.push(formatLogLine(action, lines[0]))
  }
  if (action === '任务分解' && lines[0]) {
    decisions.push(formatLogLine(action, lines[0]))
  }
  if (['开发完成', '任务完成', '实时会话开始', '实时会话结束', '实时对话'].includes(action) && lines[0]) {
    execution.push(formatLogLine(action, lines[0]))
  }
  if (action.includes('验证') && lines[0]) {
    verifications.push(formatLogLine(action, lines[0]))
  }

  for (const line of lines.slice(0, 8)) {
    const withAction = formatLogLine(action, line)
    if (!withAction) continue

    if (containsKeyword(line, DECISION_KEYWORDS)) decisions.push(withAction)
    if (containsKeyword(line, ISSUE_KEYWORDS) && !isPositiveOutcome(line)) issues.push(withAction)
    if (containsKeyword(line, EXECUTION_KEYWORDS) || extractArtifactPaths(line).length > 0) {
      execution.push(withAction)
    }
    const looksLikeVerificationDetail =
      containsKeyword(line, VERIFICATION_KEYWORDS) ||
      /^[-*]\s*[✅❌]/.test(line) ||
      /^问题\s*\d+[：:]/i.test(line) ||
      extractArtifactPaths(line).length > 0

    if ((action.includes('验证') && looksLikeVerificationDetail) || containsKeyword(line, VERIFICATION_KEYWORDS)) {
      verifications.push(withAction)
    }

    artifacts.push(...extractArtifactPaths(line))
  }

  return {
    requirements,
    decisions,
    issues,
    execution,
    verifications,
    artifacts
  }
}

function buildTaskSummary(task, label, getTaskLogs = () => []) {
  const sections = splitSections(task.description || '')
  const messages = Array.isArray(task.messages) ? task.messages : []
  const outputLines = Array.isArray(task.outputLines) ? task.outputLines : []
  const rawLogs = getTaskLogs(task.id)
  const taskLogs = Array.isArray(rawLogs) ? rawLogs : []

  const requirements = []
  const decisions = []
  const issues = []
  const execution = []
  const verifications = []
  const artifacts = []

  if (sections.default) {
    requirements.push(sections.default)
    if (containsKeyword(sections.default, DECISION_KEYWORDS)) decisions.push(sections.default)
  }
  if (sections['原始任务要求']) requirements.push(sections['原始任务要求'])
  if (sections['父任务背景']) decisions.push(sections['父任务背景'])
  if (sections['QA 验证失败']) issues.push(sections['QA 验证失败'])
  if (task.decompositionNote) decisions.push(task.decompositionNote)
  if (task.bugReport) issues.push(task.bugReport)

  for (const message of messages) {
    const content = cleanText(message.content)
    if (!content || isNoise(content)) continue

    if (message.role === 'user' || message.kind === 'user') {
      requirements.push(content)
    } else {
      if (containsKeyword(content, DECISION_KEYWORDS)) decisions.push(content)
      if (containsKeyword(content, ISSUE_KEYWORDS)) issues.push(content)
      if (containsKeyword(content, EXECUTION_KEYWORDS)) execution.push(content)
    }

    artifacts.push(...extractArtifactPaths(content))
  }

  for (const line of outputLines) {
    const content = cleanText(line.content)
    if (!content || isNoise(content)) continue

    if (content.startsWith('[用户消息]')) {
      requirements.push(content.replace(/^\[用户消息\]\s*/, ''))
      continue
    }

    if (containsKeyword(content, ISSUE_KEYWORDS) && !isPositiveOutcome(content)) issues.push(content)
    if (containsKeyword(content, DECISION_KEYWORDS)) decisions.push(content)
    if (containsKeyword(content, EXECUTION_KEYWORDS) || extractArtifactPaths(content).length > 0) {
      execution.push(content)
    }

    artifacts.push(...extractArtifactPaths(content))
  }

  for (const log of taskLogs) {
    const insights = collectTaskLogInsights(log)
    requirements.push(...insights.requirements)
    decisions.push(...insights.decisions)
    issues.push(...insights.issues)
    execution.push(...insights.execution)
    verifications.push(...insights.verifications)
    artifacts.push(...insights.artifacts)
  }

  return {
    id: task.id,
    label,
    title: task.title,
    status: task.status,
    messageCount: messages.length,
    outputCount: outputLines.length,
    logCount: taskLogs.length,
    requirements: dedupeTexts(requirements, { maxItems: 6, maxTotalChars: 900 }),
    decisions: dedupeTexts(decisions, { maxItems: 5, maxTotalChars: 900 }),
    issues: dedupeTexts(issues, { maxItems: 5, maxTotalChars: 900 }),
    execution: dedupeTexts(execution, { maxItems: 8, maxTotalChars: 1200 }),
    verifications: dedupeTexts(verifications, { maxItems: 6, maxTotalChars: 1200 }),
    artifacts: dedupeTexts(artifacts, { maxItems: 8, maxTotalChars: 600 })
  }
}

export function buildWikiContext(parentTask, getTaskById, getTaskLogs = () => []) {
  const subTasks = (parentTask.subTaskIds || [])
    .map(id => getTaskById(id))
    .filter(Boolean)

  const parentSummary = buildTaskSummary(parentTask, 'parent', getTaskLogs)
  const subTaskSummaries = subTasks.map(task => buildTaskSummary(task, 'subtask', getTaskLogs))
  const allSummaries = [parentSummary, ...subTaskSummaries]

  const requirementHighlights = dedupeTexts(allSummaries.flatMap(item => item.requirements))
  const decisionHighlights = dedupeTexts(allSummaries.flatMap(item => item.decisions))
  const issueHighlights = dedupeTexts(allSummaries.flatMap(item => item.issues))
  const executionHighlights = dedupeTexts(allSummaries.flatMap(item => item.execution), { maxItems: 16, maxTotalChars: 2600 })
  const verificationHighlights = dedupeTexts(allSummaries.flatMap(item => item.verifications), { maxItems: 10, maxTotalChars: 1800 })
  const artifactPaths = dedupeTexts(allSummaries.flatMap(item => item.artifacts), { maxItems: 16, maxTotalChars: 1200 })

  const sourceSummary = {
    taskCount: allSummaries.length,
    subTaskCount: subTaskSummaries.length,
    messageCount: allSummaries.reduce((sum, item) => sum + item.messageCount, 0),
    outputLineCount: allSummaries.reduce((sum, item) => sum + item.outputCount, 0),
    taskLogCount: allSummaries.reduce((sum, item) => sum + item.logCount, 0),
    requirementCount: requirementHighlights.length,
    decisionCount: decisionHighlights.length,
    issueCount: issueHighlights.length,
    verificationCount: verificationHighlights.length,
    artifactCount: artifactPaths.length
  }

  return {
    parentTask: {
      id: parentTask.id,
      title: parentTask.title,
      description: shorten(parentTask.description, 600),
      decompositionNote: shorten(parentTask.decompositionNote, 600)
    },
    subTasks: subTaskSummaries.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      requirements: item.requirements,
      execution: item.execution,
      issues: item.issues,
      verifications: item.verifications,
      artifacts: item.artifacts
    })),
    requirementHighlights,
    decisionHighlights,
    issueHighlights,
    executionHighlights,
    verificationHighlights,
    artifactPaths,
    generatedFromTaskIds: allSummaries.map(item => item.id),
    sourceSummary
  }
}
