/**
 * Wiki 和 Skill 沉淀 Hook 模块
 *
 * 在任务完成（Done）时自动：
 * 1. 生成 Wiki 文档（父任务完成时）
 * 2. 从输出中提取可复用模式沉淀为 Skill
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import db from './db.js'
import * as skills from './skills.js'
import workspaceManager from './workspace.js'
import { buildWikiContext } from './wikiContextBuilder.js'
import { resolvePreferredClaudeSkillsDir } from './claudePaths.js'
import knowledgeBase from './knowledgeBase.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Skill 沉淀目录
const SKILL_PRECIPITATED_DIR = path.join(process.cwd(), 'skills', '沉淀')
const CLAUDE_USER_SKILLS_DIR = path.join(resolvePreferredClaudeSkillsDir(), 'omc-learned')

/**
 * 初始化 Wiki/Skill Hooks
 * @param {EnhancedScheduler} scheduler - 调度器实例
 */
export function initWikiSkillHooks(scheduler) {
  try {
    knowledgeBase.ensureStructure()

    if (process.env.OMC_KNOWLEDGE_BACKFILL !== '0') {
      const result = knowledgeBase.backfillExistingWikis({
        wikis: db.getWikis(),
        getTaskById: (taskId) => db.getTaskById(taskId),
        buildContext: (parentTask) => buildWikiContext(
          parentTask,
          (taskId) => db.getTaskById(taskId),
          (taskId) => db.getTaskLogs(taskId)
        )
      })

      console.log(`[WikiSkillHooks] Knowledge base ready at ${knowledgeBase.getRoot()} (backfilled: ${result.exported}, orphanBackfilled: ${result.orphanExported}, skipped: ${result.skipped})`)
    } else {
      console.log(`[WikiSkillHooks] Knowledge base ready at ${knowledgeBase.getRoot()} (backfill skipped by env)`)
    }
  } catch (error) {
    console.error('[WikiSkillHooks] Failed to initialize knowledge base:', error.message)
  }

  // 注册任务完成时的 hook
  scheduler.onTaskDone = async (taskId, task, agent) => {
    await handleTaskDone(taskId, task, agent)
  }

  console.log('[WikiSkillHooks] Initialized')
}

/**
 * 处理任务完成后的 hook
 */
async function handleTaskDone(taskId, task, agent) {
  try {
    // 1. 如果是父任务，生成 Wiki
    if (!task.parentTaskId && task.subTaskIds && task.subTaskIds.length > 0) {
      await generateWiki(task)
    }

    // 2. 从输出中提取 Skill 沉淀
    await extractSkillPattern(task)
  } catch (e) {
    console.error('[WikiSkillHooks] Error in handleTaskDone:', e.message)
  }
}

/**
 * 生成 Wiki 文档
 */
