import * as fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { createHash } from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', 'project-knowledge')
const CLAUDE_CLI_PATH = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'
const KNOWN_KNOWLEDGE_TYPES = ['concepts', 'topics', 'runbooks']
const CONFLICT_KEYWORDS = ['矛盾', '冲突', '不一致', '不可同时为真', '互相矛盾', '冲突定义']

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function cleanInlineText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(value, maxLength = 12000) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n\n[... 内容已截断 ...]`
}

function extractConflictNotes(texts = [], maxItems = 6) {
  const lines = []

  for (const rawText of texts) {
    const rawLines = String(rawText || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => cleanInlineText(line))
      .filter(Boolean)

    for (const line of rawLines) {
      if (CONFLICT_KEYWORDS.some(keyword => line.includes(keyword))) {
        lines.push(line)
      }
    }
  }

  return dedupeTexts(lines).slice(0, maxItems)
}

function clampConfidence(value) {
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return 0.5
  return Math.min(0.99, Math.max(0.3, Math.round(numeric * 100) / 100))
}

function inferConfidence(type, { evidenceCount = 0, conflictCount = 0, missingCoreFields = 0 } = {}) {
  const baseByType = {
    raw: 0.99,
    'task-wiki': 0.82,
    concepts: 0.84,
    topics: 0.81,
    runbooks: 0.86
  }

  let score = baseByType[type] ?? 0.78

  if (evidenceCount >= 3) score += 0.04
  else if (evidenceCount === 0) score -= 0.08

  if (conflictCount > 0) score -= Math.min(0.18, 0.08 + conflictCount * 0.03)
  if (missingCoreFields > 0) score -= Math.min(0.12, missingCoreFields * 0.04)

  return clampConfidence(score)
}

function yamlQuote(value) {
  return `"${cleanInlineText(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function renderYamlList(key, items = []) {
  const list = items
    .map(item => cleanInlineText(item))
    .filter(Boolean)

  if (list.length === 0) {
    return `${key}: []`
  }

  return [
    `${key}:`,
    ...list.map(item => `  - ${yamlQuote(item)}`)
  ].join('\n')
}

function renderBulletSection(title, items = [], emptyText = '无') {
  const list = items
    .map(item => cleanInlineText(item))
    .filter(Boolean)

  return [
    `## ${title}`,
    '',
    ...(list.length > 0 ? list.map(item => `- ${item}`) : [`- ${emptyText}`]),
    ''
  ].join('\n')
}

function dedupeTexts(items = []) {
  const result = []
  const seen = new Set()

  for (const rawItem of items) {
    const normalized = cleanInlineText(rawItem)
    if (!normalized) continue

    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }

  return result
}

function slugify(value, fallback = 'untitled') {
  const slug = cleanInlineText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return slug || fallback
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/')
}

function formatDateParts(rawValue) {
  const date = rawValue ? new Date(rawValue) : new Date()
  const resolved = Number.isNaN(date.getTime()) ? new Date() : date
  const year = String(resolved.getFullYear())
  const month = String(resolved.getMonth() + 1).padStart(2, '0')
  const day = String(resolved.getDate()).padStart(2, '0')
  const hours = String(resolved.getHours()).padStart(2, '0')
  const minutes = String(resolved.getMinutes()).padStart(2, '0')

  return {
    year,
    month,
    day,
    isoDate: `${year}-${month}-${day}`,
    isoMinute: `${year}-${month}-${day} ${hours}:${minutes}`,
    isoTimestamp: resolved.toISOString()
  }
}

function stripFrontmatter(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
}

function normalizeSemanticText(value) {
  return stripFrontmatter(value)
    .split('\n')
    .map(line => cleanInlineText(line))
    .filter(Boolean)
    .join('\n')
}

function computeSemanticHash(value) {
  return createHash('sha256')
    .update(normalizeSemanticText(value))
    .digest('hex')
}

function computeSourceHashFromEntries(entries = []) {
  const normalized = entries
    .map((entry, index) => {
      const label = cleanInlineText(entry?.label || `source-${index + 1}`)
      return `${label}:${computeSemanticHash(entry?.content || '')}`
    })
    .join('\n')

  return createHash('sha256')
    .update(normalized)
    .digest('hex')
}

function extractJsonObject(rawText) {
  const content = String(rawText || '').trim()
  if (!content) {
    throw new Error('Empty LLM response')
  }

  try {
    return JSON.parse(content)
  } catch (error) {
    const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i)
    if (fencedMatch) {
      return JSON.parse(fencedMatch[1].trim())
    }

    const firstBrace = content.indexOf('{')
    const lastBrace = content.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1))
    }

    throw error
  }
}

