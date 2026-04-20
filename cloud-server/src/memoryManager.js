/**
 * Memory 管理器（JavaScript 版本）
 *
 * 核心功能：
 * - 多 Provider 协调
 * - 上下文隔离（Fence）
 * - 跨 Session 记忆召回
 * - Session 总结
 */

/**
 * Memory 管理器
 */
export class MemoryManager {
  constructor(options = {}) {
    this.providers = []
    this.toolToProvider = new Map()
    this.hasExternal = false
    this.memoryDir = options.memoryDir || './memory'
    this.currentSessionId = null
    this.currentUserId = null
  }

  /**
   * 添加 Memory Provider
   */
  addProvider(provider) {
    // 内置 provider 始终接受
    const isBuiltin = provider.name === 'builtin'

    // 只允许一个外部 provider
    if (!isBuiltin) {
      if (this.hasExternal) {
        console.warn(
          `[MemoryManager] Rejected memory provider '${provider.name}' - ` +
          `external provider already registered. Only one external provider is allowed.`
        )
        return
      }
      this.hasExternal = true
    }

    this.providers.push(provider)

    // 索引工具
    for (const schema of provider.getToolSchemas()) {
      const toolName = schema.name
      if (toolName && !this.toolToProvider.has(toolName)) {
        this.toolToProvider.set(toolName, provider)
      }
    }

    console.log(`[MemoryManager] Provider '${provider.name}' registered (${provider.getToolSchemas().length} tools)`)
  }

  /**
   * 设置当前上下文
   */
  setContext(userId, sessionId) {
    this.currentUserId = userId || null
    this.currentSessionId = sessionId || null
  }

  /**
   * 构建系统提示词（包含所有 Provider 的记忆块）
   */
  buildSystemPrompt() {
    const blocks = []

    for (const provider of this.providers) {
      try {
        const block = provider.systemPromptBlock()
        if (block && block.trim()) {
          blocks.push(block)
        }
      } catch (error) {
        console.warn(`[MemoryManager] Provider '${provider.name}' systemPromptBlock() failed:`, error)
      }
    }

    return blocks.join('\n\n')
  }

  /**
   * 预取记忆（当前 Turn 之前）
   */
  prefetch(query) {
    const parts = []

    for (const provider of this.providers) {
      try {
        const result = provider.prefetch(query, this.currentSessionId || undefined, this.currentUserId || undefined)
        if (result && result.trim()) {
          parts.push(result)
        }
      } catch (error) {
        console.debug(`[MemoryManager] Provider '${provider.name}' prefetch failed:`, error)
      }
    }

    return parts.join('\n\n')
  }

  /**
   * 同步 Turn（当前 Turn 完成后）
   */
  syncTurn(userContent, assistantContent) {
    for (const provider of this.providers) {
      try {
        provider.syncTurn(userContent, assistantContent, this.currentSessionId || undefined)
      } catch (error) {
        console.warn(`[MemoryManager] Provider '${provider.name}' syncTurn failed:`, error)
      }
    }
  }

  /**
   * Session 结束
   */
  onSessionEnd(messages) {
    for (const provider of this.providers) {
      try {
        provider.onSessionEnd(messages)
      } catch (error) {
        console.debug(`[MemoryManager] Provider '${provider.name}' onSessionEnd failed:`, error)
      }
    }

    this.currentSessionId = null
  }

  /**
   * 获取所有工具 Schemas
   */
  getAllToolSchemas() {
    const schemas = []
    const seen = new Set()

    for (const provider of this.providers) {
      try {
        for (const schema of provider.getToolSchemas()) {
          const name = schema.name
          if (name && !seen.has(name)) {
            schemas.push(schema)
            seen.add(name)
          }
        }
      } catch (error) {
        console.warn(`[MemoryManager] Provider '${provider.name}' getToolSchemas() failed:`, error)
      }
    }

    return schemas
  }

  /**
   * 获取所有工具名称
   */
  getAllToolNames() {
    return new Set(this.toolToProvider.keys())
  }

  /**
   * 检查是否有特定工具
   */
  hasTool(toolName) {
    return this.toolToProvider.has(toolName)
  }

  /**
   * 处理工具调用
   */
  handleToolCall(toolName, args) {
    const provider = this.toolToProvider.get(toolName)
    if (!provider) {
      return JSON.stringify({ error: `No memory provider handles tool '${toolName}'` })
    }

    try {
      return provider.handleToolCall?.(toolName, args) ||
        JSON.stringify({ error: `Provider ${provider.name} doesn't implement handleToolCall` })
    } catch (error) {
      console.error(`[MemoryManager] Provider '${provider.name}' handleToolCall(${toolName}) failed:`, error)
      return JSON.stringify({ error: `Memory tool '${toolName}' failed: ${error.message}` })
    }
  }

  /**
   * 获取所有 Provider
   */
  getProviders() {
    return [...this.providers]
  }

  /**
   * 按名称获取 Provider
   */
  getProvider(name) {
    return this.providers.find(p => p.name === name)
  }
}

/**
 * 内置 Memory Provider（基于文件的简单记忆）
 */
export class BuiltinMemoryProvider {
  constructor(memoryDir) {
    this.name = 'builtin'
    this.memoryDir = memoryDir
    this.userMemory = new Map()  // userId -> memories
    this.sessionMemory = new Map()  // sessionId -> memories
  }

  systemPromptBlock() {
    return `[Memory] You have access to persistent memory. Use the memory.search tool to recall relevant information.`
  }

  prefetch(query, sessionId, userId) {
    const memories = []

    // 搜索用户记忆
    if (userId) {
      const userMemories = this.userMemory.get(userId) || []
      memories.push(...userMemories.filter(m => m.toLowerCase().includes(query.toLowerCase())))
    }

    // 搜索 Session 记忆
    if (sessionId) {
      const sessionMemories = this.sessionMemory.get(sessionId) || []
      memories.push(...sessionMemories.filter(m => m.toLowerCase().includes(query.toLowerCase())))
    }

    if (memories.length === 0) return ''

    return memories.map(m => `[Memory] ${m}`).join('\n')
  }

  syncTurn(userContent, assistantContent, sessionId) {
    // 简单的记忆同步：提取关键信息
    const importantUserContent = this.extractImportantInfo(userContent)
    const importantAssistantContent = this.extractImportantInfo(assistantContent)

    if (importantUserContent) {
      this.addMemory(importantUserContent, sessionId)
    }

    if (importantAssistantContent) {
      this.addMemory(importantAssistantContent, sessionId)
    }
  }

  extractImportantInfo(content) {
    // 简单的启发式提取
    if (content.length > 10 && content.length < 500) {
      return content.trim()
    }
    return null
  }

  addMemory(content, sessionId) {
    if (!content) return

    // userId 从上下文获取，这里简化处理
    // 实际实现中应该从 MemoryContext 获取
  }

  onSessionEnd(messages) {
    // Session 结束时可以做总结
    console.log(`[BuiltinMemory] Session ended with ${messages?.length || 0} messages`)
  }

  getToolSchemas() {
    return [
      {
        name: 'memory_search',
        description: 'Search memories for relevant information',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'memory_save',
        description: 'Save important information to memory',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to remember' }
          },
          required: ['content']
        }
      }
    ]
  }
}

// 导出单例
export const memoryManager = new MemoryManager()

export default memoryManager