async function generateWiki(parentTask) {
  console.log(`[WikiSkillHooks] Generating wiki for parent task: ${parentTask.id}`)

  const context = buildWikiContext(parentTask, (taskId) => db.getTaskById(taskId), (taskId) => db.getTaskLogs(taskId))
  const promptPayload = JSON.stringify(context, null, 2)

  // 构建 LLM 生成 Wiki 的 prompt
  const prompt = `你是一个面向 Claude Code 的知识沉淀专家。请根据下面的结构化任务上下文，生成一份真正可复用的 Wiki 文档。

目标：
1. 让后续 Claude Code 在相似任务中能快速理解需求、关键决策、产物位置、验证结论和踩坑点。
2. 不要写聊天客套或流水账。
3. 优先总结真正可复用的方法，而不是逐句复述对话。

写作要求：
- 必须使用 Markdown。
- 按以下章节组织内容：
  1. 任务目标
  2. 最终结果
  3. 关键决策
  4. 执行步骤
  5. 验证与验收
  6. 踩坑与修复
  7. 可复用经验
  8. 相关文件与路径
- 如果某一节没有信息，可以简短说明“无”或省略细节，但不要编造。
- 尽量引用上下文里的真实文件名、路径、任务要求、验证结论和修复点。

【结构化上下文】
${promptPayload}

请生成以下格式的 JSON（只输出 JSON）：
{
  "content": "Wiki 正文内容（Markdown 格式，包含任务概述、解决方案、关键步骤、注意事项）",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "artifactPaths": ["相关路径1", "相关路径2"]
}`

  try {
    const result = await callLLM(prompt)
    const wikiData = extractJsonObject(result)

    // 创建 Wiki
    const wiki = db.createWiki({
      title: parentTask.title,
      content: wikiData.content || buildFallbackWikiContent(parentTask, context),
      keywords: Array.isArray(wikiData.keywords) && wikiData.keywords.length > 0
        ? wikiData.keywords.slice(0, 12)
        : dedupeKeywordFallback(parentTask, context),
      taskTag: parentTask.taskTag,
      parentTaskId: parentTask.id,
      subTaskIds: parentTask.subTaskIds,
      sourceSummary: context.sourceSummary,
      artifactPaths: Array.isArray(wikiData.artifactPaths) && wikiData.artifactPaths.length > 0
        ? wikiData.artifactPaths.slice(0, 16)
        : context.artifactPaths,
      generatedFromTaskIds: context.generatedFromTaskIds,
      requirementHighlights: context.requirementHighlights,
      decisionHighlights: context.decisionHighlights,
      issueHighlights: context.issueHighlights,
      verificationHighlights: context.verificationHighlights
    })

    await syncWikiToKnowledgeBase(parentTask, context, wiki)

    console.log(`[WikiSkillHooks] Wiki created: ${wiki.id}`)
    return wiki
  } catch (e) {
    console.error('[WikiSkillHooks] Failed to generate wiki:', e.message)
    // 即使失败也创建一个结构化 Wiki
    const context = buildWikiContext(parentTask, (taskId) => db.getTaskById(taskId), (taskId) => db.getTaskLogs(taskId))
    const wiki = db.createWiki({
      title: parentTask.title,
      content: buildFallbackWikiContent(parentTask, context),
      keywords: dedupeKeywordFallback(parentTask, context),
      taskTag: parentTask.taskTag,
      parentTaskId: parentTask.id,
      subTaskIds: parentTask.subTaskIds,
      sourceSummary: context.sourceSummary,
      artifactPaths: context.artifactPaths,
      generatedFromTaskIds: context.generatedFromTaskIds,
      requirementHighlights: context.requirementHighlights,
      decisionHighlights: context.decisionHighlights,
      issueHighlights: context.issueHighlights,
      verificationHighlights: context.verificationHighlights
    })
    await syncWikiToKnowledgeBase(parentTask, context, wiki)
    return wiki
  }
}

