/**
 * Skills 管理模块
 *
 * 基于 Hermes Agent 的 Skills 自改进系统
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { SkillManager } from './skillManager.js'
import { resolvePreferredClaudeSkillsDir } from './claudePaths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const PROJECT_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills')
const CLAUDE_SKILLS_ROOT = resolvePreferredClaudeSkillsDir()
const CLAUDE_AUTO_SKILLS_ROOT = path.join(CLAUDE_SKILLS_ROOT, 'omc-learned')
const CLAUDE_PROJECT_SKILLS_ROOT = path.join(CLAUDE_SKILLS_ROOT, 'project-managed')

// 创建 SkillManager 实例
const skillManager = new SkillManager({
  skillsDir: path.join(PROJECT_ROOT, 'skills'),
  configPath: path.join(PROJECT_ROOT, 'config.yaml')
})

// 已加载的 Skills 缓存
let loaded = false

function toSafeSkillDirName(skillName) {
  return String(skillName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function syncProjectPrecipitatedSkillsToClaude() {
  return syncProjectSkillsToClaude()
}

function syncSkillGroupToClaude(skills, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true })

  const expectedDirs = new Set()
  let changedCount = 0

  for (const skill of skills) {
    const safeName = toSafeSkillDirName(skill.name)
    if (!safeName || !skill.sourcePath || !fs.existsSync(skill.sourcePath)) {
      continue
    }

    expectedDirs.add(safeName)

    const targetDir = path.join(targetRoot, safeName)
    const targetPath = path.join(targetDir, 'SKILL.md')
    const sourceContent = fs.readFileSync(skill.sourcePath, 'utf-8')
    const existingContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : null

    if (existingContent === sourceContent) {
      continue
    }

    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(targetPath, sourceContent, 'utf-8')
    changedCount += 1
  }

  const existingDirs = fs.readdirSync(targetRoot, { withFileTypes: true })
  for (const entry of existingDirs) {
    if (!entry.isDirectory() || expectedDirs.has(entry.name)) {
      continue
    }

    fs.rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true })
    changedCount += 1
  }

  return changedCount
}

async function collectProjectSkillsFromDisk(dir = PROJECT_SKILLS_DIR, collected = []) {
  if (!fs.existsSync(dir)) {
    return collected
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectProjectSkillsFromDisk(fullPath, collected)
      continue
    }

    if (entry.name !== 'SKILL.md' && !entry.name.endsWith('.skill.md')) {
      continue
    }

    const skill = await skillManager.loadSkillFromFile(fullPath)
    if (skill?.sourceType === 'project-local' || skill?.sourceType === 'project-precipitated') {
      collected.push(skill)
    }
  }

  return collected
}

async function syncProjectSkillsToClaude() {
  const projectSkills = await collectProjectSkillsFromDisk()
  const precipitatedSkills = projectSkills.filter(skill => skill.sourceType === 'project-precipitated')
  const projectLocalSkills = projectSkills.filter(skill => skill.sourceType === 'project-local')

  let changedCount = 0
  changedCount += syncSkillGroupToClaude(precipitatedSkills, CLAUDE_AUTO_SKILLS_ROOT)
  changedCount += syncSkillGroupToClaude(projectLocalSkills, CLAUDE_PROJECT_SKILLS_ROOT)

  return changedCount
}

/**
 * 初始化 Skills 系统
 */
export async function initSkills() {
  if (loaded) return

  try {
    await skillManager.loadAllSkills()
    const syncedCount = await syncProjectPrecipitatedSkillsToClaude()
    if (syncedCount > 0) {
      await skillManager.loadAllSkills()
    }
    loaded = true
    console.log('[Skills] Initialized successfully')
  } catch (e) {
    console.error('[Skills] Failed to initialize:', e.message)
  }
}

/**
 * 强制重载 Skills（用于刷新 Claude Code 已安装技能与自动沉淀技能）
 */
export async function reloadSkills() {
  await skillManager.loadAllSkills()
  const syncedCount = await syncProjectPrecipitatedSkillsToClaude()
  if (syncedCount > 0) {
    await skillManager.loadAllSkills()
  }
  loaded = true
  return skillManager.getAllSkills()
}

/**
 * 获取所有 Skills
 */
export function getAllSkills() {
  return skillManager.getAllSkills()
}

/**
 * 获取单个 Skill
 */
export function getSkill(name) {
  return skillManager.getSkill(name)
}

/**
 * 搜索 Skills
 */
export function searchSkills(query) {
  return skillManager.searchSkills(query)
}

/**
 * 触发 Skill
 */
export async function triggerSkill(context) {
  return await skillManager.trigger(context)
}

/**
 * 获取工具 schemas
 */
export function getToolSchemas() {
  return skillManager.getToolSchemas()
}

/**
 * 创建改进笔记
 */
export async function createImprovementNote(skillName, note) {
  return await skillManager.createImprovementNote(skillName, note)
}

/**
 * 自动改进 Skill
 */
export async function autoImprove(skillName, context) {
  return await skillManager.autoImprove(skillName, context)
}

/**
 * 启用/禁用 Skill
 */
export async function setSkillEnabled(name, enabled) {
  return await skillManager.setSkillEnabled(name, enabled)
}

/**
 * 获取改进日志
 */
export function getImprovementLog() {
  return skillManager.getImprovementLog()
}

export function getSkillStats() {
  return skillManager.getStats()
}

/**
 * 自然语言转 Cron（简单实现）
 */
export function toCron(natural) {
  const lower = natural.toLowerCase().trim()

  // 常用模式
  const patterns = [
    [/每分钟|every minute/i, '* * * * *'],
    [/每小时|every hour/i, '0 * * * *'],
    [/每天早上.*点|每天.*9.*点/i, '0 9 * * *'],
    [/每天中午|every day at noon/i, '0 12 * * *'],
    [/每天晚上.*点|every day.*8.*pm/i, '0 20 * * *'],
    [/每周一|every monday/i, '0 9 * * 1'],
    [/每周五|every friday/i, '0 9 * * 5'],
    [/工作日早上.*点|weekdays.*9/i, '0 9 * * 1-5'],
  ]

  for (const [pattern, cron] of patterns) {
    if (pattern.test(lower)) {
      return cron
    }
  }

  // 默认每小时
  return '0 * * * *'
}

export default {
  initSkills,
  reloadSkills,
  getAllSkills,
  getSkill,
  searchSkills,
  triggerSkill,
  getToolSchemas,
  createImprovementNote,
  autoImprove,
  setSkillEnabled,
  getImprovementLog,
  getSkillStats,
  toCron,
  skillManager
}
