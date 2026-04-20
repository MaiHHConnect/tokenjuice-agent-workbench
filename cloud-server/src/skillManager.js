/**
 * Skill 管理器（JavaScript 版本）
 *
 * 核心功能：
 * - Skill 加载与发现
 * - 条件匹配与触发
 * - 自改进机制
 * - 配置变量管理
 */

import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import { getClaudeSkillsDirCandidates, resolvePreferredClaudeSkillsDir } from './claudePaths.js'

function getOrderedClaudeSkillDirs() {
  const preferredDir = resolvePreferredClaudeSkillsDir()
  const candidates = [preferredDir, ...getClaudeSkillsDirCandidates()]
  const seen = new Set()
  const result = []

  for (const dir of candidates) {
    if (!dir) continue
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }

  return result
}

/**
 * Skill 管理器
 */
export class SkillManager {
  constructor(options = {}) {
    this.skills = new Map()
    this.providers = []
    this.skillsDir = options.skillsDir || './skills'
    const orderedClaudeSkillDirs = getOrderedClaudeSkillDirs()
    this.skillSources = options.skillSources || [
      ...orderedClaudeSkillDirs.map((dir, index) => ({
        dir,
        sourceType: 'claude-installed',
        sourceLabel: index === 0 ? 'Claude Code 已安装' : 'Claude Code 候选目录',
        availableToClaude: true,
        sourceScope: 'claude',
        sortOrder: 100 - Math.min(index, 20)
      })),
      {
        dir: this.skillsDir,
        sourceType: 'project-local',
        sourceLabel: '项目内置',
        availableToClaude: false,
        sourceScope: 'project',
        sortOrder: 10
      }
    ]
    this.configPath = options.configPath || './config.yaml'
    this.disabledSkills = new Set()
    this.improvementLog = []
  }

  /**
   * 添加 Provider
   */
  addProvider(provider) {
    this.providers.push(provider)
  }

  /**
   * 加载所有 Skills
   */
  async loadAllSkills() {
    this.skills.clear()
    this.disabledSkills.clear()

    // 先加载禁用列表，再注册 Skills
    this.loadDisabledSkills()

    // 从文件系统加载
    for (const source of this.skillSources) {
      await this.loadSkillsFromDir(source.dir, source)
    }

    // 从 Providers 加载
    for (const provider of this.providers) {
      for (const skill of provider.getSkills()) {
        this.registerSkill(skill)
      }
    }

    console.log(`[SkillManager] Loaded ${this.skills.size} skills`)
  }

