/**
 * Memory 管理模块
 *
 * 基于 Hermes Agent 的 Memory 系统，支持多 Provider
 */

import { MemoryManager, BuiltinMemoryProvider } from './memoryManager.js'

// 创建 MemoryManager 实例
const memoryManager = new MemoryManager({
  memoryDir: './memory'
})

// 已初始化的 Provider
const providers = new Map()

/**
 * 初始化 Memory 系统
 */
export function initMemory() {
  // 添加内置 Provider
  const builtinProvider = new BuiltinMemoryProvider('./memory')
  memoryManager.addProvider(builtinProvider)
  providers.set('builtin', builtinProvider)

  console.log('[Memory] Initialized with builtin provider')
}

/**
 * 设置当前上下文
 */
export function setContext(userId, sessionId) {
  memoryManager.setContext(userId, sessionId)
}

/**
 * 构建系统提示词
 */
export function buildSystemPrompt() {
  return memoryManager.buildSystemPrompt()
}

/**
 * 预取记忆
 */
export function prefetch(query) {
  return memoryManager.prefetch(query)
}

/**
 * 同步 Turn
 */
export function syncTurn(userContent, assistantContent) {
  memoryManager.syncTurn(userContent, assistantContent)
}

/**
 * Session 结束
 */
export function onSessionEnd(messages) {
  memoryManager.onSessionEnd(messages)
}

/**
 * 获取所有工具 schemas
 */
export function getAllToolSchemas() {
  return memoryManager.getAllToolSchemas()
}

/**
 * 获取所有工具名称
 */
export function getAllToolNames() {
  return memoryManager.getAllToolNames()
}

/**
 * 检查是否有特定工具
 */
export function hasTool(toolName) {
  return memoryManager.hasTool(toolName)
}

/**
 * 处理工具调用
 */
export function handleToolCall(toolName, args) {
  return memoryManager.handleToolCall(toolName, args)
}

/**
 * 获取所有 Provider
 */
export function getProviders() {
  return memoryManager.getProviders()
}

/**
 * 按名称获取 Provider
 */
export function getProvider(name) {
  return memoryManager.getProvider(name)
}

export default {
  initMemory,
  setContext,
  buildSystemPrompt,
  prefetch,
  syncTurn,
  onSessionEnd,
  getAllToolSchemas,
  getAllToolNames,
  hasTool,
  handleToolCall,
  getProviders,
  getProvider,
  memoryManager
}