async function syncWikiToKnowledgeBase(parentTask, context, wiki) {
  try {
    const exported = knowledgeBase.exportTaskKnowledge({
      task: parentTask,
      wiki,
      context,
      mode: 'task-done'
    })

    console.log(`[WikiSkillHooks] Synced task wiki to knowledge base: ${exported.taskWikiPath}`)

    if (process.env.OMC_KNOWLEDGE_AUTODERIVE !== '0') {
      const deriveResult = await knowledgeBase.deriveKnowledgeArtifacts({
        task: parentTask,
        wiki,
        exportResult: exported,
        mode: 'task-done-derived'
      })

      if (deriveResult.skipped) {
        console.log(`[WikiSkillHooks] Derived knowledge skipped for task ${parentTask.id}`)
      } else {
        console.log(`[WikiSkillHooks] Derived knowledge artifacts: ${deriveResult.writtenFiles.length}`)
      }
    }
  } catch (error) {
    console.error('[WikiSkillHooks] Failed to sync wiki to knowledge base:', error.message)
  }
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

function dedupeKeywordFallback(parentTask, context) {
  const keywordPool = [
    parentTask.title,
    ...(context.requirementHighlights || []),
    ...(context.artifactPaths || [])
  ]

  const seen = new Set()
  const keywords = []
  for (const item of keywordPool) {
    const keyword = String(item || '').trim()
    if (!keyword || keyword.length > 40 || seen.has(keyword)) continue
    seen.add(keyword)
    keywords.push(keyword)
    if (keywords.length >= 12) break
  }

  return keywords
}

function buildFallbackWikiContent(parentTask, context) {
  const sections = [
    '## 任务目标',
    `- ${parentTask.title}`,
    ...(context.requirementHighlights.length > 0
      ? context.requirementHighlights.map(item => `- ${item}`)
      : ['- 无额外需求记录']),
    '',
    '## 最终结果',
    ...(context.artifactPaths.length > 0
      ? context.artifactPaths.map(item => `- ${item}`)
      : ['- 产物路径未明确记录']),
    '',
    '## 关键决策',
    ...(context.decisionHighlights.length > 0
      ? context.decisionHighlights.map(item => `- ${item}`)
      : ['- 未提取到明确决策']),
    '',
    '## 执行步骤',
    ...(context.executionHighlights.length > 0
      ? context.executionHighlights.map(item => `- ${item}`)
      : ['- 未提取到有效执行步骤']),
    '',
    '## 验证与验收',
    ...(context.verificationHighlights.length > 0
      ? context.verificationHighlights.map(item => `- ${item}`)
      : ['- 未记录明确的 QA / 验收结论']),
    '',
    '## 踩坑与修复',
    ...(context.issueHighlights.length > 0
      ? context.issueHighlights.map(item => `- ${item}`)
      : ['- 本次任务未记录明显问题']),
    '',
    '## 可复用经验',
    '- 后续相似任务优先参考“关键决策”“执行步骤”“相关文件与路径”三个部分。',
    '',
    '## 相关文件与路径',
    ...(context.artifactPaths.length > 0
      ? context.artifactPaths.map(item => `- ${item}`)
      : ['- 无'])
  ]

  return sections.join('\n')
}

/**
 * 从任务输出中提取可复用的 Skill 沉淀
 */
async function extractSkillPattern(task) {
  if (!task.outputLines || task.outputLines.length === 0) {
    console.log(`[WikiSkillHooks] No output to extract skill from: ${task.id}`)
    return null
  }

  // 收集输出内容
  const outputContent = task.outputLines
    .map(l => l.content)
    .join('\n')
    .slice(-2000)  // 取最后 2000 字符

  // 构建 LLM 提取模式的 prompt
  const prompt = `你是一个模式识别专家。请从以下任务执行输出中提取可复用的模式、方法或最佳实践。

【任务信息】
标题: ${task.title}
描述: ${task.description || '无'}

【执行输出】
${outputContent}

请识别以下类型的可复用内容：
1. 重复使用的命令或脚本
2. 配置模式
3. 问题解决方案
4. 工作流程

如果提取到有效模式，返回以下格式的 JSON（如果没有可复用的，返回空 JSON {}）：
{
  "name": "模式名称（英文 kebab-case）",
  "description": "模式描述（中文，50字内）",
  "triggers": ["触发关键词1", "触发关键词2"],
  "content": "具体的模式内容（命令、代码或步骤）",
  "useCase": "使用场景描述"
}`

  try {
    const result = await callLLM(prompt)
    let patternData = {}

    try {
      patternData = JSON.parse(result)
    } catch (e) {
      // 不是有效 JSON，忽略
    }

    if (!patternData.name || !patternData.content) {
      console.log(`[WikiSkillHooks] No valid pattern extracted from: ${task.id}`)
      return null
    }

    // 确保沉淀目录存在
    if (!fs.existsSync(SKILL_PRECIPITATED_DIR)) {
      fs.mkdirSync(SKILL_PRECIPITATED_DIR, { recursive: true })
    }

    // 生成 Skill 文件
    const skillFileName = `${patternData.name}-${Date.now()}.skill.md`
    const skillFilePath = path.join(SKILL_PRECIPITATED_DIR, skillFileName)

    const skillContent = `---
name: ${patternData.name}
description: ${patternData.description}
version: 1.0.0
triggers:
${(patternData.triggers || []).map(t => `  - ${t}`).join('\n')}
patterns: []
enabled: true
priority: 10
category: precipitated
extractedFrom: ${task.id}
taskTag: ${task.taskTag || ''}
createdAt: ${new Date().toISOString()}
---

# ${patternData.name}

## 原始任务
${task.title}

## 使用场景
${patternData.useCase || '通用场景'}

## 模式内容
\`\`\`
${patternData.content}
\`\`\`
`

    fs.writeFileSync(skillFilePath, skillContent, 'utf-8')
    mirrorSkillToClaudeUserDir(patternData.name, skillContent)
    await skills.reloadSkills().catch(() => {})
    console.log(`[WikiSkillHooks] Skill precipitated: ${skillFileName}`)

    return patternData
  } catch (e) {
    console.error('[WikiSkillHooks] Failed to extract skill pattern:', e.message)
    return null
  }
}

function mirrorSkillToClaudeUserDir(skillName, skillContent) {
  const safeName = String(skillName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!safeName) {
    return null
  }

  const targetDir = path.join(CLAUDE_USER_SKILLS_DIR, safeName)
  const targetPath = path.join(targetDir, 'SKILL.md')

  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(targetPath, skillContent, 'utf-8')
  console.log(`[WikiSkillHooks] Mirrored precipitated skill to Claude Code dir: ${targetPath}`)

  return targetPath
}

/**
 * 调用 LLM 生成内容
 */
async function callLLM(prompt) {
  return new Promise((resolve, reject) => {
    const claudePath = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'

    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--agent', 'writer',
      '--', prompt
    ]

    const spawnEnv = { ...process.env, CLAUDECODE: '' }

    const proc = spawn('node', [claudePath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv
    })

    let output = ''

    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr.on('data', (data) => {
      // 忽略错误输出
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(`LLM call failed with code ${code}`))
      }
    })

    proc.on('error', (error) => {
      reject(error)
    })

    // 超时 60 秒
    setTimeout(() => {
      proc.kill()
      reject(new Error('LLM call timeout'))
    }, 60000)
  })
}

export default { initWikiSkillHooks }