  /**
   * 从目录加载 Skills
   */
  async loadSkillsFromDir(dir, sourceMeta = {}) {
    if (!fs.existsSync(dir)) {
      return
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // 递归加载子目录
        await this.loadSkillsFromDir(fullPath, sourceMeta)
      } else if (entry.name === 'SKILL.md' || entry.name.endsWith('.skill.md')) {
        // 加载 skill 文件
        const skill = await this.loadSkillFromFile(fullPath, sourceMeta)
        if (skill) {
          this.registerSkill(skill)
        }
      }
    }
  }

  /**
   * 从文件加载 Skill
   */
  async loadSkillFromFile(filePath, sourceMeta = {}) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const stat = fs.statSync(filePath)
      return this.parseSkillContent(content, filePath, stat, sourceMeta)
    } catch (error) {
      console.error(`[SkillManager] Failed to load skill from ${filePath}:`, error)
      return null
    }
  }

  /**
   * 解析 Skill 内容（支持 YAML frontmatter）
   */
  parseSkillContent(content, sourcePath, stat = null, sourceMeta = {}) {
    const resolvedSourcePath = path.resolve(sourcePath)
    const inferredSource = this.buildSkillSourceMeta(resolvedSourcePath, sourceMeta)

    // 解析 YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

    if (!frontmatterMatch) {
      // 没有 frontmatter，使用文件名作为名称
      const name = path.basename(sourcePath, '.md')
      return {
        name,
        description: content.substring(0, 200),
        version: '1.0.0',
        enabled: true,
        usageCount: 0,
        content,
        sourcePath: resolvedSourcePath,
        createdAt: stat?.birthtime?.toISOString?.() || stat?.mtime?.toISOString?.() || null,
        updatedAt: stat?.mtime?.toISOString?.() || null,
        ...inferredSource
      }
    }

    try {
      const yamlContent = frontmatterMatch[1]
      const body = frontmatterMatch[2]
      const parsed = yaml.parse(yamlContent)

      const skill = {
        name: parsed.name || path.basename(path.dirname(sourcePath)),
        description: parsed.description || body.substring(0, 200),
        version: parsed.version || '1.0.0',
        triggers: parsed.triggers,
        patterns: parsed.patterns?.map(p => new RegExp(p)),
        platforms: parsed.platforms,
        enabled: parsed.enabled !== false,
        priority: parsed.priority || 0,
        category: parsed.category,
        usageCount: 0,
        selfImproving: parsed.selfImproving || false,
        configVars: parsed.configVars,
        metadata: parsed.metadata,
        content: body.trim(),
        sourcePath: resolvedSourcePath,
        createdAt: parsed.createdAt || stat?.birthtime?.toISOString?.() || stat?.mtime?.toISOString?.() || null,
        updatedAt: stat?.mtime?.toISOString?.() || null,
        ...inferredSource
      }

      return skill
    } catch (error) {
      console.error(`[SkillManager] Failed to parse frontmatter:`, error)
      return null
    }
  }

  /**
   * 注册 Skill
   */
  registerSkill(skill) {
    if (this.disabledSkills.has(skill.name)) {
      return
    }

    // 检查平台兼容性
    if (skill.platforms && skill.platforms.length > 0) {
      const currentPlatform = process.platform
      if (!skill.platforms.includes(currentPlatform)) {
        return
      }
    }

    const existing = this.skills.get(skill.name)
    if (existing && !this.shouldReplaceSkill(existing, skill)) {
      return
    }

    this.skills.set(skill.name, skill)
  }

  buildSkillSourceMeta(sourcePath, sourceMeta = {}) {
    const resolved = path.resolve(sourcePath)
    const orderedClaudeSkillDirs = getOrderedClaudeSkillDirs()
    const SOURCE_CONFIG = {
      'claude-installed': {
        sourceLabel: 'Claude Code 已安装',
        availableToClaude: true,
        sourceScope: 'claude',
        isAutoGenerated: false,
        sortOrder: 100
      },
      'claude-project-sync': {
        sourceLabel: '项目已直装到 Claude',
        availableToClaude: true,
        sourceScope: 'claude',
        isAutoGenerated: false,
        sortOrder: 105
      },
      'claude-auto': {
        sourceLabel: 'Claude Code 自动沉淀',
        availableToClaude: true,
        sourceScope: 'claude',
        isAutoGenerated: true,
        sortOrder: 110
      },
      'project-precipitated': {
        sourceLabel: '项目自动沉淀',
        availableToClaude: false,
        sourceScope: 'project',
        isAutoGenerated: true,
        sortOrder: 20
      },
      'project-local': {
        sourceLabel: '项目内置',
        availableToClaude: false,
        sourceScope: 'project',
        isAutoGenerated: false,
        sortOrder: 10
      },
      'external': {
        sourceLabel: '外部来源',
        availableToClaude: false,
        sourceScope: 'external',
        isAutoGenerated: false,
        sortOrder: 0
      }
    }

    const inferSourceTypeFromPath = () => {
      const claudeSkillRoots = orderedClaudeSkillDirs.map(item => path.resolve(item))
      const claudeAutoRoots = claudeSkillRoots.map(root => path.resolve(path.join(root, 'omc-learned')))
      const claudeProjectRoots = claudeSkillRoots.map(root => path.resolve(path.join(root, 'project-managed')))
      const projectSkillsRoot = path.resolve(this.skillsDir)
      const projectPrecipitatedRoot = path.resolve(path.join(this.skillsDir, '沉淀'))

      if (claudeAutoRoots.some(root => resolved.startsWith(root))) {
        return 'claude-auto'
      }
      if (claudeProjectRoots.some(root => resolved.startsWith(root))) {
        return 'claude-project-sync'
      }
      if (claudeSkillRoots.some(root => resolved.startsWith(root))) {
        return 'claude-installed'
      }
      if (resolved.startsWith(projectPrecipitatedRoot)) {
        return 'project-precipitated'
      }
      if (resolved.startsWith(projectSkillsRoot)) {
        return 'project-local'
      }
      return 'external'
    }

    const inferredSourceType = inferSourceTypeFromPath()
    const requestedSourceType = sourceMeta.sourceType || null
    const inferredConfig = SOURCE_CONFIG[inferredSourceType] || SOURCE_CONFIG.external
    const requestedConfig = requestedSourceType
      ? (SOURCE_CONFIG[requestedSourceType] || SOURCE_CONFIG.external)
      : null

    // Allow more specific sub-path sources like `skills/沉淀` and `~/.claude/skills/omc-learned`
    // to override the broad source passed in from the parent directory traversal.
    const sourceType = !requestedSourceType
      ? inferredSourceType
      : (inferredConfig.sortOrder > requestedConfig.sortOrder ? inferredSourceType : requestedSourceType)

    const defaults = SOURCE_CONFIG[sourceType] || SOURCE_CONFIG.external

    return {
      sourceType,
      sourceLabel: sourceMeta.sourceLabel || defaults.sourceLabel,
      sourceScope: sourceMeta.sourceScope || defaults.sourceScope,
      availableToClaude: sourceMeta.availableToClaude ?? defaults.availableToClaude,
      isAutoGenerated: sourceMeta.isAutoGenerated ?? defaults.isAutoGenerated,
      sourceSortOrder: sourceMeta.sortOrder ?? defaults.sortOrder
    }
  }

  shouldReplaceSkill(existingSkill, newSkill) {
    const score = (skill) => {
      const claudeBonus = skill.availableToClaude ? 1000 : 0
      const autoBonus = skill.isAutoGenerated ? 100 : 0
      const sourceBonus = skill.sourceSortOrder || 0
      const updatedAt = skill.updatedAt ? new Date(skill.updatedAt).getTime() : 0
      return claudeBonus + autoBonus + sourceBonus + updatedAt
    }

    return score(newSkill) >= score(existingSkill)
  }

  /**
   * 加载禁用列表
   */
  loadDisabledSkills() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8')
        const config = yaml.parse(content)
        const disabled = config?.skills?.disabled || []
        this.disabledSkills = new Set(disabled)
      }
    } catch (error) {
      console.error(`[SkillManager] Failed to load disabled skills:`, error)
    }
  }

  /**
   * 触发 Skill
   */
  async trigger(context) {
    const { userMessage } = context

    // 1. 检查关键词触发
    for (const [name, skill] of this.skills) {
      if (!skill.enabled) continue

      // 关键词匹配
      if (skill.triggers) {
        for (const trigger of skill.triggers) {
          if (userMessage.includes(trigger)) {
            this.recordUsage(skill.name)
            return {
              matched: true,
              skill,
              confidence: 0.9,
              reason: `Trigger: ${trigger}`
            }
          }
        }
      }

      // 正则匹配
      if (skill.patterns) {
        for (const pattern of skill.patterns) {
          if (pattern.test(userMessage)) {
            this.recordUsage(skill.name)
            return {
              matched: true,
              skill,
              confidence: 0.95,
              reason: `Pattern match: ${pattern}`
            }
          }
        }
      }
    }

    // 2. 返回未匹配
    return {
      matched: false,
      skill: null,
      confidence: 0
    }
  }

  /**
   * 记录 Skill 使用
   */
  recordUsage(skillName) {
    const skill = this.skills.get(skillName)
    if (skill) {
      skill.usageCount++
      skill.lastUsedAt = new Date().toISOString()
    }
  }

  /**
   * 搜索 Skills
   */
  searchSkills(query) {
    const lowerQuery = query.toLowerCase()
    const results = []

    for (const skill of this.skills.values()) {
      if (
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        (skill.category && skill.category.toLowerCase().includes(lowerQuery))
      ) {
        results.push(skill)
      }
    }

    return results.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  }

  /**
   * 获取所有 Skills
   */
  getAllSkills() {
    return Array.from(this.skills.values()).sort((a, b) => {
      if ((b.sourceSortOrder || 0) !== (a.sourceSortOrder || 0)) {
        return (b.sourceSortOrder || 0) - (a.sourceSortOrder || 0)
      }
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
    })
  }

  /**
   * 获取 Skill
   */
  getSkill(name) {
    return this.skills.get(name)
  }

  /**
   * 启用/禁用 Skill
   */
  async setSkillEnabled(name, enabled) {
    const skill = this.skills.get(name)
    if (skill) {
      skill.enabled = enabled
    }
  }

  /**
   * 创建自我改进笔记
   */
  async createImprovementNote(skillName, note) {
    const skill = this.skills.get(skillName)
    if (!skill) return

    if (!skill.improvementNotes) {
      skill.improvementNotes = []
    }

    skill.improvementNotes.push(`[${new Date().toISOString()}] ${note}`)

    // 记录到改进日志
    this.improvementLog.push({
      skillName,
      note,
      timestamp: new Date().toISOString()
    })

    console.log(`[SkillManager] Improvement note added to ${skillName}: ${note}`)
  }

  /**
   * 根据使用情况自动改进 Skill
   */
  async autoImprove(skillName, context) {
    const skill = this.skills.get(skillName)
    if (!skill || !skill.selfImproving) {
      return { success: false, error: 'Skill not found or not self-improving' }
    }

    // 检查是否需要改进（使用次数超过阈值但成功率低）
    if (skill.usageCount > 10) {
      // 简单的启发式改进：如果使用次数多但没有改进笔记，考虑添加
      if ((skill.improvementNotes?.length || 0) === 0) {
        await this.createImprovementNote(skillName, `Auto-improved: ${context.userMessage.substring(0, 50)}...`)
      }
    }

    return {
      success: true,
      improvementNote: skill.improvementNotes?.[skill.improvementNotes.length - 1]
    }
  }

  /**
   * 获取工具 schemas（用于 MCP）
   */
  getToolSchemas() {
    const schemas = []

    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue

      schemas.push({
        name: `skill_${skill.name}`,
        description: skill.description,
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['execute', 'improve', 'describe']
            },
            context: {
              type: 'object'
            }
          },
          required: ['action']
        }
      })
    }

    return schemas
  }

  /**
   * 获取改进日志
   */
  getImprovementLog() {
    return this.improvementLog
  }

  getStats() {
    const allSkills = this.getAllSkills()
    return {
      total: allSkills.length,
      claudeAvailable: allSkills.filter(skill => skill.availableToClaude).length,
      claudeInstalled: allSkills.filter(skill => skill.sourceType === 'claude-installed').length,
      claudeProjectSynced: allSkills.filter(skill => skill.sourceType === 'claude-project-sync').length,
      claudeAuto: allSkills.filter(skill => skill.sourceType === 'claude-auto').length,
      autoGenerated: allSkills.filter(skill => skill.isAutoGenerated).length,
      projectLocal: allSkills.filter(skill => skill.sourceType === 'project-local').length
    }
  }
}

// 导出单例
export const skillManager = new SkillManager()

export default skillManager
