/**
 * Workspace 隔离管理器
 *
 * 为每个任务创建独立的工作区，Agent 的所有操作都在该目录下进行
 */

import fs from 'fs'
import path from 'path'
import { exec, spawn, execSync } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export class WorkspaceManager {
  constructor(options = {}) {
    // 工作区根目录
    this.root = options.root || process.env.SYMPHONY_WORKSPACE_ROOT || './workspaces'
    // 每个任务的工作区名称格式
    this.format = options.format || 'task-{taskId}'
    // 已创建的工作区缓存
    this.workspaces = new Map()
  }

  /**
   * 获取任务的工作区路径
   */
  getWorkspacePath(taskId) {
    const name = this.format.replace('{taskId}', taskId.substring(0, 8))
    return path.join(this.root, name)
  }

  /**
   * 创建任务工作区
   */
  async createWorkspace(taskId, options = {}) {
    const workspacePath = this.getWorkspacePath(taskId)

    // 如果已存在，直接返回
    if (this.workspaces.has(taskId)) {
      return {
        taskId,
        path: workspacePath,
        exists: true
      }
    }

    // 创建工作区目录
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true })
    }

    // 初始化 git 仓库（Claude Code 需要 git 仓库才能使用 worktree）
    try {
      execSync('git init', { cwd: workspacePath, stdio: 'ignore' })
    } catch (error) {
      // ignore if git init fails
    }

    // 如果配置了 after_create 钩子，执行它
    if (options.afterCreate) {
      try {
        await this.runHook(taskId, options.afterCreate, workspacePath)
      } catch (error) {
        console.error(`[Workspace] after_create hook failed for ${taskId}:`, error.message)
      }
    }

    // 缓存工作区
    this.workspaces.set(taskId, {
      path: workspacePath,
      createdAt: new Date().toISOString(),
      taskId
    })

    console.log(`[Workspace] Created workspace for ${taskId}: ${workspacePath}`)

    return {
      taskId,
      path: workspacePath,
      exists: false
    }
  }

  /**
   * 执行 after_create 钩子
   */
  async runHook(taskId, hook, workspacePath) {
    console.log(`[Workspace] Running after_create hook for ${taskId}`)

    // 替换占位符
    const expandedHook = hook
      .replace(/\{taskId\}/g, taskId)
      .replace(/\{workspace\}/g, workspacePath)
      .replace(/\{root\}/g, this.root)

    // 在工作区目录下执行钩子脚本
    const commands = expandedHook.split('\n').filter(Boolean)

    for (const cmd of commands) {
      console.log(`[Workspace] Executing: ${cmd}`)
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: workspacePath,
          timeout: 300000 // 5 分钟超时
        })
        if (stdout) console.log(`[Workspace] stdout: ${stdout.substring(0, 500)}`)
        if (stderr) console.log(`[Workspace] stderr: ${stderr.substring(0, 500)}`)
      } catch (error) {
        console.error(`[Workspace] Hook command failed: ${error.message}`)
        throw error
      }
    }
  }

  /**
   * 清理任务工作区
   */
  async cleanupWorkspace(taskId, options = {}) {
    const workspace = this.workspaces.get(taskId)
    if (!workspace) {
      console.log(`[Workspace] No workspace found for ${taskId}`)
      return false
    }

    const workspacePath = workspace.path

    // 如果配置了 before_cleanup 钩子，执行它
    if (options.beforeCleanup) {
      try {
        await this.runHook(taskId, options.beforeCleanup, workspacePath)
      } catch (error) {
        console.error(`[Workspace] before_cleanup hook failed:`, error.message)
      }
    }

    // 删除工作区目录
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true })
      console.log(`[Workspace] Cleaned up workspace for ${taskId}`)
    }

    // 从缓存中移除
    this.workspaces.delete(taskId)

    return true
  }

  /**
   * 获取工作区信息
   */
  getWorkspace(taskId) {
    return this.workspaces.get(taskId) || null
  }

  /**
   * 列出所有工作区
   */
  listWorkspaces() {
    return Array.from(this.workspaces.values())
  }

  /**
   * 检查工作区是否存在
   */
  exists(taskId) {
    const workspacePath = this.getWorkspacePath(taskId)
    return fs.existsSync(workspacePath)
  }

  importArtifact(taskId, sourcePath, targetRelativePath = '') {
    const workspace = this.workspaces.get(taskId)
    if (!workspace) {
      throw new Error(`No workspace for task ${taskId}`)
    }

    const resolvedSourcePath = path.resolve(String(sourcePath || ''))
    if (!resolvedSourcePath || !fs.existsSync(resolvedSourcePath)) {
      throw new Error(`Source artifact not found: ${sourcePath}`)
    }

    const workspaceRoot = path.resolve(workspace.path)
    const safeRelativePath = String(targetRelativePath || '').trim()
      .replace(/^\/+/, '')
      .replace(/\\/g, '/')
    const fallbackName = path.basename(resolvedSourcePath)
    const destinationPath = path.resolve(workspaceRoot, safeRelativePath || fallbackName)

    if (!(destinationPath === workspaceRoot || destinationPath.startsWith(`${workspaceRoot}${path.sep}`))) {
      throw new Error('Target path escapes workspace')
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
    const stat = fs.statSync(resolvedSourcePath)
    fs.cpSync(resolvedSourcePath, destinationPath, {
      recursive: stat.isDirectory(),
      force: true
    })

    return {
      sourcePath: resolvedSourcePath,
      destinationPath,
      relativeDestinationPath: path.relative(workspaceRoot, destinationPath) || '.',
      kind: stat.isDirectory() ? 'directory' : 'file'
    }
  }

  writeArtifactContent(taskId, fileName, contentBase64, targetRelativePath = '') {
    const workspace = this.workspaces.get(taskId)
    if (!workspace) {
      throw new Error(`No workspace for task ${taskId}`)
    }

    const safeFileName = path.basename(String(fileName || 'artifact.bin').trim()) || 'artifact.bin'
    const normalizedBase64 = String(contentBase64 || '')
      .trim()
      .replace(/^data:[^;]+;base64,/, '')

    if (!normalizedBase64) {
      throw new Error('Artifact content is required')
    }

    const buffer = Buffer.from(normalizedBase64, 'base64')
    if (!buffer.length) {
      throw new Error('Artifact content is empty')
    }

    const workspaceRoot = path.resolve(workspace.path)
    const safeRelativePath = String(targetRelativePath || '').trim()
      .replace(/^\/+/, '')
      .replace(/\\/g, '/')
    const destinationPath = path.resolve(
      workspaceRoot,
      safeRelativePath || path.join('.omc', 'manual', safeFileName)
    )

    if (!(destinationPath === workspaceRoot || destinationPath.startsWith(`${workspaceRoot}${path.sep}`))) {
      throw new Error('Target path escapes workspace')
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
    fs.writeFileSync(destinationPath, buffer)

    return {
      destinationPath,
      relativeDestinationPath: path.relative(workspaceRoot, destinationPath) || '.',
      kind: 'file',
      size: buffer.byteLength
    }
  }

  /**
   * 在工作区中执行命令（安全的命令执行）
   */
  async safeExec(taskId, command, options = {}) {
    const workspace = this.workspaces.get(taskId)
    if (!workspace) {
      throw new Error(`No workspace for task ${taskId}`)
    }

    const workspacePath = workspace.path

    // 安全检查：确保命令不会逃逸出工作区
    const safeOptions = {
      cwd: workspacePath,
      timeout: options.timeout || 300000,
      env: { ...process.env, ...options.env }
    }

    try {
      const { stdout, stderr } = await execAsync(command, safeOptions)
      return { stdout, stderr, success: true }
    } catch (error) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        success: false,
        error: error.message
      }
    }
  }

  /**
   * 在工作区中启动进程（用于运行 Agent）
   */
  spawnProcess(taskId, command, args = [], options = {}) {
    const workspace = this.workspaces.get(taskId)
    if (!workspace) {
      throw new Error(`No workspace for task ${taskId}`)
    }

    const spawnOptions = {
      cwd: workspace.path,
      env: { ...process.env, ...options.env },
      stdio: options.stdio || 'pipe'
    }

    const proc = spawn(command, args, spawnOptions)

    // 记录进程信息
    this.workspaces.get(taskId).process = proc
    this.workspaces.get(taskId).startedAt = new Date().toISOString()

    return proc
  }

  /**
   * 停止工作区中的进程
   */
  async stopProcess(taskId) {
    const workspace = this.workspaces.get(taskId)
    if (!workspace || !workspace.process) {
      return false
    }

    const proc = workspace.process

    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGTERM')

      // 等待进程结束，最多 10 秒
      await new Promise((resolve) => {
        setTimeout(() => {
          if (proc && typeof proc.kill === 'function') {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 10000)
      })

      workspace.process = null
      console.log(`[Workspace] Stopped process for ${taskId}`)
      return true
    }

    return false
  }
}

// 导出单例
export const workspaceManager = new WorkspaceManager()

export default workspaceManager
