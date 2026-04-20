/**
 * Workflow 配置管理器
 *
 * 解析和加载 WORKFLOW.md 格式的工作流配置
 */

import fs from 'fs'
import path from 'path'
import yaml from 'yaml'

export class WorkflowManager {
  constructor() {
    this.workflows = new Map()
    this.currentWorkflow = null
    this.defaultWorkflow = {
      tracker: {
        kind: 'internal', // internal | linear
        projectSlug: null
      },
      workspace: {
        root: './workspaces',
        format: 'task-{taskId}',
        hooks: {
          afterCreate: null,
          beforeCleanup: null
        }
      },
      agent: {
        maxConcurrentAgents: 5,
        maxTurns: 20,
        timeout: 600000, // 10 分钟
        prompt: null // 自定义 prompt 模板
      },
      codex: {
        command: null, // 自定义命令
        approvalPolicy: 'on-failure',
        threadSandbox: 'workspace-write',
        turnSandboxPolicy: null
      },
      server: {
        port: null
      }
    }
  }

  /**
   * 从文件加载工作流配置
   */
  loadFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Workflow file not found: ${filePath}`)
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    return this.parseFromString(content, filePath)
  }

  /**
   * 从字符串解析工作流配置（支持 YAML front matter）
   */
  parseFromString(content, source = 'string') {
    // 提取 YAML front matter
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

    let config = { ...this.defaultWorkflow }
    let promptTemplate = ''

    if (frontMatterMatch) {
      // 解析 YAML 配置
      try {
        const yamlContent = frontMatterMatch[1]
        const yamlConfig = yaml.parse(yamlContent)
        config = this.mergeConfig(config, yamlConfig)
      } catch (error) {
        throw new Error(`Invalid YAML in workflow file: ${error.message}`)
      }

      // 剩余部分作为 prompt 模板
      promptTemplate = frontMatterMatch[2].trim()
    } else {
      // 没有 front matter，整个内容作为 prompt 模板
      promptTemplate = content.trim()
    }

    // 如果没有自定义 prompt，使用默认模板
    if (!config.agent.prompt) {
      config.agent.prompt = promptTemplate || this.getDefaultPromptTemplate()
    }

    // 解析 prompt 模板中的变量
    config.agent.promptTemplate = config.agent.prompt
    config.agent.prompt = this.renderPrompt(config.agent.prompt, {
      issue: {
        id: '',
        identifier: '',
        title: '',
        description: ''
      },
      workspace: config.workspace
    })

    const workflow = {
      id: source,
      source,
      config,
      loadedAt: new Date().toISOString()
    }

    this.workflows.set(source, workflow)
    this.currentWorkflow = workflow

    console.log(`[Workflow] Loaded workflow from ${source}`)

    return workflow
  }

  /**
   * 合并配置
   */
  mergeConfig(defaultConfig, userConfig) {
    const result = { ...defaultConfig }

    for (const [key, value] of Object.entries(userConfig)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = { ...result[key], ...value }
      } else {
        result[key] = value
      }
    }

    return result
  }

  /**
   * 获取默认 prompt 模板
   */
  getDefaultPromptTemplate() {
    return `You are working on a task.

Title: {{ issue.title }}
Description: {{ issue.description }}

Workspace: {{ workspace.path }}

Instructions:
1. Analyze the task requirements
2. Implement the solution
3. Write tests if needed
4. Ensure code quality

Work in the workspace directory. All file operations are confined to this directory.`
  }

  /**
   * 渲染 prompt 模板
   */
  renderPrompt(template, context) {
    let result = template

    // 替换所有 {{ variable.path }} 格式的变量
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const value = this.getNestedValue(context, path.trim())
      return value !== undefined ? value : match
    })

    return result
  }

  /**
   * 获取嵌套对象中的值
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined
    }, obj)
  }

  /**
   * 为特定任务渲染 prompt
   */
  renderTaskPrompt(task) {
    if (!this.currentWorkflow) {
      throw new Error('No workflow loaded')
    }

    const context = {
      issue: {
        id: task.id,
        identifier: task.id.substring(0, 8).toUpperCase(),
        title: task.title,
        description: task.description || ''
      },
      workspace: {
        path: this.currentWorkflow.config.workspace.root
      }
    }

    return this.renderPrompt(
      this.currentWorkflow.config.agent.promptTemplate,
      context
    )
  }

  /**
   * 获取当前工作流
   */
  getCurrentWorkflow() {
    return this.currentWorkflow
  }

  /**
   * 获取配置
   */
  getConfig() {
    return this.currentWorkflow?.config || this.defaultWorkflow
  }

  /**
   * 获取 Agent 配置
   */
  getAgentConfig() {
    return this.getConfig().agent
  }

  /**
   * 获取 Workspace 配置
   */
  getWorkspaceConfig() {
    return this.getConfig().workspace
  }

  /**
   * 获取 Tracker 配置
   */
  getTrackerConfig() {
    return this.getConfig().tracker
  }

  /**
   * 获取并发限制
   */
  getMaxConcurrentAgents() {
    return this.getConfig().agent.maxConcurrentAgents || 5
  }

  /**
   * 获取最大轮次
   */
  getMaxTurns() {
    return this.getConfig().agent.maxTurns || 20
  }

  /**
   * 检查是否启用了特定功能
   */
  isEnabled(feature) {
    const config = this.getConfig()
    switch (feature) {
      case 'workspace':
        return !!config.workspace
      case 'hooks':
        return !!config.workspace?.hooks
      case 'linear':
        return config.tracker?.kind === 'linear'
      default:
        return false
    }
  }
}

// 导出单例
export const workflowManager = new WorkflowManager()

export default workflowManager