async function callClaudeWriter(prompt, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--agent', 'writer',
      '--', prompt
    ]

    const spawnEnv = { ...process.env, CLAUDECODE: '' }
    const proc = spawn('node', [CLAUDE_CLI_PATH, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv
    })

    let output = ''
    let stderr = ''
    let finished = false
    let timer = null

    const finish = (handler) => (value) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      handler(value)
    }

    const resolveOnce = finish(resolve)
    const rejectOnce = finish(reject)

    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolveOnce(output)
      } else {
        rejectOnce(new Error(`Claude writer failed with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
      }
    })

    proc.on('error', (error) => {
      rejectOnce(error)
    })

    timer = setTimeout(() => {
      proc.kill()
      rejectOnce(new Error('Claude writer timeout'))
    }, timeoutMs)
  })
}

async function requestStructuredJson(prompt, repairLabel = 'structured-json') {
  const firstResponse = await callClaudeWriter(prompt)

  try {
    return extractJsonObject(firstResponse)
  } catch (firstError) {
    const repairPrompt = `你上一次没有按要求返回合法 JSON。请把下面内容整理成合法 JSON，并且只输出 JSON，不要加任何解释、标题或 Markdown。

目标标签：${repairLabel}

【原始输出】
${truncateText(firstResponse, 12000)}`

    const repairedResponse = await callClaudeWriter(repairPrompt, 90000)
    return extractJsonObject(repairedResponse)
  }
}

function normalizeArray(values = []) {
  return Array.isArray(values)
    ? values.map(item => cleanInlineText(item)).filter(Boolean)
    : []
}

function readMarkdownTitle(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const titleMatch = content.match(/^title:\s*"([^"]+)"/m)
  if (titleMatch) return titleMatch[1]

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return cleanInlineText(headingMatch[1])

  return path.basename(filePath, path.extname(filePath))
}

function walkMarkdownFiles(rootDir, excludeNames = new Set()) {
  if (!fs.existsSync(rootDir)) return []

  const entries = []

  for (const name of fs.readdirSync(rootDir)) {
    if (excludeNames.has(name)) continue

    const fullPath = path.join(rootDir, name)
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      entries.push(...walkMarkdownFiles(fullPath, excludeNames))
      continue
    }

    if (stat.isFile() && name.endsWith('.md')) {
      entries.push(fullPath)
    }
  }

  return entries
}

class KnowledgeBaseManager {
  constructor(options = {}) {
    this.root = options.root || process.env.OMC_KNOWLEDGE_ROOT || DEFAULT_ROOT
  }

  getRoot() {
    return this.root
  }

  getPaths() {
    const root = this.root
    return {
      root,
      rawExternal: path.join(root, 'raw', 'external'),
      rawTasks: path.join(root, 'raw', 'tasks'),
      rawConfigs: path.join(root, 'raw', 'configs'),
      knowledge: path.join(root, 'knowledge'),
      knowledgeConcepts: path.join(root, 'knowledge', 'concepts'),
      knowledgeTopics: path.join(root, 'knowledge', 'topics'),
      knowledgeRunbooks: path.join(root, 'knowledge', 'runbooks'),
      knowledgeTaskWiki: path.join(root, 'knowledge', 'task-wiki'),
      knowledgeIndex: path.join(root, 'knowledge', 'index.md'),
      knowledgeLog: path.join(root, 'knowledge', 'log.md'),
      outputsMemo: path.join(root, 'outputs', 'memo'),
      outputsCards: path.join(root, 'outputs', 'cards'),
      outputsDiagrams: path.join(root, 'outputs', 'diagrams'),
      outputsReadme: path.join(root, 'outputs', 'README.md'),
      inspection: path.join(root, 'inspection'),
      inspectionReadme: path.join(root, 'inspection', 'README.md'),
      agentsFile: path.join(root, 'AGENTS.md'),
      claudeFile: path.join(root, 'CLAUDE.md')
    }
  }

  ensureStructure() {
    const paths = this.getPaths()

    for (const dirPath of [
      paths.rawExternal,
      paths.rawTasks,
      paths.rawConfigs,
      paths.knowledgeConcepts,
      paths.knowledgeTopics,
      paths.knowledgeRunbooks,
      paths.knowledgeTaskWiki,
      paths.outputsMemo,
      paths.outputsCards,
      paths.outputsDiagrams,
      paths.inspection
    ]) {
      ensureDir(dirPath)
    }

    this.ensureSeedFiles(paths)
    this.updateIndex()
    return paths
  }

  ensureSeedFiles(paths) {
    const seedFiles = [
      {
        filePath: paths.agentsFile,
        content: `# AGENTS.md

你不是一次性的内容生成器。
你是这个项目知识系统的维护者。

## 目标

1. 优先读取现有知识文件，不要凭空重写结论。
2. 让任务经验、外部资料、QA 证据和产物都落为普通文件。
3. 让未来任务可以复用今天沉淀下来的判断、路径、修复和验证方法。

## 工作规则

1. 保持文件优先。高价值信息必须写入 \`project-knowledge/\`。
2. 保持增量更新。优先处理新增材料，不要全量重建。
3. 保持可追溯。任何结论都尽量指向原始任务、原始材料或验证证据。
4. 不要静默覆盖冲突信息。发现冲突时显式记录差异。
5. 优先复用已有 \`concepts/\`、\`topics/\`、\`runbooks/\`，必要时再新建。

## 目录约定

- \`raw/\`：原始材料层。保留完整任务上下文、外部资料、配置快照。
- \`knowledge/task-wiki/\`：任务级复盘 Wiki 的文件导出层。
- \`knowledge/topics/\`：主题页，组织多个任务和多个来源的长期知识。
- \`knowledge/concepts/\`：概念卡，解释稳定术语和系统机制。
- \`knowledge/runbooks/\`：操作手册，解决故障、排查问题、执行固定流程。
- \`outputs/\`：对外产物，例如 memo、卡片、图示。
- \`inspection/\`：巡检报告和修复建议。

## 写作要求

1. 用中文写作，句子简洁，可扫描。
2. 先写结论，再写依据。
3. 路径、命令、接口、任务号等信息保持精确。
4. 任务复盘不要直接冒充长期知识；长期知识要经过整理后再进入 \`concepts/\`、\`topics/\` 或 \`runbooks/\`。
`
      },
      {
        filePath: paths.claudeFile,
        content: `# CLAUDE.md

你是这个知识系统的维护者，不是一次性的聊天生成器。

## 工作流

1. 摄取：把原始内容落成文件，优先保留原文和来源，不要过早总结。
2. 消化：把 task-wiki 或 raw 编译为 concepts / topics / runbooks。
3. 输出：基于知识文件生成 memo、cards、diagrams 等产物。
4. 巡检：检查 stale、重复概念、缺来源、矛盾定义、孤岛页面。

## Frontmatter Schema

所有 \`knowledge/\` 下的概念、主题、runbook 都应尽量包含：

- \`id\`
- \`title\`
- \`type\`
- \`created_at\`
- \`updated_at\`
- \`confidence\`
- \`last_ingested\`
- \`stale\`
- \`source_hash\`
- \`sources\`

\`task-wiki\` 和 \`raw\` 也应尽量包含：

- \`confidence\`
- \`last_ingested\`
- \`stale\`
- \`source_hash\`（task-wiki 建议包含）

## 规则

1. 所有结论尽量引用 \`sources\`。
2. 发现冲突时不要静默覆盖，必须写入 \`## 矛盾注记\`。
3. 发现冲突时降低 \`confidence\`。
4. 如果来源文件的语义 hash 发生变化，但知识文件尚未重新编译，必须标记 \`stale: true\`。
5. 一份来源应尽可能扩散为多个可复用页面，而不是只停留在一篇摘要。

## 巡检重点

1. \`stale\` 是否为 true
2. 是否缺少 \`sources\`
3. 是否缺少 \`confidence\`
4. 是否存在矛盾但未写 \`矛盾注记\`
5. 同一来源是否只产出了一篇页面，导致知识扩散不足
`
      },
      {
        filePath: path.join(paths.knowledgeTopics, '项目知识系统分层.md'),
        content: `---
id: topic-project-knowledge-layering
title: "项目知识系统分层"
type: topic
confidence: 0.9
last_ingested: ${formatDateParts().isoTimestamp}
stale: false
updated_at: ${formatDateParts().isoDate}
related:
  - "task-wiki"
  - "runbook"
  - "traceability"
sources:
  - "system:knowledge-base-bootstrap"
---

# 项目知识系统分层

## Thesis

白白板当前最需要的不是再多一层聊天摘要，而是把任务记忆和长期知识分开管理。

## Main Structure

### 1. 任务 Wiki 层

- 面向单次任务复盘。
- 保留任务目标、关键决策、执行步骤、验证结果和工件路径。
- 来源是调度系统里的任务描述、消息、输出和日志。

### 2. 长期知识层

- 面向下次复用。
- 把跨任务稳定出现的概念、机制和经验整理为概念卡、主题页和 runbook。
- 强调可追溯和增量更新。

### 3. 输出层

- 把高价值问答、卡片、图示、备忘录等产物写入文件。
- 输出不是终点，而是下一轮知识沉淀的输入。

## Tensions

- 任务复盘天然详细，但不一定适合作为长期知识。
- 长期知识需要整理和去噪，否则会重新变成流水账。
`
      },
      {
        filePath: path.join(paths.knowledgeRunbooks, '任务完成后如何沉淀知识.md'),
        content: `---
id: runbook-post-task-knowledge-sync
title: "任务完成后如何沉淀知识"
type: runbook
confidence: 0.9
last_ingested: ${formatDateParts().isoTimestamp}
stale: false
updated_at: ${formatDateParts().isoDate}
sources:
  - "system:knowledge-base-bootstrap"
---

# 任务完成后如何沉淀知识

## 目标

让每一次任务完成后，系统不仅更新状态，还同步更新文件型知识资产。

## 标准动作

1. 导出一份 raw 任务快照，保留需求、决策、问题、验证和工件路径。
2. 导出一份 task wiki 文件，方便按文件回看任务复盘。
3. 更新知识索引和操作日志。
4. 如果任务里出现稳定概念或常见故障，再补充到 \`concepts/\` 或 \`runbooks/\`。

## 什么时候继续上升为长期知识

- 同一问题反复出现两次以上。
- 同一机制跨多个任务复用。
- 需要新人或其他 agent 也能直接复用。
- 需要形成排障手册、架构说明或输出模板。

## 当前建议

- 先稳定沉淀 task wiki。
- 再逐步把高频知识抽成 concepts/topics/runbooks。
`
      },
      {
        filePath: paths.outputsReadme,
        content: `# Outputs

这里存放从知识系统中生成的实际交付物。

- \`memo/\`：研究备忘录、结论摘要、阶段性汇报
- \`cards/\`：视觉卡片、信息图、社交媒体素材
- \`diagrams/\`：draw.io、架构图、流程图
`
      },
      {
        filePath: paths.inspectionReadme,
        content: `# Inspection

这里存放知识系统巡检报告。

巡检默认只出报告，不自动大面积重写知识库。
重点关注：

1. 重复概念
2. 冲突定义
3. 缺少来源的结论
4. 长期未更新但仍被高频引用的内容
5. 孤岛页面和断链
`
      },
      {
        filePath: paths.knowledgeLog,
        content: `# Knowledge Log

记录知识系统的导入、导出、回填和巡检动作。
`
      }
    ]

    for (const { filePath, content } of seedFiles) {
      if (!fs.existsSync(filePath)) {
        ensureDir(path.dirname(filePath))
        fs.writeFileSync(filePath, content, 'utf-8')
      }
    }
  }

  hasStructuredContext(wiki = {}) {
    return Boolean(
      wiki.sourceSummary ||
      normalizeArray(wiki.requirementHighlights).length > 0 ||
      normalizeArray(wiki.decisionHighlights).length > 0 ||
      normalizeArray(wiki.issueHighlights).length > 0 ||
      normalizeArray(wiki.executionHighlights).length > 0 ||
      normalizeArray(wiki.verificationHighlights).length > 0 ||
      normalizeArray(wiki.artifactPaths).length > 0
    )
  }

  contextFromWiki(wiki = {}) {
    return {
      requirementHighlights: normalizeArray(wiki.requirementHighlights),
      decisionHighlights: normalizeArray(wiki.decisionHighlights),
      issueHighlights: normalizeArray(wiki.issueHighlights),
      executionHighlights: normalizeArray(wiki.executionHighlights),
      verificationHighlights: normalizeArray(wiki.verificationHighlights),
      artifactPaths: normalizeArray(wiki.artifactPaths),
      generatedFromTaskIds: normalizeArray(wiki.generatedFromTaskIds),
      sourceSummary: wiki.sourceSummary && typeof wiki.sourceSummary === 'object'
        ? wiki.sourceSummary
        : null
    }
  }

  hasLogMarker(marker) {
    const normalizedMarker = cleanInlineText(marker)
    if (!normalizedMarker) return false

    const logPath = this.getPaths().knowledgeLog
    if (!fs.existsSync(logPath)) return false
    return fs.readFileSync(logPath, 'utf-8').includes(`<!-- ${normalizedMarker} -->`)
  }

  buildSyntheticTaskFromWiki(wiki = {}) {
    const requirementHighlights = normalizeArray(wiki.requirementHighlights)
    const decisionHighlights = normalizeArray(wiki.decisionHighlights)
    const issueHighlights = normalizeArray(wiki.issueHighlights)
    const description = [
      requirementHighlights[0] ? `需求摘要：${requirementHighlights[0]}` : '',
      decisionHighlights[0] ? `关键决策：${decisionHighlights[0]}` : '',
      issueHighlights[0] ? `问题摘要：${issueHighlights[0]}` : ''
    ].filter(Boolean).join(' ')

    return {
      id: wiki.parentTaskId || `orphan-wiki-${String(wiki.id || '').slice(0, 8)}`,
      title: wiki.title || '未命名历史 Wiki',
      taskTag: wiki.taskTag || null,
      status: 'Archived',
      description,
      decompositionNote: '历史 Wiki 已与当前任务表脱钩，使用 Wiki 自身结构化信息进行回填。',
      operationFolder: ''
    }
  }

  buildTaskKnowledgeFileInfo(task, wiki) {
    const created = formatDateParts(wiki.createdAt || task.updatedAt || task.createdAt)
    const stableTaskId = task.taskTag ? `task-${task.taskTag}` : `task-${String(task.id || '').slice(0, 8)}`
    const titleSlug = slugify(task.title || wiki.title || stableTaskId, stableTaskId)
    const baseName = `${created.isoDate}-${stableTaskId}-${titleSlug}`
    const paths = this.getPaths()
    const rawDir = path.join(paths.rawTasks, created.year, created.month)
    const taskWikiDir = path.join(paths.knowledgeTaskWiki, created.year, created.month)
    const rawPath = path.join(rawDir, `${baseName}-raw.md`)
    const taskWikiPath = path.join(taskWikiDir, `${baseName}.md`)

    return {
      created,
      stableTaskId,
      baseName,
      rawDir,
      taskWikiDir,
      rawPath,
      taskWikiPath,
      rawRelative: toPosixPath(path.relative(this.root, rawPath)),
      taskWikiRelative: toPosixPath(path.relative(this.root, taskWikiPath)),
      rawLinkFromTaskWiki: toPosixPath(path.relative(path.dirname(taskWikiPath), rawPath))
    }
  }

  exportTaskKnowledge({ task, wiki, context, mode = 'sync', skipIndexUpdate = false } = {}) {
    if (!task || !wiki) {
      throw new Error('exportTaskKnowledge requires both task and wiki')
    }

    const paths = this.ensureStructure()
    const normalizedContext = {
      requirementHighlights: normalizeArray(context?.requirementHighlights),
      decisionHighlights: normalizeArray(context?.decisionHighlights),
      issueHighlights: normalizeArray(context?.issueHighlights),
      executionHighlights: normalizeArray(context?.executionHighlights),
      verificationHighlights: normalizeArray(context?.verificationHighlights),
      artifactPaths: normalizeArray(context?.artifactPaths),
      generatedFromTaskIds: normalizeArray(context?.generatedFromTaskIds),
      sourceSummary: context?.sourceSummary || null
    }

    const ingested = formatDateParts()
    const fileInfo = this.buildTaskKnowledgeFileInfo(task, wiki)
    ensureDir(fileInfo.rawDir)
    ensureDir(fileInfo.taskWikiDir)

    const rawDraft = this.renderRawTaskSnapshot(task, wiki, normalizedContext, fileInfo.rawRelative, {
      created: fileInfo.created,
      ingested
    })
    const rawSourceHash = computeSourceHashFromEntries([
      { label: fileInfo.rawRelative, content: rawDraft }
    ])
    const rawContent = this.renderRawTaskSnapshot(task, wiki, normalizedContext, fileInfo.rawRelative, {
      created: fileInfo.created,
      ingested,
      sourceHash: rawSourceHash
    })
    const taskWikiContent = this.renderTaskWiki(task, wiki, normalizedContext, {
      rawRelative: fileInfo.rawRelative,
      rawLinkFromTaskWiki: fileInfo.rawLinkFromTaskWiki,
      taskWikiRelative: fileInfo.taskWikiRelative,
      created: fileInfo.created,
      ingested,
      sourceHash: rawSourceHash
    })

    fs.writeFileSync(fileInfo.rawPath, rawContent, 'utf-8')
    fs.writeFileSync(fileInfo.taskWikiPath, taskWikiContent, 'utf-8')

    this.appendLogEntry({
      marker: `task-wiki:${task.id}`,
      title: `${mode} | task wiki | ${task.title || wiki.title || fileInfo.stableTaskId}`,
      details: [
        `task_id: ${task.id}`,
        task.taskTag ? `task_tag: ${task.taskTag}` : '',
        `raw: ${fileInfo.rawRelative}`,
        `knowledge: ${fileInfo.taskWikiRelative}`,
        wiki.id ? `wiki_id: ${wiki.id}` : ''
      ].filter(Boolean),
      createdAt: ingested.isoMinute
    })

    if (!skipIndexUpdate) {
      this.updateIndex()
    }

    return {
      rawPath: fileInfo.rawPath,
      taskWikiPath: fileInfo.taskWikiPath,
      rawRelative: fileInfo.rawRelative,
      taskWikiRelative: fileInfo.taskWikiRelative
    }
  }

  renderRawTaskSnapshot(task, wiki, context, rawRelative, meta) {
    const created = meta.created
    const ingested = meta.ingested || created
    const sourceSummary = context.sourceSummary || {}
    const conflictNotes = extractConflictNotes([
      ...(context.issueHighlights || []),
      wiki.content || '',
      task.description || '',
      task.decompositionNote || ''
    ])
    const confidence = inferConfidence('raw', {
      evidenceCount: context.artifactPaths.length + context.verificationHighlights.length,
      conflictCount: conflictNotes.length
    })
    const tags = [
      'internal-task',
      'task-wiki-bridge',
      task.taskTag ? `task-tag-${task.taskTag}` : '',
      task.status || ''
    ].filter(Boolean)

    const lines = [
      '---',
      `id: ${yamlQuote(`raw-${task.taskTag || String(task.id || '').slice(0, 8)}`)}`,
      `title: ${yamlQuote(task.title || wiki.title || '未命名任务')}`,
      'source_type: "internal_task"',
      `source_task_id: ${yamlQuote(task.id || '')}`,
      `source_wiki_id: ${yamlQuote(wiki.id || '')}`,
      `source_task_tag: ${yamlQuote(task.taskTag || '')}`,
      `captured_at: ${yamlQuote(created.isoTimestamp)}`,
      `status: ${yamlQuote(task.status || 'Done')}`,
      `confidence: ${confidence}`,
      `last_ingested: ${yamlQuote(ingested.isoTimestamp)}`,
      'stale: false',
      meta.sourceHash ? `source_hash: ${yamlQuote(meta.sourceHash)}` : '',
      `operation_folder: ${yamlQuote(task.operationFolder || '')}`,
      renderYamlList('tags', tags),
      renderYamlList('artifact_paths', context.artifactPaths),
      '---',
      '',
      '# Raw Task Snapshot',
      '',
      `- task_id: ${task.id || 'unknown'}`,
      task.taskTag ? `- task_tag: ${task.taskTag}` : '',
      `- wiki_id: ${wiki.id || 'unknown'}`,
      `- exported_from: ${rawRelative}`,
      task.operationFolder ? `- operation_folder: ${task.operationFolder}` : '- operation_folder: 未指定',
      '',
      '## Parent Task',
      '',
      `- 标题: ${task.title || wiki.title || '未命名任务'}`,
      `- 状态: ${task.status || 'unknown'}`,
      task.description ? `- 描述: ${cleanInlineText(task.description)}` : '- 描述: 无',
      task.decompositionNote ? `- 分解说明: ${cleanInlineText(task.decompositionNote)}` : '- 分解说明: 无',
      '',
      renderBulletSection('Requirement Highlights', context.requirementHighlights, '未提取到明确需求'),
      renderBulletSection('Decision Highlights', context.decisionHighlights, '未提取到明确决策'),
      renderBulletSection('Issue Highlights', context.issueHighlights, '未提取到明显问题'),
      renderBulletSection('Execution Highlights', context.executionHighlights, '未提取到执行摘要'),
      renderBulletSection('Verification Highlights', context.verificationHighlights, '未提取到验证结论'),
      renderBulletSection('Artifact Paths', context.artifactPaths, '未记录产物路径'),
      '## Source Summary',
      '',
      `- task_count: ${sourceSummary.taskCount ?? 0}`,
      `- subtask_count: ${sourceSummary.subTaskCount ?? 0}`,
      `- message_count: ${sourceSummary.messageCount ?? 0}`,
      `- output_line_count: ${sourceSummary.outputLineCount ?? 0}`,
      `- task_log_count: ${sourceSummary.taskLogCount ?? 0}`,
      `- requirement_count: ${sourceSummary.requirementCount ?? context.requirementHighlights.length}`,
      `- decision_count: ${sourceSummary.decisionCount ?? context.decisionHighlights.length}`,
      `- issue_count: ${sourceSummary.issueCount ?? context.issueHighlights.length}`,
      `- verification_count: ${sourceSummary.verificationCount ?? context.verificationHighlights.length}`,
      `- artifact_count: ${sourceSummary.artifactCount ?? context.artifactPaths.length}`,
      '',
      ...(conflictNotes.length > 0
        ? [
            '## 矛盾注记',
            '',
            ...conflictNotes.map(item => `- ${item}`),
            ''
          ]
        : []),
      '## Original Wiki Content',
      '',
      wiki.content || '_无 Wiki 正文_',
      ''
    ]

    return lines.filter(Boolean).join('\n')
  }

  renderTaskWiki(task, wiki, context, meta) {
    const keywords = normalizeArray(wiki.keywords)
    const generatedFromTaskIds = context.generatedFromTaskIds.length > 0
      ? context.generatedFromTaskIds
      : [task.id].filter(Boolean)
    const conflictNotes = extractConflictNotes([
      ...(context.issueHighlights || []),
      wiki.content || '',
      task.description || '',
      task.decompositionNote || ''
    ])
    const confidence = inferConfidence('task-wiki', {
      evidenceCount: context.verificationHighlights.length + context.artifactPaths.length,
      conflictCount: conflictNotes.length
    })

    const lines = [
      '---',
      `id: ${yamlQuote(`task-wiki-${task.taskTag || String(task.id || '').slice(0, 8)}`)}`,
      `title: ${yamlQuote(wiki.title || task.title || '未命名任务 Wiki')}`,
      'type: "task-wiki"',
      `created_at: ${yamlQuote(wiki.createdAt || meta.created.isoTimestamp)}`,
      `updated_at: ${yamlQuote(wiki.updatedAt || meta.created.isoTimestamp)}`,
      `confidence: ${confidence}`,
      `last_ingested: ${yamlQuote((meta.ingested || meta.created).isoTimestamp)}`,
      'stale: false',
      meta.sourceHash ? `source_hash: ${yamlQuote(meta.sourceHash)}` : '',
      `task_id: ${yamlQuote(task.id || '')}`,
      `task_tag: ${yamlQuote(task.taskTag || '')}`,
      `wiki_id: ${yamlQuote(wiki.id || '')}`,
      `operation_folder: ${yamlQuote(task.operationFolder || '')}`,
      `source_raw: ${yamlQuote(meta.rawRelative)}`,
      renderYamlList('keywords', keywords),
      renderYamlList('generated_from_task_ids', generatedFromTaskIds),
      '---',
      '',
      `# ${wiki.title || task.title || '未命名任务 Wiki'}`,
      '',
      '## 定位',
      '',
      '- 这是从白白板任务系统导出的任务级 Wiki 文件。',
      '- 用来保留任务目标、关键决策、执行步骤、验证结果和工件路径。',
      '- 如果其中某些经验会跨任务复用，再继续整理到 topics、concepts 或 runbooks。',
      '',
      '## 来源',
      '',
      `- 原始任务快照: [${meta.rawRelative}](${meta.rawLinkFromTaskWiki})`,
      `- 任务 ID: ${task.id || 'unknown'}`,
      task.taskTag ? `- 任务标签: ${task.taskTag}` : '',
      task.operationFolder ? `- 指定操作目录: ${task.operationFolder}` : '- 指定操作目录: 未指定',
      '',
      renderBulletSection('Requirement Highlights', context.requirementHighlights, '未提取到明确需求'),
      renderBulletSection('Decision Highlights', context.decisionHighlights, '未提取到明确决策'),
      renderBulletSection('Issue Highlights', context.issueHighlights, '未提取到明显问题'),
      renderBulletSection('Verification Highlights', context.verificationHighlights, '未提取到验证结论'),
      renderBulletSection('Artifact Paths', context.artifactPaths, '未记录产物路径'),
      ...(conflictNotes.length > 0
        ? [
            '## 矛盾注记',
            '',
            ...conflictNotes.map(item => `- ${item}`),
            ''
          ]
        : []),
      '## Task Wiki 正文',
      '',
      wiki.content || '_无 Wiki 正文_',
      '',
      '## Traceability',
      '',
      ...generatedFromTaskIds.map(item => `- generated_from_task_id: ${item}`),
      ''
    ]

    return lines.filter(Boolean).join('\n')
  }

  buildKnowledgeDerivationPrompt({ task, wiki, taskWikiContent, rawContent, taskWikiRelative, rawRelative }) {
    const conciseTaskWiki = truncateText(taskWikiContent, 12000)
    const conciseRaw = truncateText(rawContent, 8000)

    return `你正在执行“消化”步骤。

目标：
把一个 task-wiki 进一步编译为更长期可复用的知识资产，只产出真正值得保留的 concepts、topics、runbooks。

工作要求：
1. 只基于提供的 task wiki 与 raw 快照，不要编造外部知识。
2. 只提炼对白白板系统后续任务真的有复用价值的内容。
3. 概念卡用于稳定术语、机制、边界。
4. 主题页用于组织多个点的长期主题，不要写成任务流水账。
5. runbook 用于可执行的排障或操作手册。
6. 如果某种类型没有足够长期价值，返回空数组。
7. 所有内容必须用中文。
8. 所有 evidence、where_it_appears、steps、pitfalls 都尽量引用任务里的真实现象、路径、状态或结论。
9. 不要生成泛泛而谈的空话。
10. 一份来源可以扩散成多页知识，不要只产出一篇摘要。
11. 每类最多输出：concepts 4 个，topics 2 个，runbooks 2 个。

任务信息：
- title: ${task.title || wiki.title || '未命名任务'}
- task_id: ${task.id || ''}
- task_tag: ${task.taskTag || ''}
- task_wiki_path: ${taskWikiRelative}
- raw_path: ${rawRelative}

【Task Wiki】
${conciseTaskWiki}

【Raw Snapshot】
${conciseRaw}

请只输出 JSON，格式如下：
{
  "concepts": [
    {
      "title": "概念标题",
      "aliases": ["别名1"],
      "related": ["相关条目标题"],
      "definition": "这个概念在当前系统中的定义。",
      "why_it_matters": "它为什么重要。",
      "where_it_appears": ["它在什么任务或场景里出现"],
      "evidence": ["支持这个概念的证据"],
      "notes": ["补充说明"]
    }
  ],
  "topics": [
    {
      "title": "主题标题",
      "related": ["相关条目标题"],
      "thesis": "这个主题最核心的判断。",
      "main_structure": [
        {
          "heading": "小节标题",
          "bullets": ["要点1", "要点2"]
        }
      ],
      "evidence": ["支持这个主题的证据"],
      "tensions": ["冲突、限制或未决问题"],
      "conflict_notes": ["若有矛盾，写出矛盾点"]
    }
  ],
  "runbooks": [
    {
      "title": "runbook 标题",
      "related": ["相关条目标题"],
      "trigger": "什么情况下应该使用这个 runbook",
      "preconditions": ["执行前检查项"],
      "steps": ["步骤1", "步骤2"],
      "validation": ["如何确认处理成功"],
      "pitfalls": ["常见坑"],
      "conflict_notes": ["若有矛盾，写出矛盾点"]
    }
  ]
}`
  }

  normalizeStructuredArtifacts(result = {}) {
    const normalized = {
      concepts: [],
      topics: [],
      runbooks: []
    }

    for (const type of KNOWN_KNOWLEDGE_TYPES) {
      const list = Array.isArray(result[type]) ? result[type] : []
      normalized[type] = list
        .map(item => item && typeof item === 'object' ? item : null)
        .filter(Boolean)
        .map(item => {
          const title = cleanInlineText(item.title)
          if (!title) return null

          const base = {
            title,
            related: dedupeTexts(normalizeArray(item.related)),
            aliases: dedupeTexts(normalizeArray(item.aliases)),
            conflictNotes: dedupeTexts(normalizeArray(item.conflict_notes || item.conflictNotes))
          }

          if (type === 'concepts') {
            return {
              ...base,
              definition: cleanInlineText(item.definition),
              whyItMatters: cleanInlineText(item.why_it_matters || item.whyItMatters),
              whereItAppears: dedupeTexts(normalizeArray(item.where_it_appears || item.whereItAppears)),
              evidence: dedupeTexts(normalizeArray(item.evidence)),
              notes: dedupeTexts(normalizeArray(item.notes))
            }
          }

          if (type === 'topics') {
            const rawMainStructure = item.main_structure || item.mainStructure
            const mainStructure = Array.isArray(rawMainStructure)
              ? rawMainStructure
                .map(section => section && typeof section === 'object'
                  ? {
                      heading: cleanInlineText(section.heading),
                      bullets: dedupeTexts(normalizeArray(section.bullets))
                    }
                  : null)
                .filter(section => section && section.heading)
              : []

            return {
              ...base,
              thesis: cleanInlineText(item.thesis),
              mainStructure,
              evidence: dedupeTexts(normalizeArray(item.evidence)),
              tensions: dedupeTexts(normalizeArray(item.tensions))
            }
          }

          return {
            ...base,
            trigger: cleanInlineText(item.trigger),
            preconditions: dedupeTexts(normalizeArray(item.preconditions)),
            steps: dedupeTexts(normalizeArray(item.steps)),
            validation: dedupeTexts(normalizeArray(item.validation)),
            pitfalls: dedupeTexts(normalizeArray(item.pitfalls))
          }
        })
        .filter(Boolean)
    }

    return normalized
  }

  getArtifactDirectory(type) {
    const paths = this.getPaths()
    switch (type) {
      case 'concepts':
        return paths.knowledgeConcepts
      case 'topics':
        return paths.knowledgeTopics
      case 'runbooks':
        return paths.knowledgeRunbooks
      default:
        throw new Error(`Unknown knowledge artifact type: ${type}`)
    }
  }

  findExistingArtifactPath(type, title) {
    const dirPath = this.getArtifactDirectory(type)
    const normalizedTitle = cleanInlineText(title)
    if (!normalizedTitle || !fs.existsSync(dirPath)) return null

    for (const filePath of walkMarkdownFiles(dirPath)) {
      try {
        if (cleanInlineText(readMarkdownTitle(filePath)) === normalizedTitle) {
          return filePath
        }
      } catch (error) {
        continue
      }
    }

    return null
  }

  buildArtifactPath(type, title, task) {
    const dirPath = this.getArtifactDirectory(type)
    const baseSlug = slugify(title, type.slice(0, -1))
    const taskSuffix = task.taskTag ? `-task-${task.taskTag}` : `-${String(task.id || '').slice(0, 8)}`
    const existingPath = this.findExistingArtifactPath(type, title)
    if (existingPath) {
      return existingPath
    }
    const primaryPath = path.join(dirPath, `${baseSlug}.md`)
    if (!fs.existsSync(primaryPath)) {
      return primaryPath
    }
    return path.join(dirPath, `${baseSlug}${taskSuffix}.md`)
  }

  renderConceptArtifact(item, meta) {
    const slug = slugify(item.title, 'concept')
    const mergedConflictNotes = dedupeTexts([...(meta.conflictNotes || []), ...(item.conflictNotes || [])])
    const confidence = inferConfidence('concepts', {
      evidenceCount: item.evidence.length,
      conflictCount: mergedConflictNotes.length,
      missingCoreFields: [item.definition, item.whyItMatters].filter(Boolean).length < 2 ? 1 : 0
    })
    return [
      '---',
      `id: ${yamlQuote(`concept-${slug}`)}`,
      `title: ${yamlQuote(item.title)}`,
      'type: "concept"',
      `created_at: ${yamlQuote(meta.createdAt)}`,
      `updated_at: ${yamlQuote(meta.updatedAt)}`,
      `confidence: ${confidence}`,
      `last_ingested: ${yamlQuote(meta.lastIngested || meta.updatedAt)}`,
      `stale: ${meta.stale === true ? 'true' : 'false'}`,
      meta.sourceHash ? `source_hash: ${yamlQuote(meta.sourceHash)}` : '',
      renderYamlList('aliases', item.aliases),
      renderYamlList('related', item.related),
      renderYamlList('sources', meta.sources),
      renderYamlList('derived_from_task_ids', [meta.taskId]),
      renderYamlList('derived_from_task_tags', meta.taskTag ? [String(meta.taskTag)] : []),
      '---',
      '',
      '## Definition',
      '',
      item.definition || '待补充定义。',
      '',
      '## Why It Matters',
      '',
      item.whyItMatters || '待补充原因。',
      '',
      renderBulletSection('Where It Appears', item.whereItAppears, '待补充出现位置'),
      renderBulletSection('Evidence', item.evidence, '待补充证据'),
      ...(mergedConflictNotes.length > 0
        ? [
            '## 矛盾注记',
            '',
            ...mergedConflictNotes.map(note => `- ${note}`),
            ''
          ]
        : []),
      renderBulletSection('Notes', item.notes, '无'),
      ''
    ].join('\n')
  }

  renderTopicArtifact(item, meta) {
    const slug = slugify(item.title, 'topic')
    const mergedConflictNotes = dedupeTexts([...(meta.conflictNotes || []), ...(item.conflictNotes || [])])
    const confidence = inferConfidence('topics', {
      evidenceCount: item.evidence.length,
      conflictCount: mergedConflictNotes.length,
      missingCoreFields: [item.thesis].filter(Boolean).length < 1 ? 1 : 0
    })
    const structureLines = item.mainStructure.length > 0
      ? item.mainStructure.flatMap(section => [
          `### ${section.heading}`,
          '',
          ...(section.bullets.length > 0 ? section.bullets.map(line => `- ${line}`) : ['- 无']),
          ''
        ])
      : ['### 待补充', '', '- 无', '']

    return [
      '---',
      `id: ${yamlQuote(`topic-${slug}`)}`,
      `title: ${yamlQuote(item.title)}`,
      'type: "topic"',
      `created_at: ${yamlQuote(meta.createdAt)}`,
      `updated_at: ${yamlQuote(meta.updatedAt)}`,
      `confidence: ${confidence}`,
      `last_ingested: ${yamlQuote(meta.lastIngested || meta.updatedAt)}`,
      `stale: ${meta.stale === true ? 'true' : 'false'}`,
      meta.sourceHash ? `source_hash: ${yamlQuote(meta.sourceHash)}` : '',
      renderYamlList('related', item.related),
      renderYamlList('sources', meta.sources),
      renderYamlList('derived_from_task_ids', [meta.taskId]),
      renderYamlList('derived_from_task_tags', meta.taskTag ? [String(meta.taskTag)] : []),
      '---',
      '',
      '## Thesis',
      '',
      item.thesis || '待补充主题判断。',
      '',
      '## Main Structure',
      '',
      ...structureLines,
      renderBulletSection('Evidence', item.evidence, '待补充证据'),
      ...(mergedConflictNotes.length > 0
        ? [
            '## 矛盾注记',
            '',
            ...mergedConflictNotes.map(note => `- ${note}`),
            ''
          ]
        : []),
      renderBulletSection('Tensions', item.tensions, '无'),
      ''
    ].join('\n')
  }

  renderRunbookArtifact(item, meta) {
    const slug = slugify(item.title, 'runbook')
    const mergedConflictNotes = dedupeTexts([...(meta.conflictNotes || []), ...(item.conflictNotes || [])])
    const confidence = inferConfidence('runbooks', {
      evidenceCount: item.validation.length + item.steps.length,
      conflictCount: mergedConflictNotes.length,
      missingCoreFields: [item.trigger].filter(Boolean).length < 1 ? 1 : 0
    })
    return [
      '---',
      `id: ${yamlQuote(`runbook-${slug}`)}`,
      `title: ${yamlQuote(item.title)}`,
      'type: "runbook"',
      `created_at: ${yamlQuote(meta.createdAt)}`,
      `updated_at: ${yamlQuote(meta.updatedAt)}`,
      `confidence: ${confidence}`,
      `last_ingested: ${yamlQuote(meta.lastIngested || meta.updatedAt)}`,
      `stale: ${meta.stale === true ? 'true' : 'false'}`,
      meta.sourceHash ? `source_hash: ${yamlQuote(meta.sourceHash)}` : '',
      renderYamlList('related', item.related),
      renderYamlList('sources', meta.sources),
      renderYamlList('derived_from_task_ids', [meta.taskId]),
      renderYamlList('derived_from_task_tags', meta.taskTag ? [String(meta.taskTag)] : []),
      '---',
      '',
      '## Trigger',
      '',
      item.trigger || '待补充触发条件。',
      '',
      renderBulletSection('Preconditions', item.preconditions, '无'),
      renderBulletSection('Steps', item.steps, '待补充步骤'),
      renderBulletSection('Validation', item.validation, '待补充验证方式'),
      ...(mergedConflictNotes.length > 0
        ? [
            '## 矛盾注记',
            '',
            ...mergedConflictNotes.map(note => `- ${note}`),
            ''
          ]
        : []),
      renderBulletSection('Pitfalls', item.pitfalls, '无'),
      ''
    ].join('\n')
  }

  renderKnowledgeArtifact(type, item, meta) {
    switch (type) {
      case 'concepts':
        return this.renderConceptArtifact(item, meta)
      case 'topics':
        return this.renderTopicArtifact(item, meta)
      case 'runbooks':
        return this.renderRunbookArtifact(item, meta)
      default:
        throw new Error(`Unknown artifact type: ${type}`)
    }
  }

  async deriveKnowledgeArtifacts({ task, wiki, exportResult, force = false, mode = 'derive', skipIndexUpdate = false } = {}) {
    if (!task || !wiki || !exportResult?.taskWikiPath || !exportResult?.rawPath) {
      throw new Error('deriveKnowledgeArtifacts requires task, wiki and exportResult with taskWikiPath/rawPath')
    }

    this.ensureStructure()

    const deriveMarker = `derive:${wiki.id || task.id}`
    const marker = mode.startsWith('redigest')
      ? `${mode}:${wiki.id || task.id}:${formatDateParts().isoTimestamp}`
      : deriveMarker
    if (!force && this.hasLogMarker(deriveMarker)) {
      return { skipped: true, writtenFiles: [] }
    }

    const taskWikiContent = fs.readFileSync(exportResult.taskWikiPath, 'utf-8')
    const rawContent = fs.readFileSync(exportResult.rawPath, 'utf-8')
    const prompt = this.buildKnowledgeDerivationPrompt({
      task,
      wiki,
      taskWikiContent,
      rawContent,
      taskWikiRelative: exportResult.taskWikiRelative,
      rawRelative: exportResult.rawRelative
    })

    const parsed = await requestStructuredJson(prompt, `knowledge-derivation:${wiki.id || task.id}`)
    const normalized = this.normalizeStructuredArtifacts(parsed)
    const writtenFiles = []
    const createdAt = formatDateParts().isoTimestamp
    const sources = dedupeTexts([exportResult.rawRelative, exportResult.taskWikiRelative])
    const sourceConflictNotes = extractConflictNotes([taskWikiContent, rawContent])
    const sourceHash = computeSourceHashFromEntries([
      { label: exportResult.rawRelative, content: rawContent },
      { label: exportResult.taskWikiRelative, content: taskWikiContent }
    ])

    for (const type of KNOWN_KNOWLEDGE_TYPES) {
      for (const item of normalized[type]) {
        const filePath = this.buildArtifactPath(type, item.title, task)
        const content = this.renderKnowledgeArtifact(type, item, {
          createdAt,
          updatedAt: createdAt,
          lastIngested: createdAt,
          stale: false,
          sourceHash,
          sources,
          conflictNotes: sourceConflictNotes,
          taskId: task.id || '',
          taskTag: task.taskTag || ''
        })

        fs.writeFileSync(filePath, content, 'utf-8')
        writtenFiles.push(toPosixPath(path.relative(this.root, filePath)))
      }
    }

    this.appendLogEntry({
      marker,
      title: `${mode} | derived knowledge | ${task.title || wiki.title || task.id}`,
      details: [
        `task_id: ${task.id}`,
        task.taskTag ? `task_tag: ${task.taskTag}` : '',
        `source_task_wiki: ${exportResult.taskWikiRelative}`,
        `source_raw: ${exportResult.rawRelative}`,
        ...writtenFiles.map(file => `artifact: ${file}`)
      ].filter(Boolean),
      createdAt: formatDateParts().isoMinute
    })

    if (!skipIndexUpdate) {
      this.updateIndex()
    }

    return {
      skipped: false,
      writtenFiles,
      counts: Object.fromEntries(KNOWN_KNOWLEDGE_TYPES.map(type => [type, normalized[type].length]))
    }
  }

  appendLogEntry({ marker, title, details = [], createdAt } = {}) {
    const logPath = this.getPaths().knowledgeLog
    const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : ''
    const normalizedMarker = cleanInlineText(marker)

    if (normalizedMarker && existing.includes(`<!-- ${normalizedMarker} -->`)) {
      return false
    }

    const timestamp = createdAt || formatDateParts().isoMinute
    const lines = [
      '',
      normalizedMarker ? `<!-- ${normalizedMarker} -->` : '',
      `## [${timestamp}] ${cleanInlineText(title)}`,
      '',
      ...details.map(item => `- ${cleanInlineText(item)}`),
      ''
    ].filter(Boolean)

    fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf-8')
    return true
  }

  updateIndex() {
    const paths = this.getPaths()
    const sections = [
      {
        title: 'Topics',
        baseDir: paths.knowledgeTopics,
        baseLabel: 'topics'
      },
      {
        title: 'Concepts',
        baseDir: paths.knowledgeConcepts,
        baseLabel: 'concepts'
      },
      {
        title: 'Runbooks',
        baseDir: paths.knowledgeRunbooks,
        baseLabel: 'runbooks'
      },
      {
        title: 'Task Wiki',
        baseDir: paths.knowledgeTaskWiki,
        baseLabel: 'task-wiki'
      }
    ]

    const content = [
      '# Project Knowledge Index',
      '',
      '这个目录是白白板系统的文件型知识层。',
      '它和调度系统里的任务状态并行存在：任务系统负责执行流，知识目录负责长期复用。',
      '',
      '- `raw/` 保存原始材料和任务快照',
      '- `knowledge/task-wiki/` 保存任务级复盘',
      '- `knowledge/topics/`、`knowledge/concepts/`、`knowledge/runbooks/` 保存长期知识',
      '- `outputs/` 保存对外产物',
      '- `inspection/` 保存巡检报告',
      ''
    ]

    const excludeNames = new Set(['index.md', 'log.md', 'README.md'])

    for (const section of sections) {
      const files = walkMarkdownFiles(section.baseDir, excludeNames)
        .map(filePath => {
          const relativePath = toPosixPath(path.relative(paths.knowledge, filePath))
          const title = readMarkdownTitle(filePath)
          return { title, relativePath }
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'))

      content.push(`## ${section.title}`, '')

      if (files.length === 0) {
        content.push('- 无', '')
        continue
      }

      for (const file of files) {
        content.push(`- [${file.title}](${file.relativePath})`)
      }
      content.push('')
    }

    fs.writeFileSync(paths.knowledgeIndex, `${content.join('\n').trim()}\n`, 'utf-8')
    return paths.knowledgeIndex
  }

  backfillExistingWikis({ wikis = [], getTaskById, buildContext } = {}) {
    this.ensureStructure()

    let exported = 0
    let skipped = 0
    let orphanExported = 0

    for (const wiki of Array.isArray(wikis) ? wikis : []) {
      if (!wiki) continue

      const task = wiki.parentTaskId && typeof getTaskById === 'function'
        ? getTaskById(wiki.parentTaskId)
        : null
      const resolvedTask = task || this.buildSyntheticTaskFromWiki(wiki)

      const context = this.hasStructuredContext(wiki)
        ? this.contextFromWiki(wiki)
        : (task && typeof buildContext === 'function' ? buildContext(task, wiki) : this.contextFromWiki(wiki))

      this.exportTaskKnowledge({
        task: resolvedTask,
        wiki,
        context,
        mode: task ? 'backfill' : 'backfill-orphan',
        skipIndexUpdate: true
      })
      if (task) {
        exported += 1
      } else {
        orphanExported += 1
      }
    }

    this.updateIndex()
    return { exported, orphanExported, skipped }
  }

  async backfillDerivedArtifactsForWikis({ wikis = [], getTaskById, buildContext, force = false, mode = null } = {}) {
    this.ensureStructure()

    const summary = {
      processed: 0,
      skipped: 0,
      failed: 0,
      writtenFiles: []
    }

    for (const wiki of Array.isArray(wikis) ? wikis : []) {
      if (!wiki) continue

      const task = wiki.parentTaskId && typeof getTaskById === 'function'
        ? getTaskById(wiki.parentTaskId)
        : null
      const resolvedTask = task || this.buildSyntheticTaskFromWiki(wiki)
      const context = this.hasStructuredContext(wiki)
        ? this.contextFromWiki(wiki)
        : (task && typeof buildContext === 'function' ? buildContext(task, wiki) : this.contextFromWiki(wiki))

      try {
        const exportResult = this.exportTaskKnowledge({
          task: resolvedTask,
          wiki,
          context,
          mode: task ? 'backfill' : 'backfill-orphan',
          skipIndexUpdate: true
        })

        const deriveResult = await this.deriveKnowledgeArtifacts({
          task: resolvedTask,
          wiki,
          exportResult,
          force,
          mode: mode ? (task ? mode : `${mode}-orphan`) : (task ? 'backfill-derived' : 'backfill-derived-orphan'),
          skipIndexUpdate: true
        })

        if (deriveResult.skipped) {
          summary.skipped += 1
        } else {
          summary.processed += 1
          summary.writtenFiles.push(...deriveResult.writtenFiles)
        }
      } catch (error) {
        summary.failed += 1
        console.error(`[KnowledgeBase] Failed to derive artifacts for wiki ${wiki.id || wiki.title}:`, error.message)
      }
    }

    this.updateIndex()
    return summary
  }
}

const knowledgeBase = new KnowledgeBaseManager()

export { KnowledgeBaseManager }
export default knowledgeBase
